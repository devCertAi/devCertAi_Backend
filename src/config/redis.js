/**
 * config/redis.js — Resilient Redis wrapper
 *
 * Handles ANY Redis failure (quota exceeded, connection refused, connection
 * dropped, local Redis not running, etc.) without ever crashing the process:
 *  - retryStrategy backs off and retries transient failures, but gives up
 *    permanently (and fast) once we've confirmed it's a quota error
 *  - 'error' event is attached synchronously before .connect() is called,
 *    on every client we create — including the ones handed to Bull
 *  - process-level uncaughtException / unhandledRejection guards catch the
 *    rare case where ioredis throws before an instance's own listener can
 *    intercept it (this is NOT quota-specific — any ioredis internal error,
 *    e.g. "Connection is closed.", can surface this way when a socket is
 *    torn down mid-command). We NEVER process.exit() for a Redis-originated
 *    error — Redis is optional everywhere in this app by design.
 *  - safeRedis proxy: every Redis command returns null instead of throwing
 *    when Redis is unavailable — callers fall through to DB automatically
 */

const Redis = require('ioredis')

let redis = null
let redisAvailable = false
let quotaExceeded = false // distinct from redisAvailable — only true once we've SEEN a quota error

// ── Helper: is this an ioredis-originated error? ─────────────────────────────
// Broad by design. We'd rather swallow a rare non-Redis error that happens to
// look like this than crash the whole server for something that was always
// meant to be optional. Anything ioredis-shaped gets treated as "mark Redis
// down, keep the app running" instead of a fatal exception.
function looksLikeRedisError(err) {
  if (!err) return false
  const msg = err.message || ''
  const stackHasIoredis = typeof err.stack === 'string' && err.stack.includes('ioredis')
  return (
    stackHasIoredis ||
    err.name === 'ReplyError' ||
    err.name === 'MaxRetriesPerRequestError' ||
    msg.includes('max requests limit exceeded') ||
    msg.includes('Connection is closed') ||
    msg.includes('ECONNREFUSED') ||
    msg.includes('ETIMEDOUT') ||
    msg.includes('ECONNRESET') ||
    msg.includes('Redis connection')
  )
}

function markQuotaExceeded(reason) {
  quotaExceeded = true
  redisAvailable = false
  console.warn(`⚠️  Redis quota exceeded (${reason}) — server continues without Redis cache`)
}

function markDown(reason) {
  if (redisAvailable) console.warn(`⚠️  Redis unavailable (${reason}) — falling back to DB`)
  redisAvailable = false
}

// ── Process-level safety net ─────────────────────────────────────────────────
// ioredis can throw an uncaught error before an instance's own 'error'
// listener can intercept it — during the AUTH handshake (quota rejection),
// or when a socket closes with a command still in flight ("Connection is
// closed."), which is the ordinary, expected thing that happens when a local
// Redis server isn't running or gets restarted. Neither case should ever
// take the whole app down.
process.on('uncaughtException', (err) => {
  if (looksLikeRedisError(err)) {
    if (err.message?.includes('max requests limit exceeded')) markQuotaExceeded('uncaughtException')
    else markDown(err.message)
    return // swallow — do not re-throw, do not exit
  }

  // Not a Redis error — genuinely fatal, preserve original crash behaviour
  console.error('[uncaughtException]', err)
  process.exit(1)
})

// Same category of error can also arrive as an unhandled promise rejection
// depending on ioredis version / code path — cover both.
process.on('unhandledRejection', (err) => {
  if (looksLikeRedisError(err)) {
    markDown(err?.message)
    return
  }
  console.error('[unhandledRejection]', err)
})

// ── Shared connection options ─────────────────────────────────────────────────
function sharedOpts() {
  return {
    maxRetriesPerRequest: 1,
    enableReadyCheck: false,   // skip the PING after auth — saves one request
    lazyConnect: true,
    retryStrategy(times) {
      // Once we've confirmed quota is the problem, stop immediately —
      // retrying just burns more quota for no benefit.
      if (quotaExceeded) return null
      // Otherwise this is an ordinary transient failure (local Redis not
      // started yet, brief network blip, dev server restart) — back off
      // and keep trying instead of giving up on the very first attempt.
      if (times > 10) return null
      return Math.min(times * 500, 10_000)
    },
    reconnectOnError(err) {
      // Reconnect for READONLY (Upstash failover) or ordinary connection
      // resets; never for confirmed quota errors.
      if (quotaExceeded) return false
      if (err?.message?.includes('READONLY')) return true
      if (err?.message?.includes('ECONNRESET')) return true
      return false
    },
  }
}

