const jwt    = require('jsonwebtoken')
const crypto = require('crypto')
const prisma  = require('../config/database')

// ─── Constants ────────────────────────────────────────────────────────────────
const ACCESS_SECRET  = process.env.JWT_SECRET
const REFRESH_SECRET = process.env.JWT_REFRESH_SECRET

// Access token: 15 minutes (unchanged)
// Refresh token: 7 days, stored in DB for revocation support
const REFRESH_TTL_MS = 7 * 24 * 60 * 60 * 1000   // 7 days in ms
const REFRESH_TTL_S  = REFRESH_TTL_MS / 1000

// ─── JWT sign helpers ─────────────────────────────────────────────────────────

const signAccessToken = (userId) =>
  jwt.sign({ userId, role: 'user' }, ACCESS_SECRET, { expiresIn: '15m' })

const signRefreshToken = (userId) =>
  jwt.sign({ userId, role: 'user' }, REFRESH_SECRET, { expiresIn: '7d' })

const signRecruiterAccessToken = (recruiterId) =>
  jwt.sign({ recruiterId, role: 'recruiter' }, ACCESS_SECRET, { expiresIn: '15m' })

const signRecruiterRefreshToken = (recruiterId) =>
  jwt.sign({ recruiterId, role: 'recruiter' }, REFRESH_SECRET, { expiresIn: '7d' })

// ─── Verify helpers ───────────────────────────────────────────────────────────

const verifyAccessToken  = (token) => jwt.verify(token, ACCESS_SECRET)
const verifyRefreshToken = (token) => jwt.verify(token, REFRESH_SECRET)
 

function detectCrossSite() {
  const explicit = process.env.COOKIE_CROSS_SITE
  if (explicit === 'true') return true
  if (explicit === 'false') return false

  const frontend = (process.env.FRONTEND_URL || '').replace(/\/+$/, '')
  const backend  = (process.env.BACKEND_URL || '').replace(/\/+$/, '')

  if (frontend && backend) {
    try {
      return new URL(frontend).hostname !== new URL(backend).hostname
    } catch {}
  }

  return process.env.NODE_ENV === 'production'
}

const isCrossSite = detectCrossSite()

const COOKIE_BASE = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production' || isCrossSite,
  sameSite: isCrossSite ? 'none' : 'lax',
  path: '/',
}

const setRefreshCookie = (res, token) =>
  res.cookie('refreshToken', token, { ...COOKIE_BASE, maxAge: REFRESH_TTL_MS })

const setRecruiterRefreshCookie = (res, token) =>
  res.cookie('recruiterRefreshToken', token, { ...COOKIE_BASE, maxAge: REFRESH_TTL_MS })

// Exported so every clearCookie() call site (logout, delete-account, etc.)
// uses the EXACT same attributes the cookie was set with. Passing mismatched
// options to res.clearCookie() means some browsers silently keep the old
// cookie alive after "logout".
const CLEAR_COOKIE_OPTS = { ...COOKIE_BASE }

// ─── DB-backed refresh token store ───────────────────────────────────────────
// We store a SHA-256 hash of the raw JWT in the DB.
// The raw token lives only in the httpOnly cookie — never logged or exposed.

function hashToken(rawToken) {
  return crypto.createHash('sha256').update(rawToken).digest('hex')
}

/**
 * Store a new refresh token in the DB.
 * Call this every time a new refresh token is issued (login, register, google).
 *
 * @param {string} rawToken  — the raw JWT (will be hashed before storing)
 * @param {object} opts      — { userId?, recruiterId?, userAgent?, ip? }
 */
async function storeRefreshToken(rawToken, { userId, recruiterId, userAgent, ip } = {}) {
  const hash      = hashToken(rawToken)
  const expiresAt = new Date(Date.now() + REFRESH_TTL_MS)

  await prisma.refreshToken.upsert({
    where:  { token: hash },
    update: { revokedAt: null, expiresAt, userAgent, ip },
    create: { token: hash, userId, recruiterId, expiresAt, userAgent, ip },
  })
}

/**
 * Validate a refresh token against the DB.
 *
 * Returns the DB record if valid, throws if:
 *  - token not found (never issued or already deleted)
 *  - token revoked (logout / rotation)
 *  - token expired in DB (belt-and-suspenders on top of JWT expiry)
 *
 * @param {string} rawToken
 * @returns {Promise<object>} prisma RefreshToken record
 */
async function validateStoredRefreshToken(rawToken) {
  const hash   = hashToken(rawToken)
  const record = await prisma.refreshToken.findUnique({ where: { token: hash } })

  if (!record)              throw new Error('REFRESH_TOKEN_NOT_FOUND')
  if (record.revokedAt)     throw new Error('REFRESH_TOKEN_REVOKED')
  if (record.expiresAt < new Date()) {
    // Clean up expired record
    await prisma.refreshToken.delete({ where: { token: hash } }).catch(() => {})
    throw new Error('REFRESH_TOKEN_EXPIRED')
  }

  return record
}

/**
 * Revoke a specific refresh token (on logout / rotation).
 *
 * @param {string} rawToken
 */
async function revokeRefreshToken(rawToken) {
  const hash = hashToken(rawToken)
  await prisma.refreshToken.updateMany({
    where:  { token: hash, revokedAt: null },
    data:   { revokedAt: new Date() },
  }).catch(() => {})   // ignore if already deleted
}

/**
 * Revoke ALL refresh tokens for a user (logout-all-devices, password change).
 *
 * @param {object} opts — { userId? } or { recruiterId? }
 */
async function revokeAllRefreshTokens({ userId, recruiterId }) {
  await prisma.refreshToken.updateMany({
    where:  { ...(userId ? { userId } : { recruiterId }), revokedAt: null },
    data:   { revokedAt: new Date() },
  })
}

/**
 * Cleanup job — delete expired/revoked tokens older than 30 days.
 * Call from a cron job or queue worker.
 */
async function pruneExpiredTokens() {
  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
  const { count } = await prisma.refreshToken.deleteMany({
    where: {
      OR: [
        { expiresAt: { lt: new Date() } },
        { revokedAt: { lt: cutoff } },
      ]
    }
  })
  return count
}

module.exports = {
  // JWT sign
  signAccessToken,
  signRefreshToken,
  signRecruiterAccessToken,
  signRecruiterRefreshToken,
  // JWT verify
  verifyAccessToken,
  verifyRefreshToken,
  // Cookies
  setRefreshCookie,
  setRecruiterRefreshCookie,
  CLEAR_COOKIE_OPTS,
  // DB-backed token management
  storeRefreshToken,
  validateStoredRefreshToken,
  revokeRefreshToken,
  revokeAllRefreshTokens,
  pruneExpiredTokens,
  hashToken,
}