const { verifyAccessToken } = require('../utils/tokenUtils')
const prisma = require('../config/database')
const { ApiError } = require('../utils/ApiError')

const recruiterAuth = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization
    if (!authHeader?.startsWith('Bearer ')) throw new ApiError(401, 'No token provided')

    const token = authHeader.split(' ')[1]
    const decoded = verifyAccessToken(token)

    if (decoded.role !== 'recruiter') throw new ApiError(403, 'Recruiter access only')

    const recruiter = await prisma.recruiter.findUnique({
      where: { id: decoded.recruiterId },
      select: { id: true, name: true, email: true }
    })
    if (!recruiter) throw new ApiError(401, 'Recruiter not found')

    req.user = { ...recruiter, role: 'recruiter' }
    next()
  } catch (err) {
    if (err.name === 'JsonWebTokenError') return next(new ApiError(401, 'Invalid token'))
    if (err.name === 'TokenExpiredError') return next(new ApiError(401, 'Token expired'))
    next(err)
  }
}

module.exports = recruiterAuth