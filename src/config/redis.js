/**
 * config/redis.js — Resilient Redis wrapper
 *
 * Handles Upstash quota errors (and any Redis failure) without crashing:
 *  - retryStrategy returns null immediately on quota errors → no reconnect loop
 *  - 'error' event is attached synchronously before .connect() is called
 *  - process-level uncaughtException guard catches the rare auth-phase crash
 *    that ioredis emits before event listeners can intercept it
 *  - safeRedis proxy: every Redis command returns null instead of throwing
 *    when Redis is unavailable — callers fall through to DB automatically
 */

const Redis = require('ioredis')

let redis = null
let redisAvailable = false

// ── Process-level safety net ─────────────────────────────────────────────────
// ioredis can throw an uncaught ReplyError during the AUTH handshake
// (before the instance's 'error' event listener fires) when Upstash
// rejects the connection due to quota. We catch it here so the server
// never crashes — just marks Redis as unavailable.
const _originalUncaught = process.listeners('uncaughtException').slice()

process.on('uncaughtException', (err) => {
  const isRedisQuota =
    err?.message?.includes('max requests limit exceeded') ||
    (err?.name === 'ReplyError' && err?.command?.name === 'auth')

  if (isRedisQuota) {
    redisAvailable = false
    console.warn('⚠️  Redis quota exceeded (auth phase) — server continues without Redis cache')
    return // swallow — do not re-throw
  }

  // Not a Redis error — re-emit so other handlers / default behaviour runs
  console.error('[uncaughtException]', err)
  process.exit(1)
})

// ── Build ioredis client ─────────────────────────────────────────────────────
function buildClient() {
  const url = process.env.REDIS_URL

  const sharedOpts = {
    maxRetriesPerRequest: 1,
    enableReadyCheck: false,   // skip the PING after auth — saves one request
    lazyConnect: true,
    retryStrategy(times) {
      // Never retry if quota is exceeded — it will keep failing and burning requests
      if (!redisAvailable && times > 0) return null
      // Otherwise back off up to 10 s, max 5 attempts
      if (times > 5) return null
      return Math.min(times * 1000, 10_000)
    },
    reconnectOnError(err) {
      // Only reconnect for READONLY (Upstash failover), never for quota errors
      if (err?.message?.includes('READONLY')) return true
      return false
    },
  }

  if (!url || url.includes('localhost') || url.includes('127.0.0.1')) {
    return new Redis({ host: '127.0.0.1', port: 6379, ...sharedOpts })
  }

  const parsed = new URL(url)
  return new Redis({
    host: parsed.hostname,
    port: parseInt(parsed.port) || 6379,
    password: parsed.password || undefined,
    username: parsed.username || 'default',
    tls: parsed.protocol === 'rediss:' ? { rejectUnauthorized: false } : undefined,
    ...sharedOpts,
  })
}

// ── Attach lifecycle listeners ───────────────────────────────────────────────
function attachListeners(client) {
  // 'error' must be attached before .connect() so it catches auth errors
  client.on('error', (err) => {
    const isQuota = err?.message?.includes('max requests limit exceeded')
    const isAuthQuota = err?.command?.name === 'auth' && isQuota

    if (isQuota || isAuthQuota) {
      if (redisAvailable) console.warn('⚠️  Redis quota exceeded — falling back to DB for all cache ops')
      redisAvailable = false

      // Stop ioredis from hammering Upstash with reconnect attempts
      try { client.disconnect() } catch {}
      return
    }

    if (redisAvailable) console.warn('⚠️  Redis unavailable — falling back to DB:', err.message)
    redisAvailable = false
  })

  client.on('connect', () => {
    redisAvailable = true
    console.log('✅ Redis connected')
  })

  client.on('ready', () => {
    redisAvailable = true
    console.log('✅ Redis ready')
  })

  client.on('close', () => {
    if (redisAvailable) console.warn('⚠️  Redis connection closed — falling back to DB')
    redisAvailable = false
  })

  client.on('end', () => {
    redisAvailable = false
  })

  client.on('reconnecting', () => {
    console.log('🔄 Redis reconnecting…')
  })
}

// ── getRedis: raw ioredis client (needed by Bull internally) ─────────────────
function getRedis() {
  if (!redis) {
    redis = buildClient()
    attachListeners(redis)         // attach BEFORE connect
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

module.exports = { getRedis, safeRedis, isRedisUp }