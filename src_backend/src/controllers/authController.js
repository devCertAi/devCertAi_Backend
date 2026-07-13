const bcrypt = require('bcryptjs')
const axios = require('axios')
const { OAuth2Client } = require('google-auth-library')
const prisma = require('../config/database')
const { ApiError } = require('../utils/ApiError')
const { ApiResponse } = require('../utils/ApiResponse')
const asyncHandler = require('../utils/asyncHandler')
const {
  signAccessToken,
  signRefreshToken,
  verifyRefreshToken,
  setRefreshCookie,
  storeRefreshToken,
  validateStoredRefreshToken,
  revokeRefreshToken,
  revokeAllRefreshTokens,
  CLEAR_COOKIE_OPTS,
} = require('../utils/tokenUtils')
const { generateToken, generateUsername } = require('../utils/generateIds')
const emailService = require('../services/emailService')
const creditService = require('../services/creditService')

const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID)

const SAFE_USER_FIELDS = {
  id: true, name: true, email: true, username: true,
  role: true, isPremium: true, premiumExpiresAt: true,
  avatar: true, isEmailVerified: true, createdAt: true
}

async function issueTokens(res, userId, req) {
  const accessToken  = signAccessToken(userId)
  const refreshToken = signRefreshToken(userId)
  await storeRefreshToken(refreshToken, {
    userId,
    userAgent: req.headers['user-agent'],
    ip: req.ip,
  })
  setRefreshCookie(res, refreshToken)
  return accessToken
}

// POST /register
// This endpoint is for regular (developer/candidate) accounts ONLY.
// Recruiter accounts are created exclusively via the separate OTP-based
// flow in recruiterAuthController.js, which writes to the `Recruiter`
// table — not this `User` table. `role` is intentionally never accepted
// from the client here so this endpoint can never mint a recruiter (or
// admin) account.
const register = asyncHandler(async (req, res) => {
  const { name, email, password } = req.body

  const existing = await prisma.user.findUnique({ where: { email } })

  // A `User` row flagged role:'recruiter' is always stray data now — no
  // live code path creates one anymore (see NOTE near the bottom of this
  // file). Rather than blocking with "already registered" forever, reclaim
  // it as a real user account here. A genuine 'user'/'admin' row still
  // blocks normally below.
  const isStrayRecruiterRow = existing && existing.role === 'recruiter'

  if (existing && !isStrayRecruiterRow) {
    throw new ApiError(409, 'Email already registered')
  }

  const hashedPassword = await bcrypt.hash(password, 12)
  const emailVerifyToken = generateToken()

  let user
  if (isStrayRecruiterRow) {
    user = await prisma.user.update({
      where: { id: existing.id },
      data: {
        name,
        password: hashedPassword,
        emailVerifyToken,
        isEmailVerified: false,
        role: 'user',
      },
    })
  } else {
    let username = generateUsername(name)
    while (await prisma.user.findUnique({ where: { username } })) {
      username = generateUsername(name)
    }
    user = await prisma.user.create({
      data: { name, email, password: hashedPassword, username, emailVerifyToken, role: 'user' }
    })
  }

  const verifyUrl = `${process.env.FRONTEND_URL}/auth/verify-email/${emailVerifyToken}`
  await emailService.sendVerifyEmail(user, verifyUrl)

  return res.status(201).json(new ApiResponse(201, { email: user.email }, 'Verification email sent. Please check your inbox.'))
})

// GET /verify-email/:token
const verifyEmail = asyncHandler(async (req, res) => {
  const { token } = req.params

  const user = await prisma.user.findFirst({ where: { emailVerifyToken: token } })
  if (!user) throw new ApiError(400, 'Invalid or expired verification token')

  await prisma.user.update({
    where: { id: user.id },
    data: { isEmailVerified: true, emailVerifyToken: null }
  })

  await emailService.sendWelcomeEmail(user)

  // Grant signup bonus credits (idempotent — safe to call here)
  creditService.grantSignupBonus(user.id).catch(err => {
    console.error('[credits] Failed to grant signup bonus:', err.message)
  })

  // Grant recruiter free credits if this is a recruiter account
  if (user.role === 'recruiter') {
    creditService.grantRecruiterBonus(user.id).catch(err => {
      console.error('[credits] Failed to grant recruiter bonus:', err.message)
    })
  }

  const accessToken = await issueTokens(res, user.id, req)
  const userData = await prisma.user.findUnique({ where: { id: user.id }, select: SAFE_USER_FIELDS })
  return res.json(new ApiResponse(200, { accessToken, user: userData }, 'Email verified successfully'))
})

// POST /login
// This is the regular (developer/candidate) login. Recruiters authenticate
// through /auth/recruiter/login/* instead, against the separate `Recruiter`
// table. A `User` row flagged with a non-'user' role is always stray data
// now (no live code path creates one) — once the password proves they own
// this row, reclaim it as a normal user rather than blocking forever.
const login = asyncHandler(async (req, res) => {
  const { email, password } = req.body

  let user = await prisma.user.findUnique({ where: { email } })
  if (!user || !user.password) throw new ApiError(401, 'Invalid email or password')
  if (!user.isEmailVerified)   throw new ApiError(403, 'Please verify your email before logging in')

  const isMatch = await bcrypt.compare(password, user.password)
  if (!isMatch) throw new ApiError(401, 'Invalid email or password')

  if (user.role === 'recruiter') {
    user = await prisma.user.update({ where: { id: user.id }, data: { role: 'user' } })
  }

  const accessToken = await issueTokens(res, user.id, req)
  const userData = await prisma.user.findUnique({ where: { id: user.id }, select: SAFE_USER_FIELDS })
  return res.json(new ApiResponse(200, { accessToken, user: userData }, 'Login successful'))
})

