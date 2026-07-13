const { ApiError } = require('../utils/ApiError')

const premium = (req, res, next) => {
  if (!req.user.isPremium) {
    return next(new ApiError(403, 'This feature requires a premium subscription'))
  }
  next()
}

module.exports = premium
