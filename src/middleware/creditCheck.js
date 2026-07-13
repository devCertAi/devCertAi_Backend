/**
 * creditCheck.js — Middleware to validate credit availability
 *
 * Usage:
 *   router.post('/postings', recruiterAuth, creditCheck('project', 1), createPosting)
 *   router.post('/postings/:id/activate', recruiterAuth, creditCheckForPosting, activatePosting)
 */

const { ApiError } = require('../utils/ApiError')
const creditService = require('../services/creditService')

/**
 * General credit check middleware.
 * @param {string} bucket — 'skill' | 'project'
 * @param {number} amount — how many credits needed
 */
const creditCheck = (bucket, amount = 1) => async (req, res, next) => {
  try {
    // No plan is unlimited — every user (including premium) draws from a
    // real, finite credit balance funded by whatever plan they bought.
    const { canProceed, balance } = await creditService.checkCredit(req.user.id, bucket)
    const creditsAvailable = balance[bucket].remaining

    if (!canProceed || creditsAvailable < amount) {
      throw new ApiError(402, `Insufficient credits. Need ${amount} ${bucket} credit(s), have ${creditsAvailable}.`, [{
        code: 'CREDITS_EXHAUSTED',
        bucket,
        creditsNeeded: amount,
        creditsAvailable,
        balance,
        upgradeUrl: '/pricing',
        nextResetAt: balance.cycleResetAt
      }])
    }

    // Attach balance to request for downstream use
    req.creditBalance = balance
    next()
  } catch (err) {
    next(err)
  }
}

/**
 * Credit check for posting activation.
 * Validates recruiter has enough credits for the expected number of CVs.
 * Expected CVs = openings * 10 (rough estimate), capped at a reasonable max.
 *
 * If recruiter doesn't have enough for all CVs, they can choose to:
 * 1. Add more credits
 * 2. Continue with limited CVs (only creditAvailable CVs will be processed)
 *
 * This middleware WARNS but does NOT block — we return a warning payload
 * that the frontend uses to show a confirmation dialog.
 */
const creditCheckForHiring = async (req, res, next) => {
  try {
    const { expectedCvCount } = req.body
    if (!expectedCvCount || expectedCvCount <= 0) return next()

    const validation = await creditService.validateRecruiterHiringCredits(
      req.user.id,
      expectedCvCount
    )

    req.creditValidation = validation

    if (!validation.canProceed) {
      // Don't block — attach warning to req for controller to handle
      req.creditWarning = {
        code: 'INSUFFICIENT_CREDITS_FOR_ALL_CVS',
        creditsNeeded: validation.creditsNeeded,
        creditsAvailable: validation.creditsAvailable,
        shortfall: validation.shortfall,
        message: `You have ${validation.creditsAvailable} credit(s) but need ${validation.creditsNeeded} for all ${expectedCvCount} CVs. CVs exceeding your credit balance will be automatically rejected.`
      }
    }

    next()
  } catch (err) {
    next(err)
  }
}

module.exports = { creditCheck, creditCheckForHiring }
