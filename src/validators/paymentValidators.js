const { z } = require('zod')

const PLANS = ['monthly', 'yearly', 'recruiter']

const createOrderSchema = z.object({
  plan: z.enum(PLANS, { errorMap: () => ({ message: 'Invalid plan' }) })
})

const verifyPaymentSchema = z.object({
  razorpayOrderId: z.string().min(1),
  razorpayPaymentId: z.string().min(1),
  razorpaySignature: z.string().min(1)
})

const PLAN_PRICES = {
  monthly:   29900,
  yearly:    249900,
  recruiter: 99900
}

const PLAN_DURATIONS = {
  monthly:   30,
  yearly:    365,
  recruiter: 30
}

module.exports = { createOrderSchema, verifyPaymentSchema, PLANS, PLAN_PRICES, PLAN_DURATIONS }
