const express = require('express')
const router = express.Router()
const recruiterAuth = require('../middleware/recruiterAuth')
const { requireCsrfHeader } = require('../middleware/csrf')
const {
  registerSendOtp, registerVerifyOtp,
  loginSendOtp, loginVerifyOtp,
  resendOtp, refreshToken, logout, getMe,
  getRecruiterProfile  // ← yeh add karo
} = require('../controllers/recruiterAuthController')
// ── Public (no middleware) ──────────────────────────────────────────────────
router.post('/register/send-otp',   registerSendOtp)
router.post('/register/verify-otp', registerVerifyOtp)
router.post('/login/send-otp',      loginSendOtp)
router.post('/login/verify-otp',    loginVerifyOtp)
router.post('/resend-otp',          resendOtp)
// Cookie-only auth (recruiterRefreshToken) — needs the CSRF header guard
// under cross-site (SameSite=None) cookies. See middleware/csrf.js.
router.post('/refresh',             requireCsrfHeader, refreshToken)

// ── Protected ───────────────────────────────────────────────────────────────
router.get('/me',      recruiterAuth, getMe)
router.get('/profile', recruiterAuth, getRecruiterProfile)

// Logout is intentionally NOT behind recruiterAuth. It only needs the
// httpOnly recruiterRefreshToken cookie (see controller — it never reads
// req.user). Requiring a valid Bearer access token here meant logout
// silently failed to revoke the session whenever that token had already
// expired, was missing, or belonged to a different role — including the
// frontend's "clear the other role's stray session" cleanup call, which by
// design is made with a *different* role's token attached.
router.post('/logout', requireCsrfHeader, logout)

module.exports = router