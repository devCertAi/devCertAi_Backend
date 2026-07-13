const { z } = require('zod')

/**
 * PLANS — student-friendly, credit-pack pricing.
 *
 * No plan grants "unlimited" project evaluations or exams anymore — every
 * plan (including the paid ones) grants a fixed, generous number of
 * project + skill credits. This keeps AI token spend bounded and covered
 * by the price paid, no matter how heavily a single account is used.
 *
 * 'starter' / 'growth' / 'pro' are low-cost student packs (₹9 / ₹29 / ₹59).
 * 'recruiter' stays a separate, higher-volume B2B pack.
 */
const PLANS = ['starter', 'growth', 'pro', 'recruiter']

const createOrderSchema = z.object({
  plan: z.enum(PLANS, { errorMap: () => ({ message: 'Invalid plan' }) })
})

const verifyPaymentSchema = z.object({
  razorpayOrderId: z.string().min(1),
  razorpayPaymentId: z.string().min(1),
  razorpaySignature: z.string().min(1)
})

// Prices in paise (Razorpay expects the smallest currency unit).
const PLAN_PRICES = {
  starter:   900,     // ₹9
  growth:    2900,    // ₹29
  pro:       5900,    // ₹59
  recruiter: 99900    // ₹999
}

// How long the credits granted by each plan stay valid (days).
const PLAN_DURATIONS = {
  starter:   30,
  growth:    45,
  pro:       60,
  recruiter: 180
}

/**
 * Credits granted per plan purchase. Credits STACK on top of any existing
 * balance (see creditService.grantBonusCredits) rather than replacing it.
 *
 * Sizing rationale: the eval pipeline runs on low-cost models (mistral-small
 * / gpt-4o-mini / claude-3-haiku tier — see ai/aiProvider.js) at roughly a
 * few paise per project/exam credit, so these bundles leave comfortable
 * margin over real AI token spend while still being priced for students.
 */
const PLAN_CREDITS = {
  starter:   { project: 3,  skill: 2 },
  growth:    { project: 10, skill: 6 },
  pro:       { project: 22, skill: 14 },
  recruiter: { project: 50, skill: 20 }
}

module.exports = {
  createOrderSchema,
  verifyPaymentSchema,
  PLANS,
  PLAN_PRICES,
  PLAN_DURATIONS,
  PLAN_CREDITS
}
