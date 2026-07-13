/**
 * creditService.js — Unified credit management
 *
 * CREDIT RULES:
 * - Free monthly allowance: 3 project evals + 1 skill exam / month
 * - Purchased credits stack on top (never overwrite), valid 6 months
 * - Signup bonus: 1 skill exam + 1 project eval (new users)
 * - Paid plans (starter ₹9 / growth ₹29 / pro ₹59 / recruiter ₹999) each
 *   grant a fixed credit bundle sized to cover their AI token cost — see
 *   PLAN_CREDITS in validators/paymentValidators.js. NO plan is unlimited;
 *   every project eval and exam attempt always draws from a real balance.
 * - If credits are re-bought, new ones stack on existing balance, expiry extends
 * - Exam 1 (Phase 1) costs 1 skill credit; Exam 2 (Phase 2) costs 1 skill credit
 * - Project evaluation costs 1–3 project credits, based on detected project
 *   size (Small/Medium/Large — see utils/projectSizeEstimator.js). Size is
 *   estimated from AI token spend and re-derived server-side at submit time,
 *   never trusted from the client.
 * - Certificate is FREE (no credit consumed)
 *
 * CREDIT EXPIRY:
 * - Free monthly credits reset every 30 days (cycleResetAt)
 * - Purchased/bonus credits expire after 6 months from purchase (bonusExpiresAt)
 *   If user buys again before expiry, balance stacks and expiry extends to farthest
 */

const prisma = require('../config/database')
const { ApiError } = require('../utils/ApiError')

// 6 months in days for purchased credit validity
const PURCHASED_CREDIT_VALID_DAYS = 180

const addMonths = (date, n) => {
  const d = new Date(date)
  d.setMonth(d.getMonth() + n)
  return d
}

const addDays = (date, n) => {
  const d = new Date(date)
  d.setDate(d.getDate() + n)
  return d
}

/**
 * Get or create user credits record, auto-resetting expired cycles and
 * clearing expired bonus credits.
 */
const getOrCreateCredits = async (userId) => {
  let record = await prisma.userCredits.findUnique({ where: { userId } })

  if (!record) {
    // New user gets signup bonus: 1 skill + 1 project
    record = await prisma.userCredits.create({
      data: {
        userId,
        cycleResetAt: addMonths(new Date(), 1),
        // Signup bonus included in initial free limits
        skillExamLimit: 2,        // 1 free + 1 signup bonus
        projectEvalLimit: 4,      // 3 free + 1 signup bonus
        bonusExpiresAt: addDays(new Date(), PURCHASED_CREDIT_VALID_DAYS)
      }
    })

    // Record signup bonus transaction
    await prisma.creditTransaction.create({
      data: {
        userId,
        kind: 'signup_bonus',
        amount: 2,
        source: 'bonus',
        meta: { project: 1, skill: 1, reason: 'new_user_signup_bonus' }
      }
    })

    return record
  }

  const now = new Date()
  const needsCycleReset = new Date(record.cycleResetAt).getTime() <= now.getTime()
  const needsBonusClear = record.bonusExpiresAt &&
    new Date(record.bonusExpiresAt).getTime() <= now.getTime()

  if (needsCycleReset || needsBonusClear) {
    const data = {}

    if (needsCycleReset) {
      data.projectEvalUsed = 0
      data.skillExamUsed = 0
      // Reset to base free limits (bonus stays until it expires)
      data.projectEvalLimit = 3
      data.skillExamLimit = 1
      data.cycleStartedAt = now
      data.cycleResetAt = addMonths(now, 1)
    }

    if (needsBonusClear) {
      data.bonusProjectCredits = 0
      data.bonusSkillCredits = 0
      data.bonusExpiresAt = null
    }

    record = await prisma.userCredits.update({ where: { userId }, data })

    if (needsCycleReset) {
      await prisma.creditTransaction.create({
        data: {
          userId,
          kind: 'monthly_reset',
          amount: 0,
          meta: { newCycleResetAt: data.cycleResetAt }
        }
      })
    }
  }

  return record
}

/**
 * Build a structured balance object from a DB record.
 */
const toBalance = (record) => ({
  project: {
    used: record.projectEvalUsed,
    limit: record.projectEvalLimit,
    bonus: record.bonusProjectCredits,
    remaining: Math.max(0, record.projectEvalLimit - record.projectEvalUsed) + record.bonusProjectCredits
  },
  skill: {
    used: record.skillExamUsed,
    limit: record.skillExamLimit,
    bonus: record.bonusSkillCredits,
    remaining: Math.max(0, record.skillExamLimit - record.skillExamUsed) + record.bonusSkillCredits
  },
  bonusExpiresAt: record.bonusExpiresAt,
  cycleResetAt: record.cycleResetAt,
  // When bonus credits expire (purchased ones)
  purchasedExpiresAt: record.bonusExpiresAt,
})

