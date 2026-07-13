/**
 * retry.js — small retry helper for critical, non-idempotent-risk operations
 * (certificate generation, email sending).
 *
 * Why this exists: when Redis is down (or never configured), queues/index.js
 * falls back to running jobs inline via `setImmediate` — see createResilientQueue().
 * That inline path does NOT get Bull's built-in retry/backoff (`defaultOpts.attempts`
 * only applies to the real Bull-backed queue). A single transient error — a Gmail
 * timeout, a slow Cloudinary upload — would previously fail the job once, log an
 * error, and never try again. This wraps just the risky external calls so they get
 * a few attempts even when running inline.
 */
async function withRetry(fn, { attempts = 3, delayMs = 1500, label = 'operation' } = {}) {
  let lastErr
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn()
    } catch (err) {
      lastErr = err
      if (i < attempts) {
        console.warn(`[Retry] ${label} failed (attempt ${i}/${attempts}): ${err.message}. Retrying...`)
        await new Promise((resolve) => setTimeout(resolve, delayMs * i))
      }
    }
  }
  console.error(`[Retry] ${label} failed after ${attempts} attempts: ${lastErr.message}`)
  throw lastErr
}

module.exports = { withRetry }
