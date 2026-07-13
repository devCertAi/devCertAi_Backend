/**
 * controllers/recruiterAuthController.js
 * Uses safeRedis — OTP/pending ops silently fail when Redis is down.
 *
 * BUGS FIXED (refresh + logout):
 * 1. refreshToken: only checked JWT signature — no DB validation.
 *    Stolen refresh tokens worked forever until 7-day expiry. Now validates
 *    against DB and rotates on every use.
 * 2. logout: only cleared the cookie. Raw refresh token stayed valid.
 *    Now revokes the DB record so it can't be replayed after logout.
 */

const bcrypt = require('bcryptjs')
const prisma = require('../config/database')
const { ApiError } = require('../utils/ApiError')
const { ApiResponse } = require('../utils/ApiResponse')
const asyncHandler = require('../utils/asyncHandler')
const { safeRedis } = require('../config/redis')
const {
  verifyRefreshToken,
  signRecruiterAccessToken,
  signRecruiterRefreshToken,
  setRecruiterRefreshCookie,
  storeRefreshToken,
  validateStoredRefreshToken,
  revokeRefreshToken,
  revokeAllRefreshTokens,
  CLEAR_COOKIE_OPTS,
} = require('../utils/tokenUtils')
const emailService = require('../services/emailService')
const jwt = require('jsonwebtoken')

const OTP_TTL          = 60 * 10
const OTP_MAX_ATTEMPTS = 5
const PENDING_TTL      = 60 * 15

function generateOtp()              { return String(Math.floor(100000 + Math.random() * 900000)) }
function otpKey(purpose, email)     { return `recruiter:otp:${purpose}:${email}` }
function pendingKey(purpose, email) { return `recruiter:pending:${purpose}:${email}` }

// Local aliases so existing code below doesn't need changing
function signRecruiterToken(recruiterId)   { return signRecruiterAccessToken(recruiterId) }
function signRecruiterRefresh(recruiterId) { return signRecruiterRefreshToken(recruiterId) }
function setRecruiterCookie(res, token)    { return setRecruiterRefreshCookie(res, token) }

/** Issue recruiter tokens + store refresh token in DB */
async function issueRecruiterTokens(res, recruiterId, req) {
  const accessToken  = signRecruiterToken(recruiterId)
  const refreshToken = signRecruiterRefresh(recruiterId)

  await storeRefreshToken(refreshToken, {
    recruiterId,
    userAgent: req.headers['user-agent'],
    ip: req.ip,
  })

  setRecruiterCookie(res, refreshToken)
  return accessToken
}

// ── OTP helpers (unchanged) ───────────────────────────────────────────────────

async function storeOtp(purpose, email, otp) {
  const key      = otpKey(purpose, email)
  const value    = JSON.stringify({ otp, attempts: 0 })
  const expiresAt = new Date(Date.now() + OTP_TTL * 1000)

  const ok = await safeRedis.set(key, value, 'EX', OTP_TTL)
  if (ok) return

  await prisma.otpStore.upsert({
    where: { key }, update: { value, expiresAt }, create: { key, value, expiresAt },
  })
}

async function verifyOtp(purpose, email, inputOtp) {
  // Dev-only bypass: lets you skip real OTP delivery while testing locally.
  // Requires BOTH conditions so it can never accidentally go live:
  //   - NODE_ENV is not 'production'
  //   - DEV_OTP_BYPASS=true is explicitly set in your local .env
  // Enter "000000" as the OTP on the recruiter login/register screen to use it.
  if (
    process.env.NODE_ENV !== 'production' &&
    process.env.DEV_OTP_BYPASS === 'true' &&
    inputOtp === '000000'
  ) {
    console.warn(`[DEV_OTP_BYPASS] Skipped real OTP check for ${purpose}:${email}`)
    return
  }

  const key = otpKey(purpose, email)
  const raw = await safeRedis.get(key)

  let data, fromDb = false

  if (raw) {
    data = JSON.parse(raw)
  } else {
    const record = await prisma.otpStore.findUnique({ where: { key } })
    if (!record)                   throw new ApiError(400, 'OTP expired or not found. Please request a new one.')
    if (record.expiresAt < new Date()) {
      await prisma.otpStore.delete({ where: { key } })
      throw new ApiError(400, 'OTP expired. Please request a new one.')
    }
    data   = JSON.parse(record.value)
    fromDb = true
  }

  if (data.attempts >= OTP_MAX_ATTEMPTS) {
    fromDb ? await prisma.otpStore.delete({ where: { key } }) : await safeRedis.del(key)
    throw new ApiError(429, 'Too many incorrect attempts. Please request a new OTP.')
  }

  if (data.otp !== inputOtp) {
    data.attempts += 1
    fromDb
      ? await prisma.otpStore.update({ where: { key }, data: { value: JSON.stringify(data) } })
      : await safeRedis.set(key, JSON.stringify(data), 'EX', OTP_TTL)
    const left = OTP_MAX_ATTEMPTS - data.attempts
    throw new ApiError(400, `Incorrect OTP. ${left} attempt${left === 1 ? '' : 's'} remaining.`)
  }

  fromDb ? await prisma.otpStore.delete({ where: { key } }) : await safeRedis.del(key)
}

