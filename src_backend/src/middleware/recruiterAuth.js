const { verifyAccessToken } = require('../utils/tokenUtils')
const prisma = require('../config/database')
const { ApiError } = require('../utils/ApiError')

const recruiterAuth = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization
    if (!authHeader?.startsWith('Bearer ')) throw new ApiError(401, 'No token provided')

    const token = authHeader.split(' ')[1]
    // Use verifyAccessToken (reads JWT_SECRET) — same as the shared auth middleware
    const decoded = verifyAccessToken(token)

    if (decoded.role === 'recruiter') {
      const recruiter = await prisma.recruiter.findUnique({
        where: { id: decoded.recruiterId },
        select: { id: true, name: true, email: true }
      })
      if (!recruiter) throw new ApiError(401, 'Recruiter not found')
      req.user = { ...recruiter, role: 'recruiter' }
      return next()
    }

    // NOTE: signAccessToken() hardcodes `role: 'user'` into every non-recruiter
    // JWT regardless of the account's real role — the token itself can't tell
    // a plain user from an admin. The DB row is the only source of truth, so
    // look it up before deciding whether to let this request through.
    if (decoded.userId) {
      const user = await prisma.user.findUnique({
        where: { id: decoded.userId },
        select: { id: true, name: true, email: true, role: true }
      })
      if (user?.role === 'admin') {
        req.user = { ...user, role: 'admin' }
        return next()
      }
    }

    throw new ApiError(403, 'Recruiter access only')
  } catch (err) {
    if (err.name === 'JsonWebTokenError') return next(new ApiError(401, 'Invalid token'))
    if (err.name === 'TokenExpiredError') return next(new ApiError(401, 'Token expired'))
    next(err)
  }
}

module.exports = recruiterAuth