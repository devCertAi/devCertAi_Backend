/**
 * emailService additions — paste these functions into your existing emailService.js
 *
 * Add sendRecruiterOtpEmail to the module.exports at the bottom of emailService.js.
 *
 * This function sends a branded OTP email for both recruiter register and login.
 */

// ── Recruiter OTP Email ───────────────────────────────────────────────────────
// purpose: 'register' | 'login'

// ── Export — add this to the existing module.exports in emailService.js ───────
module.exports = {
  ...existingExports,
  sendRecruiterOtpEmail,
}