/**
 * Get a user's current credit balance.
 *
 * No plan is unlimited anymore — premium status (from a paid plan) only
 * affects which cosmetic perks are unlocked elsewhere; it does not change
 * the credit numbers returned here. The `isPremium` param is accepted for
 * backward-compatible call sites but no longer alters the result.
 */
const getBalance = async (userId, { isPremium = false } = {}) => {
  const record = await getOrCreateCredits(userId)
  const balance = toBalance(record)
  return { ...balance, unlimited: false }
}

const BUCKET_FIELDS = {
  project: {
    used: 'projectEvalUsed',
    limit: 'projectEvalLimit',
    bonus: 'bonusProjectCredits',
    balanceKey: 'balanceProjectAfter'
  },
  skill: {
    used: 'skillExamUsed',
    limit: 'skillExamLimit',
    bonus: 'bonusSkillCredits',
    balanceKey: 'balanceSkillAfter'
  }
}

const KIND_BY_BUCKET = { project: 'project_eval', skill: 'skill_exam' }

const CREDIT_COST = {
  exam_phase1: { bucket: 'skill', amount: 1 },
  exam_phase2: { bucket: 'skill', amount: 1 },
  project_eval: { bucket: 'project', amount: 1 },
  certificate: null,          // FREE
  project_eval_certificate: null  // FREE
}

/**
 * Consume `amount` credits from the given bucket (defaults to 1).
 * Throws 402 with CREDITS_EXHAUSTED code if not enough remain.
 * Free monthly credits are consumed first; bonus credits are used as
 * overflow, and can cover the remainder of a multi-credit charge (e.g. a
 * "Large" project evaluation costing 3 credits with only 1 free credit
 * left draws the other 2 from bonus).
 */
const consumeCredit = async (userId, bucket, meta = {}, amount = 1) => {
  const fields = BUCKET_FIELDS[bucket]
  if (!fields) throw new Error(`Unknown credit bucket: ${bucket}`)
  if (!Number.isInteger(amount) || amount < 1) throw new Error(`Invalid credit amount: ${amount}`)

  const record = await getOrCreateCredits(userId)

  const used = record[fields.used]
  const limit = record[fields.limit]
  const bonus = record[fields.bonus]
  const freeRemaining = Math.max(0, limit - used)

  if (freeRemaining + bonus < amount) {
    const balance = toBalance(record)
    throw new ApiError(402, `Not enough ${bucket === 'project' ? 'project evaluation' : 'exam'} credits (need ${amount}, have ${freeRemaining + bonus})`, [{
      code: 'CREDITS_EXHAUSTED',
      bucket,
      creditsNeeded: amount,
      creditsAvailable: freeRemaining + bonus,
      balance,
      locked: true,
      upgradeUrl: '/pricing',
      nextResetAt: record.cycleResetAt,
      bonusExpiresAt: record.bonusExpiresAt
    }])
  }

  const useFree = Math.min(amount, freeRemaining)
  const useBonus = amount - useFree
  const data = {
    ...(useFree > 0 ? { [fields.used]: used + useFree } : {}),
    ...(useBonus > 0 ? { [fields.bonus]: bonus - useBonus } : {}),
  }

  const updated = await prisma.userCredits.update({ where: { userId }, data })

  await prisma.creditTransaction.create({
    data: {
      userId,
      kind: KIND_BY_BUCKET[bucket],
      bucket,
      amount: -amount,
      source: useBonus > 0 && useFree > 0 ? 'free+bonus' : useBonus > 0 ? 'bonus' : 'free',
      [fields.balanceKey]: toBalance(updated)[bucket].remaining,
      meta
    }
  })

  // `_debit` is returned (not persisted anywhere but the transaction row
  // above) so a caller that might need to refund this exact charge later —
  // e.g. a project evaluation that fails after the credit was already
  // consumed at submission time — can restore credits to the same pools
  // (free vs bonus) they were drawn from. See refundCredit() below.
  return { ...toBalance(updated), _debit: { amount, useFree, useBonus } }
}

/**
 * Check credit availability without consuming. Returns { canProceed, balance }.
 * @param {string} userId
 * @param {'project'|'skill'} bucket
 * @param {number} amount — how many credits the action would need (default 1)
 */
