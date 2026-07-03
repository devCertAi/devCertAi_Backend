/**
 * creditService.js — Unified credit management
 *
 * CREDIT RULES:
 * - Free monthly allowance: 3 project evals + 1 skill exam / month
 * - Purchased credits stack on top (never overwrite), valid 6 months
 * - Signup bonus: 1 skill exam + 1 project eval (new users)
 * - Recruiter free credits: 50 project + 20 skill (on recruiter plan purchase)
 * - If credits are re-bought, new ones stack on existing balance, expiry extends
 * - Exam 1 (Phase 1) costs 1 skill credit; Exam 2 (Phase 2) costs 1 skill credit
 * - Project evaluation costs 1 project credit
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
 * Premium users get unlimited = true flag (no actual credit deduction).
 */
const getBalance = async (userId, { isPremium = false } = {}) => {
  const record = await getOrCreateCredits(userId)
  const balance = toBalance(record)

  if (isPremium) {
    return {
      ...balance,
      unlimited: true,
      skill: { ...balance.skill, remaining: Infinity },
      project: { ...balance.project, remaining: Infinity }
    }
  }

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
 * Consume 1 credit from the given bucket.
 * Throws 402 with CREDITS_EXHAUSTED code if none remain.
 * Free monthly credits are consumed first; bonus credits are used as overflow.
 */
const consumeCredit = async (userId, bucket, meta = {}) => {
  const fields = BUCKET_FIELDS[bucket]
  if (!fields) throw new Error(`Unknown credit bucket: ${bucket}`)

  const record = await getOrCreateCredits(userId)

  const used = record[fields.used]
  const limit = record[fields.limit]
  const bonus = record[fields.bonus]
  const freeRemaining = Math.max(0, limit - used)

  if (freeRemaining <= 0 && bonus <= 0) {
    const balance = toBalance(record)
    throw new ApiError(402, `Not enough ${bucket === 'project' ? 'project evaluation' : 'exam'} credits`, [{
      code: 'CREDITS_EXHAUSTED',
      bucket,
      balance,
      locked: true,
      upgradeUrl: '/pricing',
      nextResetAt: record.cycleResetAt,
      bonusExpiresAt: record.bonusExpiresAt
    }])
  }

  const useFree = freeRemaining > 0
  const data = useFree
    ? { [fields.used]: used + 1 }
    : { [fields.bonus]: bonus - 1 }

  const updated = await prisma.userCredits.update({ where: { userId }, data })

  await prisma.creditTransaction.create({
    data: {
      userId,
      kind: KIND_BY_BUCKET[bucket],
      bucket,
      amount: -1,
      source: useFree ? 'free' : 'bonus',
      [fields.balanceKey]: toBalance(updated)[bucket].remaining,
      meta
    }
  })

  return toBalance(updated)
}

/**
 * Check credit availability without consuming. Returns { canProceed, balance }.
 */
const checkCredit = async (userId, bucket) => {
  const record = await getOrCreateCredits(userId)
  const fields = BUCKET_FIELDS[bucket]
  const used = record[fields.used]
  const limit = record[fields.limit]
  const bonus = record[fields.bonus]
  const freeRemaining = Math.max(0, limit - used)
  const canProceed = freeRemaining > 0 || bonus > 0
  return { canProceed, balance: toBalance(record) }
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
