/**
 * queues/index.js — Redis-optional job queues
 *
 * Design goal: every feature that uses a queue (exam grading, project
 * evaluation, certificates, emails, skill matching, application pipeline)
 * must keep working correctly with Redis completely absent — Postgres is
 * the only hard dependency. Redis/Bull is a pure performance optimisation
 * (off-process workers, retries, backoff) layered on top.
 *
 * How it works:
 *  - Each queue is a single, stable object created ONCE at module load.
 *    Consumers can safely destructure it (`const { examGradingQueue } =
 *    require('../queues')`) because the object reference never changes —
 *    there is no async "stub → real queue" swap to race against.
 *  - `.process(fn)` registers the job handler both with the in-process
 *    fallback AND with the underlying Bull queue (if Redis is up).
 *  - `.add(data, opts)` tries the real Bull queue first (bounded by a short
 *    timeout so a wedged Redis connection can't hang a request). If that
 *    fails for any reason — Redis down, quota exceeded, timeout — the job
 *    runs immediately in-process via the same handler, so the feature still
 *    completes using only the database.
 *  - Once Redis fails, we stop trying it for a cooldown window (avoids
 *    adding request latency / hammering a quota-exceeded Redis on every
 *    call) and automatically re-probes it afterwards.
 */

const { isRedisUp, getRedis, createManagedClient } = require('../config/redis')

let Bull
try {
  Bull = require('bull')
} catch {
  Bull = null
}

const ADD_TIMEOUT_MS = 2500
const PROBE_COOLDOWN_MS = 30_000

// ── Redis connection factory for Bull ───────────────────────────────────────
// Bull needs up to 3 separate ioredis connections per queue (client,
// subscriber, bclient). Handing Bull a plain `{ redis: {...} }` config lets
// Bull construct those connections ITSELF, with no 'error' listener attached
// until after Bull's own setup runs — so a connection failure in that window
// (e.g. local Redis not running, or the socket closing mid-command) throws
// as a process-level uncaught exception instead of a handled 'error' event.
// That is what was crashing the server.
//
// `createClient` lets us build every one of those connections ourselves,
// using the exact same createManagedClient() used everywhere else — which
// attaches its listeners BEFORE connecting, so failures are always handled,
// never thrown.
function createClient(type) {
  return createManagedClient(`bull:${type}`)
}

