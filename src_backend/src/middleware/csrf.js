/**
 * middleware/csrf.js
 *
 * WHY THIS EXISTS (read before deleting it):
 * With SameSite=None cookies (required for cross-site deploys — frontend on
 * one domain, backend on another), the browser will attach the refreshToken
 * cookie to a request no matter which site triggered it. A plain HTML form
 * hosted on evil.com, or an <img>/fetch("no-cors") request, can trigger a
 * POST to /auth/refresh or /auth/logout and the browser still attaches your
 * cookie — that's a CSRF hole. SameSite=Lax/Strict used to block this for
 * free; None does not.
 *
 * Fix: require a custom header on every cookie-authenticated request. A
 * plain HTML <form> submission or a cross-site <img>/no-cors fetch CANNOT
 * add custom headers — only same-origin or CORS-preflighted requests can.
 * Since our CORS config only allows FRONTEND_URL as an origin, only our own
 * frontend's JS can ever attach this header. A forged cross-site request
 * from any other site physically cannot include it, so it gets rejected
 * here before the cookie is ever trusted.
 *
 * This does NOT need to be a secret or unpredictable value — the whole
 * mechanism relies on "custom headers require CORS approval," not on the
 * header value being unguessable. Anyone can see the header name in the
 * frontend's JS bundle; that's fine, that's not the protection.
 *
 * Apply this ONLY to routes that authenticate via the refresh cookie
 * (POST /auth/refresh, /auth/logout, /auth/recruiter/refresh,
 * /auth/recruiter/logout). Routes protected by a Bearer access token
 * (everything else) don't need it — an attacker's page has no way to read
 * or attach a token that lives in this origin's localStorage.
 */

const { ApiError } = require('../utils/ApiError')

const REQUIRED_HEADER = 'x-requested-with'
const REQUIRED_VALUE  = 'XMLHttpRequest'

const requireCsrfHeader = (req, _res, next) => {
  const value = req.headers[REQUIRED_HEADER]
  if (value !== REQUIRED_VALUE) {
    return next(new ApiError(403, 'Missing or invalid CSRF header'))
  }
  next()
}

module.exports = { requireCsrfHeader }