// POST /google
const googleAuth = asyncHandler(async (req, res) => {
  const { accessToken: googleToken } = req.body

  let googleUser
  try {
    const { data } = await axios.get('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { Authorization: `Bearer ${googleToken}` }
    })
    googleUser = data
  } catch {
    throw new ApiError(401, 'Invalid Google access token')
  }
  const { sub: googleId, email, name, picture } = googleUser

  let user = await prisma.user.findFirst({ where: { OR: [{ googleId }, { email }] } })
  const isNewUser = !user

  // A stray User row flagged role:'recruiter' is always leftover data now.
  // Google already proved they own this email, so reclaim the row as a
  // normal user instead of blocking them out of their own account.
  if (user && user.role === 'recruiter') {
    user = await prisma.user.update({ where: { id: user.id }, data: { role: 'user' } })
  }

  if (!user) {
    let username = generateUsername(name)
    while (await prisma.user.findUnique({ where: { username } })) {
      username = generateUsername(name)
    }
    user = await prisma.user.create({
      data: { name, email, googleId, avatar: picture, username, isEmailVerified: true }
    })
  } else if (!user.googleId) {
    user = await prisma.user.update({
      where: { id: user.id },
      data: { googleId, avatar: picture || user.avatar, isEmailVerified: true }
    })
  }

  // Grant signup bonus for new Google users
  if (isNewUser) {
    creditService.grantSignupBonus(user.id).catch(err => {
      console.error('[credits] Failed to grant Google signup bonus:', err.message)
    })
  }

  const accessToken = await issueTokens(res, user.id, req)
  const userData = await prisma.user.findUnique({ where: { id: user.id }, select: SAFE_USER_FIELDS })
  return res.json(new ApiResponse(200, { accessToken, user: userData }, 'Google login successful'))
})

// POST /refresh
const refresh = asyncHandler(async (req, res) => {
  const rawToken = req.cookies?.refreshToken
  if (!rawToken) throw new ApiError(401, 'No refresh token')

  let decoded
  try {
    decoded = verifyRefreshToken(rawToken)
  } catch (err) {
    throw new ApiError(401, err.name === 'TokenExpiredError' ? 'Refresh token expired' : 'Invalid refresh token')
  }

  if (!decoded.userId) throw new ApiError(401, 'Invalid refresh token for this endpoint')

  try {
    await validateStoredRefreshToken(rawToken)
  } catch (err) {
    if (err.message === 'REFRESH_TOKEN_REVOKED') {
      await revokeAllRefreshTokens({ userId: decoded.userId })
      throw new ApiError(401, 'Session revoked. Please log in again.')
    }
    throw new ApiError(401, 'Session expired. Please log in again.')
  }

  const user = await prisma.user.findUnique({ where: { id: decoded.userId } })
  if (!user) throw new ApiError(401, 'User not found')

  await revokeRefreshToken(rawToken)
  const accessToken = await issueTokens(res, user.id, req)

  return res.json(new ApiResponse(200, { accessToken }, 'Token refreshed'))
})

// POST /logout
const logout = asyncHandler(async (req, res) => {
  const rawToken = req.cookies?.refreshToken
  if (rawToken) {
    await revokeRefreshToken(rawToken).catch(() => {})
  }

  res.clearCookie('refreshToken', CLEAR_COOKIE_OPTS)
  return res.json(new ApiResponse(200, {}, 'Logged out'))
})

// GET /me
const getMe = asyncHandler(async (req, res) => {
  const user = await prisma.user.findUnique({ where: { id: req.user.id }, select: SAFE_USER_FIELDS })
  return res.json(new ApiResponse(200, { user }, 'User fetched'))
})

// POST /forgot-password
const forgotPassword = asyncHandler(async (req, res) => {
  const { email } = req.body
  const user = await prisma.user.findUnique({ where: { email } })

  if (user) {
    const resetToken = generateToken()
    await prisma.user.update({
      where: { id: user.id },
      data: { resetToken, resetTokenExpiry: new Date(Date.now() + 3600000) }
    })
    const resetUrl = `${process.env.FRONTEND_URL}/auth/reset-password/${resetToken}`
    await emailService.sendPasswordResetEmail(user, resetUrl)
  }

  return res.json(new ApiResponse(200, {}, 'If that email exists, a reset link has been sent.'))
})

// POST /reset-password/:token
const resetPassword = asyncHandler(async (req, res) => {
  const { token } = req.params
  const { password } = req.body

  const user = await prisma.user.findFirst({
    where: { resetToken: token, resetTokenExpiry: { gt: new Date() } }
  })
  if (!user) throw new ApiError(400, 'Invalid or expired reset token')

  const hashed = await bcrypt.hash(password, 12)
  await prisma.user.update({
    where: { id: user.id },
    data: { password: hashed, resetToken: null, resetTokenExpiry: null }
  })

  await revokeAllRefreshTokens({ userId: user.id })

  return res.json(new ApiResponse(200, {}, 'Password reset successfully. Please log in.'))
})

// NOTE: recruiter registration used to live here as `registerRecruiter`,
// writing role:'recruiter' rows straight into the `User` table. That path
// has been removed — it duplicated (and conflicted with) the OTP-based
// recruiter flow in recruiterAuthController.js, which is the only
// supported way to create a recruiter account now (separate `Recruiter`
// table). See routes/recruiterAuth.js for /auth/recruiter/register/*.

module.exports = {
  register, verifyEmail, login, googleAuth,
  refresh, logout, getMe, forgotPassword, resetPassword
}
