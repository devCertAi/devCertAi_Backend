const { ApiError } = require('../utils/ApiError')

const admin = (req, res, next) => {
  if (req.user.role !== 'admin') {
    return next(new ApiError(403, 'Admin access required'))
  }
  next()
}

module.exports = admin
