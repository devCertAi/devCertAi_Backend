const { ApiError } = require('../utils/ApiError')

const errorHandler = (err, req, res, next) => {
  let error = err

  if (!(error instanceof ApiError)) {
    const statusCode = error.statusCode || 500
    const message = error.message || 'Internal Server Error'
    error = new ApiError(statusCode, message, error?.errors || [], err.stack)
  }

  const response = {
    success: false,
    message: error.message,
    errors: error.errors,
    // Include extra data (e.g. attemptId on in-progress 400 errors)
    ...(error.data ? { data: error.data } : {}),
    ...(process.env.NODE_ENV === 'development' ? { stack: error.stack } : {})
  }

  console.error(`[Error] ${error.statusCode} - ${error.message}`)

  return res.status(error.statusCode).json(response)
}

module.exports = errorHandler