// ── Resilient queue wrapper ──────────────────────────────────────────────────
// One of these is created per queue name, synchronously, at module load.
// It owns an optional underlying Bull instance and always falls back to
// running the job handler inline when Bull can't take the job.
function createResilientQueue(name) {
  let bull = null
  let handler = null
  let concurrency = undefined
  const pending = [] // jobs added before a handler was registered
  let bullDown = false
  let nextProbeAt = 0
  let warnedDown = false

  if (Bull) {
    try {
      bull = new Bull(name, { createClient })

      bull.on('error', (err) => {
        const isQuota = err?.message?.includes('max requests limit exceeded')
        if (!warnedDown) {
          console.warn(
            isQuota
              ? `[Queue:${name}] Upstash quota exceeded — running jobs inline until it recovers`
              : `[Queue:${name}] Redis error (${err.message}) — running jobs inline until it recovers`
          )
          warnedDown = true
        }
        bullDown = true
        nextProbeAt = Date.now() + PROBE_COOLDOWN_MS
      })

      bull.on('ready', () => {
        if (bullDown || warnedDown) {
          console.log(`[Queue:${name}] Redis connection (re)established`)
        }
        bullDown = false
        warnedDown = false
      })
    } catch (err) {
      console.warn(`[Queue:${name}] Failed to initialise Bull — running inline only:`, err.message)
      bull = null
    }
  }

  function runInline(data) {
    const job = { id: `inline-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, name, data }
    if (!handler) {
      // Handler not registered yet (worker module hasn't finished requiring).
      // Buffer briefly — server.js requires all workers synchronously at
      // boot, well before any request can reach here in practice.
      pending.push(job)
      console.warn(`[Queue:${name}] No processor registered yet — job buffered`)
      return job
    }
    setImmediate(() => {
      Promise.resolve(handler(job)).catch((err) => {
        console.error(`[Queue:${name}] Inline job failed:`, err.message, err.stack)
      })
    })
    return job
  }

  function drainPending() {
    if (!handler || pending.length === 0) return
    const jobs = pending.splice(0)
    for (const job of jobs) {
      setImmediate(() => {
        Promise.resolve(handler(job)).catch((err) => {
          console.error(`[Queue:${name}] Buffered job failed:`, err.message, err.stack)
        })
      })
    }
  }

  return {
    name,
    _isResilientQueue: true,

    async add(data, opts) {
      const shouldTryBull = bull && (!bullDown || Date.now() > nextProbeAt)

      if (shouldTryBull) {
        try {
          const job = await Promise.race([
            bull.add(data, opts),
            new Promise((_, reject) =>
              setTimeout(() => reject(new Error('Redis add() timed out')), ADD_TIMEOUT_MS)
            ),
          ])
          bullDown = false
          warnedDown = false
          return job
        } catch (err) {
          if (!warnedDown) {
            console.warn(`[Queue:${name}] Redis add() failed (${err.message}) — running inline`)
            warnedDown = true
          }
          bullDown = true
          nextProbeAt = Date.now() + PROBE_COOLDOWN_MS
        }
      }

      return runInline(data)
    },

    process(concurrencyOrFn, maybeFn) {
      if (typeof concurrencyOrFn === 'function') {
        handler = concurrencyOrFn
      } else {
        concurrency = concurrencyOrFn
        handler = maybeFn
      }

      if (bull) {
        // Real Bull processing keeps working whenever Redis is actually up —
        // this is purely an optimisation on top of the inline fallback above.
        try {
          if (concurrency) bull.process(concurrency, handler)
          else bull.process(handler)
        } catch (err) {
          console.warn(`[Queue:${name}] Failed to register Bull processor:`, err.message)
        }
      }

      drainPending()
    },

    on(event, fn) {
      return bull ? bull.on(event, fn) : undefined
    },
    async close() {
      return bull ? bull.close() : undefined
    },
    async obliterate(opts) {
      return bull ? bull.obliterate(opts) : undefined
    },
    async getWaitingCount() {
      try { return bull ? await bull.getWaitingCount() : 0 } catch { return 0 }
    },
    async getActiveCount() {
      try { return bull ? await bull.getActiveCount() : 0 } catch { return 0 }
    },
    async getCompletedCount() {
      try { return bull ? await bull.getCompletedCount() : 0 } catch { return 0 }
    },
    async getFailedCount() {
      try { return bull ? await bull.getFailedCount() : 0 } catch { return 0 }
    },
    isRedisBacked() {
      return !!bull && !bullDown
    },
  }
}

// ── Defaults ─────────────────────────────────────────────────────────────────
const defaultOpts = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 2000 },
  timeout: 300_000,
  removeOnComplete: 100,
  removeOnFail: 50,
}

// ── Queue instances — created once, stable references, never swapped ────────
const projectEvalQueue    = createResilientQueue('project-evaluation')
const examGradingQueue    = createResilientQueue('exam-grading')
const certificateGenQueue = createResilientQueue('certificate-generation')
const emailQueue          = createResilientQueue('email')
const applicationQueue    = createResilientQueue('application-pipeline')
const matchQueue          = createResilientQueue('skill-match')

const ALL_QUEUES = [
  projectEvalQueue, examGradingQueue, certificateGenQueue,
  emailQueue, applicationQueue, matchQueue,
]

// Trigger lazy Redis connect (used elsewhere for caching, unrelated to Bull)
getRedis()

// True if at least one queue currently has a healthy Redis-backed Bull
// connection. Informational only — every feature works regardless, this is
// just useful for admin/monitoring dashboards.
const isQueueAvailable = () => ALL_QUEUES.some((q) => q.isRedisBacked())

// Resolves on the next tick. Kept for compatibility with workers that do
// `queuesReadyPromise.then(() => queue.process(...))` — queues are ready
// synchronously now, so this just defers registration by a tick, which is
// still well before the HTTP server starts accepting requests.
const queuesReadyPromise = Promise.resolve()

module.exports = {
  projectEvalQueue,
  examGradingQueue,
  certificateGenQueue,
  emailQueue,
  applicationQueue,
  matchQueue,
  defaultOpts,
  isQueueAvailable,
  queuesReadyPromise,
}