// ── Register ──────────────────────────────────────────────────────────────────

const registerSendOtp = asyncHandler(async (req, res) => {
  const { name, email, password, companyName, companyWebsite, industry } = req.body

  const existing = await prisma.recruiter.findUnique({ where: { email } })
  if (existing) throw new ApiError(409, 'Email already registered as a recruiter')

  const hashedPassword  = await bcrypt.hash(password, 12)
  const pendingData     = JSON.stringify({ name, email, hashedPassword, companyName, companyWebsite: companyWebsite || null, industry: industry || null })
  const pendingExpiry   = new Date(Date.now() + PENDING_TTL * 1000)
  const pKey            = pendingKey('register', email)

  const ok = await safeRedis.set(pKey, pendingData, 'EX', PENDING_TTL)
  if (!ok) {
    await prisma.otpStore.upsert({
      where: { key: pKey }, update: { value: pendingData, expiresAt: pendingExpiry },
      create: { key: pKey, value: pendingData, expiresAt: pendingExpiry },
    })
  }

  const otp = generateOtp()
  await storeOtp('register', email, otp)
  await emailService.sendRecruiterOtpEmail({ name, email }, otp, 'register')

  return res.json(new ApiResponse(200, { email }, 'OTP sent to your email. Expires in 10 minutes.'))
})

const registerVerifyOtp = asyncHandler(async (req, res) => {
  const { email, otp } = req.body

  await verifyOtp('register', email, otp)

  let raw = await safeRedis.get(pendingKey('register', email))
  if (!raw) {
    const record = await prisma.otpStore.findUnique({ where: { key: pendingKey('register', email) } })
    if (!record || record.expiresAt < new Date()) throw new ApiError(400, 'Registration session expired. Please start again.')
    raw = record.value
    await prisma.otpStore.delete({ where: { key: pendingKey('register', email) } })
  } else {
    await safeRedis.del(pendingKey('register', email))
  }

  const { name, hashedPassword, companyName, companyWebsite, industry } = JSON.parse(raw)
  const existingCheck = await prisma.recruiter.findUnique({ where: { email } })
  if (existingCheck) throw new ApiError(409, 'Email already registered')

  const recruiter = await prisma.$transaction(async (tx) => {
    const r = await tx.recruiter.create({ data: { name, email, password: hashedPassword, isEmailVerified: true } })
    await tx.company.create({ data: { recruiterId: r.id, name: companyName, website: companyWebsite || null, industry: industry || null, verificationStatus: 'unverified' } })
    return r
  })

  const accessToken = await issueRecruiterTokens(res, recruiter.id, req)

  return res.status(201).json(new ApiResponse(201, {
    accessToken,
    recruiter: { id: recruiter.id, name: recruiter.name, email: recruiter.email, role: 'recruiter' },
  }, 'Recruiter account created!'))
})

// ── Login ─────────────────────────────────────────────────────────────────────

const loginSendOtp = asyncHandler(async (req, res) => {
  const { email, password } = req.body
  const recruiter = await prisma.recruiter.findUnique({ where: { email } })
  if (!recruiter || !recruiter.password) throw new ApiError(401, 'Invalid email or password')

  const isMatch = await bcrypt.compare(password, recruiter.password)
  if (!isMatch) throw new ApiError(401, 'Invalid email or password')

  const otp = generateOtp()
  await storeOtp('login', email, otp)
  await emailService.sendRecruiterOtpEmail(recruiter, otp, 'login')

  return res.json(new ApiResponse(200, { email }, 'OTP sent to your email. Expires in 10 minutes.'))
})

const loginVerifyOtp = asyncHandler(async (req, res) => {
  const { email, otp } = req.body

  await verifyOtp('login', email, otp)

  const recruiter = await prisma.recruiter.findUnique({ where: { email } })
  if (!recruiter) throw new ApiError(401, 'Recruiter not found')

  const accessToken = await issueRecruiterTokens(res, recruiter.id, req)

  return res.json(new ApiResponse(200, {
    accessToken,
    recruiter: { id: recruiter.id, name: recruiter.name, email: recruiter.email, role: 'recruiter' },
  }, 'Login successful'))
})