function connectionConfig() {
  const url = process.env.REDIS_URL
  if (!url || url.includes('localhost') || url.includes('127.0.0.1')) {
    return { host: '127.0.0.1', port: 6379, ...sharedOpts() }
  }
  const parsed = new URL(url)
  return {
    host: parsed.hostname,
    port: parseInt(parsed.port) || 6379,
    password: parsed.password || undefined,
    username: parsed.username || 'default',
    tls: parsed.protocol === 'rediss:' ? { rejectUnauthorized: false } : undefined,
    ...sharedOpts(),
  }
}

// ── Attach lifecycle listeners ───────────────────────────────────────────────
// Exported (see createManagedClient below) so ANY ioredis client this app
// creates — including the ones handed to Bull for its queues — gets the
// exact same "never let this crash the process" treatment. This is the
// piece that was missing for Bull's own connections.
function attachListeners(client, label = 'redis') {
  // 'error' must be attached before .connect() so it catches auth/quota errors
  client.on('error', (err) => {
    const isQuota = err?.message?.includes('max requests limit exceeded')
    if (isQuota) {
      markQuotaExceeded(label)
      try { client.disconnect() } catch {}
      return
    }
    markDown(`${label}: ${err.message}`)
  })

  client.on('connect', () => {
    redisAvailable = true
    console.log(`✅ Redis connected (${label})`)
  })

  client.on('ready', () => {
    redisAvailable = true
    console.log(`✅ Redis ready (${label})`)
  })

  client.on('close', () => markDown(`${label} closed`))
  client.on('end', () => { redisAvailable = false })
  client.on('reconnecting', () => console.log(`🔄 Redis reconnecting… (${label})`))
}

// ── createManagedClient: for anything (including Bull) that needs its own
// raw ioredis instance but should still get crash-proof handling ───────────
function createManagedClient(label = 'redis') {
  const client = new Redis(connectionConfig())
  attachListeners(client, label) // attach BEFORE any connect happens
  return client
}

// ── getRedis: the app's single shared client (caching, safeRedis) ───────────
function getRedis() {
  if (!redis) {
    redis = createManagedClient('shared')
    redis.connect().catch(() => {}) // errors handled by 'error' event above
  }
  return redis
}

// ── isRedisUp ────────────────────────────────────────────────────────────────
function isRedisUp() {
  return redisAvailable
}

// ── safeRedis proxy ──────────────────────────────────────────────────────────
// Drop-in replacement for getRedis() at call sites.
// Every supported command returns null instead of throwing when Redis is down.
//
//   const val = await safeRedis.get('key')           // null on miss or down
//   await safeRedis.set('key', 'val', 'EX', 300)     // null (skipped) when down
//   await safeRedis.del('key')                        // null when down
//
const SAFE_COMMANDS = new Set([
  'get', 'set', 'del', 'exists', 'expire', 'ttl', 'pttl', 'persist',
  'zadd', 'zrange', 'zrangebyscore', 'zrem', 'zcard', 'zrangebyscore',
  'hget', 'hset', 'hdel', 'hgetall', 'hmset', 'hmget',
  'incr', 'decr', 'incrby', 'decrby',
  'lpush', 'rpush', 'lrange', 'llen', 'lrem',
  'sadd', 'smembers', 'srem', 'sismember', 'scard',
  'keys', 'scan',
  'setex', 'setnx', 'getset',
  'mget', 'mset',
])

const safeRedis = new Proxy({}, {
  get(_, command) {
    if (!SAFE_COMMANDS.has(command)) return undefined

    return async (...args) => {
      // Skip immediately if we already know Redis is down
      if (!redisAvailable) return null

      try {
        return await getRedis()[command](...args)
      } catch (err) {
        redisAvailable = false
        console.warn(`[safeRedis.${command}] Redis error — DB fallback active:`, err.message)
        return null
      }
    }
  },
})

module.exports = { getRedis, safeRedis, isRedisUp, createManagedClient, connectionConfig }