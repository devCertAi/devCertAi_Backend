const rateLimit = require('express-rate-limit')

const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many requests, please try again later.' },
  // Exam traffic gets its own, more generous limiter (see examLimiter below) —
  // a single long exam session's heartbeats/autosaves would otherwise eat
  // this whole 15-minute budget by itself and 429 every other route too.
  skip: (req) => req.originalUrl.startsWith('/api/exam'),
})

const authLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many auth attempts, please wait.' }
})

const evalLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many evaluation requests, please wait.' }
})

// Exam sessions are long-lived (up to ~70 min) and chatty by design: a 30s
// heartbeat, an autosave on every answer change, periodic result-polling,
// etc. The old approach — routing exam traffic through the same 100-req/
// 15-min globalLimiter as everything else — meant a single in-progress exam
// could exhaust the whole budget on its own, causing the answer-save and
// submit calls to start 429ing mid-exam (with submit's client-side retry
// loop then hammering the same limit every 3s). This limiter is scoped to
// /api/exam only and sized for a realistic worst case: 30s heartbeat (~140
// calls/70min) + frequent answer saves + polling, with headroom.
const examLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many requests, please slow down a moment.' }
})

module.exports = { globalLimiter, authLimiter, evalLimiter, examLimiter }