const checkCredit = async (userId, bucket, amount = 1) => {
  const record = await getOrCreateCredits(userId)
  const fields = BUCKET_FIELDS[bucket]
  const used = record[fields.used]
  const limit = record[fields.limit]
  const bonus = record[fields.bonus]
  const freeRemaining = Math.max(0, limit - used)
  const canProceed = (freeRemaining + bonus) >= amount
  return { canProceed, balance: toBalance(record) }
}

/**
 * Refund credits previously consumed for an action that ultimately failed
 * through no fault of the user — e.g. a project submission that was
 * charged a credit up front, but the AI evaluation pipeline errored out
 * before producing a result. Restores credits to the exact pools (free vs
 * bonus) the original charge drew from, using the `_debit` snapshot
 * `consumeCredit` returned at charge time, so a refund can't quietly
 * convert a free-tier debit into a permanent bonus credit.
 *
 * Safe to call even if `debit` is missing/invalid — it's a no-op in that
 * case rather than throwing, since a refund should never be the thing that
 * crashes a worker's failure-handling path.
 *
 * @param {string} userId
 * @param {'project'|'skill'} bucket
 * @param {object} meta - recorded on the refund's CreditTransaction for audit
 * @param {{amount:number, useFree:number, useBonus:number}} debit - snapshot from consumeCredit's return value (`._debit`)
 */
const refundCredit = async (userId, bucket, meta = {}, debit) => {
  const fields = BUCKET_FIELDS[bucket]
  if (!fields) throw new Error(`Unknown credit bucket: ${bucket}`)
  if (!debit || !Number.isInteger(debit.amount) || debit.amount < 1) return null

  const { amount, useFree = 0, useBonus = amount } = debit

  const record = await getOrCreateCredits(userId)
  const data = {
    ...(useFree > 0 ? { [fields.used]: Math.max(0, record[fields.used] - useFree) } : {}),
    ...(useBonus > 0 ? { [fields.bonus]: record[fields.bonus] + useBonus } : {}),
  }
  const updated = await prisma.userCredits.update({ where: { userId }, data })

  await prisma.creditTransaction.create({
    data: {
      userId,
      kind: 'refund',
      bucket,
      amount, // positive — credits restored
      source: useBonus > 0 && useFree > 0 ? 'free+bonus' : useBonus > 0 ? 'bonus' : 'free',
      [fields.balanceKey]: toBalance(updated)[bucket].remaining,
      meta
    }
  })

  return toBalance(updated)
}

/**
 * Grant bonus/purchased credits. Credits STACK — they are added to existing
 * balance, not replace it. Expiry extends to the farthest future date.
 *
 * Used for:
 * - Recruiter plan purchase (50 project + 20 skill)
 * - Future credit pack purchases
 * - Admin grants
 *
 * @param {string} userId
 * @param {{ project?: number, skill?: number, validForDays?: number, reason?: string }} opts
 */
const grantBonusCredits = async (userId, {
  project = 0,
  skill = 0,
  validForDays = PURCHASED_CREDIT_VALID_DAYS,
  reason = 'bonus_grant'
} = {}) => {
  const record = await getOrCreateCredits(userId)

  // Expiry: max of existing expiry and new expiry (never shorten)
  const newExpiry = addDays(new Date(), validForDays)
  const effectiveExpiry = record.bonusExpiresAt &&
    new Date(record.bonusExpiresAt).getTime() > newExpiry.getTime()
    ? new Date(record.bonusExpiresAt)
    : newExpiry

  const updated = await prisma.userCredits.update({
    where: { userId },
    data: {
      bonusProjectCredits: { increment: project },
      bonusSkillCredits: { increment: skill },
      bonusExpiresAt: effectiveExpiry
    }
  })

  await prisma.creditTransaction.create({
    data: {
      userId,
      kind: 'bonus_grant',
      amount: project + skill,
      source: 'purchased',
      meta: { project, skill, validForDays, reason, expiresAt: effectiveExpiry }
    }
  })

  return toBalance(updated)
}

/**
 * Grant signup bonus to a new user (idempotent — won't double-grant).
 * Called after email verification for clean UX.
 */
const grantSignupBonus = async (userId) => {
  const existing = await prisma.creditTransaction.findFirst({
    where: { userId, kind: 'signup_bonus' }
  })
  if (existing) return null  // Already granted

  return grantBonusCredits(userId, {
    project: 1,
    skill: 1,
    validForDays: PURCHASED_CREDIT_VALID_DAYS,
    reason: 'signup_bonus'
  })
}

