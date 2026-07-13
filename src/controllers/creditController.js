/**
 * creditController.js — Credit system API endpoints
 *
 * GET  /api/credits                — get current balance
 * GET  /api/credits/history        — transaction history
 * POST /api/credits/check          — check if action is possible (non-consuming)
 * POST /api/credits/watch-ad-reward — grant a credit for watching a rewarded ad
 */

const { ApiResponse } = require('../utils/ApiResponse')
const { ApiError } = require('../utils/ApiError')
const asyncHandler = require('../utils/asyncHandler')
const creditService = require('../services/creditService')

// GET /api/credits
const getMyCredits = asyncHandler(async (req, res) => {
  const balance = await creditService.getBalance(req.user.id, {
    isPremium: req.user.isPremium
  })
  return res.json(new ApiResponse(200, { credits: balance }))
})

// GET /api/credits/history
const getCreditHistory = asyncHandler(async (req, res) => {
  const { page = 1, limit = 20 } = req.query
  const result = await creditService.getTransactionHistory(req.user.id, {
    page: parseInt(page),
    limit: parseInt(limit)
  })
  return res.json(new ApiResponse(200, result))
})

// POST /api/credits/check — non-consuming check
const checkCredits = asyncHandler(async (req, res) => {
  const { bucket, count = 1 } = req.body
  if (!bucket || !['skill', 'project'].includes(bucket)) {
    throw new ApiError(400, 'bucket must be skill or project')
  }

  const { canProceed, balance } = await creditService.checkCredit(req.user.id, bucket)
  const creditsAvailable = balance[bucket].remaining

  return res.json(new ApiResponse(200, {
    canProceed: canProceed && creditsAvailable >= count,
    unlimited: false,
    creditsNeeded: count,
    creditsAvailable,
    balance,
    shortfall: Math.max(0, count - creditsAvailable)
  }))
})

// POST /api/credits/watch-ad-reward — call after a rewarded ad finishes playing
const watchAdReward = asyncHandler(async (req, res) => {
  const { bucket = 'project' } = req.body

  // No plan is unlimited anymore, so ad rewards are available to everyone,
  // premium included — extra credits are still useful once a balance runs out.
  const result = await creditService.grantAdRewardCredit(req.user.id, bucket)
  return res.json(new ApiResponse(200, result, `+${1} ${bucket} credit added!`))
})

module.exports = { getMyCredits, getCreditHistory, checkCredits, watchAdReward }
