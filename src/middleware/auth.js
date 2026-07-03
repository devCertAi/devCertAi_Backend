const { verifyAccessToken } = require('../utils/tokenUtils')
const { ApiError } = require('../utils/ApiError')
const { safeRedis } = require('../config/redis')
const prisma = require('../config/database')

const CACHE_TTL = 60 * 5

const auth = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization
    if (!authHeader?.startsWith('Bearer ')) throw new ApiError(401, 'No token provided')

    const token = authHeader.split(' ')[1]
    const decoded = verifyAccessToken(token)

    if (!decoded.userId) throw new ApiError(401, 'Invalid token payload')

    const cacheKey = `user:auth:${decoded.userId}`
    let user = null

    const cached = await safeRedis.get(cacheKey)
    if (cached) user = JSON.parse(cached)

    if (!user) {
      user = await prisma.user.findUnique({
        where: { id: decoded.userId },
        select: { id: true, name: true, email: true, role: true, avatar: true, username: true },
      })
      if (!user) throw new ApiError(401, 'User not found')
      await safeRedis.set(cacheKey, JSON.stringify(user), 'EX', CACHE_TTL)
    }

    req.user = user
    next()
  } catch (err) {
    if (err.name === 'JsonWebTokenError') return next(new ApiError(401, 'Invalid token'))
    if (err.name === 'TokenExpiredError') return next(new ApiError(401, 'Token expired'))
    next(err)
  }
}

module.exports = auth