/**
 * Grant free recruiter credits (called when recruiter account is activated).
 * Idempotent — won't double-grant.
 */
const grantRecruiterBonus = async (userId) => {
  const existing = await prisma.creditTransaction.findFirst({
    where: { userId, kind: 'recruiter_free_credits' }
  })
  if (existing) return null

  const updated = await grantBonusCredits(userId, {
    project: 10,
    skill: 5,
    validForDays: PURCHASED_CREDIT_VALID_DAYS,
    reason: 'recruiter_free_credits'
  })

  // Record separately for clarity
  await prisma.creditTransaction.create({
    data: {
      userId,
      kind: 'recruiter_free_credits',
      amount: 15,
      source: 'bonus',
      meta: { project: 10, skill: 5, reason: 'recruiter_free_credits' }
    }
  })

  return updated
}

/**
 * Validate recruiter has enough credits before starting a hiring pipeline.
 * @param {string} recruiterId
 * @param {number} cvCount — number of CVs to process
 * @returns {{ canProceed: boolean, creditsNeeded: number, creditsAvailable: number, balance: object }}
 */
const validateRecruiterHiringCredits = async (recruiterId, cvCount) => {
  const record = await getOrCreateCredits(recruiterId)
  const balance = toBalance(record)
  const creditsAvailable = balance.project.remaining
  const creditsNeeded = cvCount

  return {
    canProceed: creditsAvailable >= creditsNeeded,
    creditsNeeded,
    creditsAvailable,
    balance,
    shortfall: Math.max(0, creditsNeeded - creditsAvailable)
  }
}

/**
 * Get credit transaction history for a user.
 */
const getTransactionHistory = async (userId, { page = 1, limit = 20 } = {}) => {
  const skip = (page - 1) * limit
  const [transactions, total] = await Promise.all([
    prisma.creditTransaction.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      skip,
      take: limit
    }),
    prisma.creditTransaction.count({ where: { userId } })
  ])
  return { transactions, total, page, limit, pages: Math.ceil(total / limit) }
}

/**
 * Grant a small bonus credit for watching a rewarded ad. Capped per day per
 * user to prevent farming — counts existing 'ad_reward' transactions since
 * midnight rather than trusting the client's ad-watch timer alone.
 *
 * @param {string} userId
 * @param {'project'|'skill'} bucket — which credit type to reward
 * @returns {{ balance: object, grantedToday: number, dailyLimit: number }}
 */
const AD_REWARD_DAILY_LIMIT = 3
const AD_REWARD_AMOUNT = 1
const AD_REWARD_VALID_DAYS = 30

const grantAdRewardCredit = async (userId, bucket = 'project') => {
  if (!['project', 'skill'].includes(bucket)) {
    throw new ApiError(400, 'bucket must be project or skill')
  }

  const startOfDay = new Date()
  startOfDay.setHours(0, 0, 0, 0)

  const grantedToday = await prisma.creditTransaction.count({
    where: { userId, kind: 'ad_reward', createdAt: { gte: startOfDay } }
  })

  if (grantedToday >= AD_REWARD_DAILY_LIMIT) {
    throw new ApiError(429, `You've reached today's limit of ${AD_REWARD_DAILY_LIMIT} ad-reward credits. Come back tomorrow!`)
  }

  const balance = await grantBonusCredits(userId, {
    [bucket]: AD_REWARD_AMOUNT,
    validForDays: AD_REWARD_VALID_DAYS,
    reason: 'ad_reward'
  })

  // grantBonusCredits already logs a 'bonus_grant' transaction — also log a
  // distinctly-kinded one so the daily-cap count above stays accurate and
  // ad rewards are distinguishable in transaction history.
  await prisma.creditTransaction.create({
    data: {
      userId,
      kind: 'ad_reward',
      bucket,
      amount: AD_REWARD_AMOUNT,
      source: 'bonus',
      meta: { reason: 'watched_rewarded_ad' }
    }
  })

  return { balance, grantedToday: grantedToday + 1, dailyLimit: AD_REWARD_DAILY_LIMIT }
}

module.exports = {
  getOrCreateCredits,
  getBalance,
  consumeCredit,
  checkCredit,
  refundCredit,
  grantBonusCredits,
  grantSignupBonus,
  grantRecruiterBonus,
  grantAdRewardCredit,
  validateRecruiterHiringCredits,
  getTransactionHistory,
  CREDIT_COST,
  PURCHASED_CREDIT_VALID_DAYS,
  AD_REWARD_DAILY_LIMIT
}