const resendOtp = asyncHandler(async (req, res) => {
  const { email, purpose } = req.body
  if (purpose === 'login') {
    const recruiter = await prisma.recruiter.findUnique({ where: { email } })
    if (recruiter) {
      const otp = generateOtp()
      await storeOtp('login', email, otp)
      await emailService.sendRecruiterOtpEmail(recruiter, otp, 'login')
    }
  } else {
    let pending = await safeRedis.get(pendingKey('register', email))
    if (!pending) {
      const record = await prisma.otpStore.findUnique({ where: { key: pendingKey('register', email) } })
      if (!record || record.expiresAt < new Date()) throw new ApiError(400, 'Registration session expired. Please start again.')
      pending = record.value
    }
    const { name } = JSON.parse(pending)
    const otp = generateOtp()
    await storeOtp('register', email, otp)
    await emailService.sendRecruiterOtpEmail({ name, email }, otp, 'register')
  }
  return res.json(new ApiResponse(200, { email }, 'New OTP sent.'))
})

// ── Refresh (FIXED) ────────────────────────────────────────────────────────────

const refreshToken = asyncHandler(async (req, res) => {
  const rawToken = req.cookies?.recruiterRefreshToken
  if (!rawToken) throw new ApiError(401, 'No refresh token')

  let decoded
  try {
    decoded = verifyRefreshToken(rawToken)
  } catch (err) {
    throw new ApiError(401, err.name === 'TokenExpiredError' ? 'Refresh token expired' : 'Invalid refresh token')
  }

  if (decoded.role !== 'recruiter') throw new ApiError(403, 'Not a recruiter refresh token')

  // Validate against DB
  try {
    await validateStoredRefreshToken(rawToken)
  } catch (err) {
    if (err.message === 'REFRESH_TOKEN_REVOKED') {
      // Replay attack — revoke all recruiter tokens
      await revokeAllRefreshTokens({ recruiterId: decoded.recruiterId })
      throw new ApiError(401, 'Session revoked. Please log in again.')
    }
    throw new ApiError(401, 'Session expired. Please log in again.')
  }

  const recruiter = await prisma.recruiter.findUnique({ where: { id: decoded.recruiterId } })
  if (!recruiter) throw new ApiError(401, 'Recruiter not found')

  // Rotate token
  await revokeRefreshToken(rawToken)
  const accessToken = await issueRecruiterTokens(res, recruiter.id, req)

  return res.json(new ApiResponse(200, { accessToken }, 'Token refreshed'))
})

// ── Logout (FIXED) ─────────────────────────────────────────────────────────────

const logout = asyncHandler(async (req, res) => {
  const rawToken = req.cookies?.recruiterRefreshToken
  if (rawToken) {
    await revokeRefreshToken(rawToken).catch(() => {})
  }

  res.clearCookie('recruiterRefreshToken', CLEAR_COOKIE_OPTS)
  return res.json(new ApiResponse(200, {}, 'Logged out'))
})

// ── Me / Profile ──────────────────────────────────────────────────────────────

// This route is mounted behind the `recruiterAuth` middleware, which already
// verifies the access token, confirms role === 'recruiter', loads the
// recruiter row, and sets req.user. Re-verifying the raw header here was
// dead/duplicate logic — if the token were invalid, the request would never
// have reached this handler. Just use req.user.
const getMe = asyncHandler(async (req, res) => {
  return res.json(new ApiResponse(200, { recruiter: { ...req.user, role: 'recruiter' } }, 'OK'))
})

const getRecruiterProfile = asyncHandler(async (req, res) => {
  const recruiter = await prisma.recruiter.findUnique({
    where: { id: req.user.id },
    select: {
      id: true, name: true, email: true, avatar: true,
      company: { select: { name: true, website: true, industry: true, verificationStatus: true, logo: true } },
      jobPostings: {
        orderBy: { createdAt: 'desc' },
        take: 10,
        select: { id: true, title: true, status: true, createdAt: true, _count: { select: { applications: true } } }
      }
    }
  })
  if (!recruiter) throw new ApiError(404, 'Recruiter not found')
  return res.json(new ApiResponse(200, recruiter, 'Profile fetched'))
})

module.exports = {
  registerSendOtp, registerVerifyOtp,
  loginSendOtp, loginVerifyOtp, resendOtp,
  refreshToken, logout, getMe, getRecruiterProfile
}
