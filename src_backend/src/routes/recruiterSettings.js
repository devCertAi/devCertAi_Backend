/**
 * routes/recruiterSettings.js
 *
 * Mount this in app.js / server.js:
 *   const recruiterSettingsRouter = require('./routes/recruiterSettings')
 *   app.use('/recruiter/settings', recruiterSettingsRouter)
 *
 * All routes require recruiterAuth middleware (JWT).
 */

const express       = require('express')
const router        = express.Router()
const recruiterAuth = require('../middleware/recruiterAuth')
const {
  updateProfile,
  sendEmailChangeOtp,
  verifyEmailChangeOtpHandler,
  changePassword,
  deleteAccount,
} = require('../controllers/recruiterSettingsController')

// All routes behind recruiter auth
router.use(recruiterAuth)

// ── Profile ───────────────────────────────────────────────────────────────────
// PUT /recruiter/settings/profile  { name }
router.put('/profile', updateProfile)

// ── Email change (OTP flow) ───────────────────────────────────────────────────
// POST /recruiter/settings/change-email/send-otp   { newEmail }
router.post('/change-email/send-otp', sendEmailChangeOtp)
// POST /recruiter/settings/change-email/verify-otp { newEmail, otp }
router.post('/change-email/verify-otp', verifyEmailChangeOtpHandler)

// ── Password ──────────────────────────────────────────────────────────────────
// PUT /recruiter/settings/change-password  { oldPassword, newPassword }
router.put('/change-password', changePassword)

// ── Delete account ────────────────────────────────────────────────────────────
// DELETE /recruiter/settings/account
router.delete('/account', deleteAccount)

module.exports = router