const express = require('express')
const router = express.Router()
const validate = require('../middleware/validate')
const { authLimiter } = require('../middleware/rateLimiter')
const auth = require('../middleware/auth')
const { requireCsrfHeader } = require('../middleware/csrf')
const {
  register, verifyEmail, login, googleAuth,
  refresh, logout, getMe, forgotPassword, resetPassword
} = require('../controllers/authController')
const {
  registerSchema, loginSchema,
  forgotPasswordSchema, resetPasswordSchema, googleAuthSchema
} = require('../validators/authValidators')

// Recruiter registration/login lives entirely under /auth/recruiter/*
// (see routes/recruiterAuth.js) — a separate `Recruiter` table with its
// own OTP-based flow. It is intentionally NOT wired up here anymore.
router.post('/register',            authLimiter, validate(registerSchema),          register)
router.get('/verify-email/:token',  verifyEmail)
router.post('/login',               authLimiter, validate(loginSchema),             login)
router.post('/google',              authLimiter, validate(googleAuthSchema),        googleAuth)
// refresh + logout authenticate via the refreshToken COOKIE, not a Bearer
// header — with cross-site cookies (SameSite=None) that cookie alone isn't
// proof the request came from our own frontend, so a CSRF header is
// required in front of both. See middleware/csrf.js for why.
router.post('/refresh',             requireCsrfHeader,                             refresh)
router.post('/logout',              requireCsrfHeader,                             logout)
router.get('/me',                   auth,                                           getMe)
router.post('/forgot-password',     authLimiter, validate(forgotPasswordSchema),    forgotPassword)
router.post('/reset-password/:token', validate(resetPasswordSchema),               resetPassword)

module.exports = router
