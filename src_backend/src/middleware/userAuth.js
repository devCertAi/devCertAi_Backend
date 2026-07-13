/**
 * middleware/userAuth.js
 *
 * User-only auth middleware. Blocks:
 *  - Recruiter tokens (role: 'recruiter') → 403
 *  - Missing/invalid tokens → 401
 *
 * Use this on all user-facing routes (/users, /projects, /exam, etc.)
 * Use middleware/auth.js (recruiterAuth) for recruiter + admin routes.
 */

const prisma = require('../config/database')
const { verifyAccessToken } = require('../utils/tokenUtils')
const { ApiError } = require('../utils/ApiError')
const { safeRedis } = require('../config/redis')

const CACHE_TTL = 300 // 5 min

const userAuth = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization
    if (!authHeader?.startsWith('Bearer ')) throw new ApiError(401, 'No token provided')

    const token = authHeader.split(' ')[1]
    const decoded = verifyAccessToken(token)

    if (!decoded.userId) throw new ApiError(401, 'Invalid token payload')

    // Block recruiter tokens — they must use /recruiter endpoints
    if (decoded.role === 'recruiter') {
      throw new ApiError(403, 'Access denied. Use recruiter credentials for recruiter endpoints.')
    }

    // Cache lookup
    const cacheKey = `user:auth:${decoded.userId}`
    let user = null
    try {
      const cached = await safeRedis.get(cacheKey)
      if (cached) user = JSON.parse(cached)
    } catch {}

    if (!user) {
      user = await prisma.user.findUnique({
        where: { id: decoded.userId },
        select: { id: true, name: true, email: true, role: true, avatar: true, username: true, isPremium: true, premiumExpiresAt: true }
      })
      if (!user) throw new ApiError(401, 'User not found')
      try { await safeRedis.set(cacheKey, JSON.stringify(user), 'EX', CACHE_TTL) } catch {}
    }

    req.user = user
    next()
  } catch (err) {
    if (err.name === 'JsonWebTokenError') return next(new ApiError(401, 'Invalid token'))
    if (err.name === 'TokenExpiredError') return next(new ApiError(401, 'Token expired'))
    next(err)
  }
}

module.exports = userAuth