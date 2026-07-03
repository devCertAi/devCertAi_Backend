/**
 * paymentController.js
 *
 * Handles Razorpay payment flow and credit grants on payment success.
 *
 * CREDIT GRANTS ON PAYMENT:
 * - monthly/yearly plans → set isPremium + premiumExpiresAt (unlocks premium features, ads-free)
 * - recruiter plan → 50 project + 20 skill credits, valid 6 months, STACKING
 *   If recruiter buys again before expiry: credits add on top, expiry extends
 */

const crypto = require('crypto')
const prisma = require('../config/database')
const razorpay = require('../config/razorpay')
const { ApiError } = require('../utils/ApiError')
const { ApiResponse } = require('../utils/ApiResponse')
const asyncHandler = require('../utils/asyncHandler')
const queues = require('../queues')
const { defaultOpts } = queues
const { PLAN_PRICES, PLAN_DURATIONS } = require('../validators/paymentValidators')
const creditService = require('../services/creditService')

// Recruiter plan bonus: stacking credits, 6 months validity
const RECRUITER_BONUS_CREDITS = {
  project: 50,
  skill: 20,
  validForDays: creditService.PURCHASED_CREDIT_VALID_DAYS  // 180 days
}

// Premium plans grant isPremium flag (no credit cost for premium-gated features)
const PREMIUM_PLANS = ['monthly', 'yearly']

/**
 * Apply payment success effects.
 * Called from both /verify (client-side) and /webhook (server-side).
 * Idempotent: checks payment.status !== 'paid' before applying.
 */
async function applyPaymentSuccess(orderId, paymentId) {
  const payment = await prisma.payment.findUnique({ where: { razorpayOrderId: orderId } })
  if (!payment || payment.status === 'paid') return payment

  const durationDays = PLAN_DURATIONS[payment.plan] || 30
  const expiresAt = new Date(Date.now() + durationDays * 24 * 60 * 60 * 1000)

  const isPremiumPlan = PREMIUM_PLANS.includes(payment.plan)

  await prisma.$transaction([
    prisma.payment.update({
      where: { razorpayOrderId: orderId },
      data: { status: 'paid', razorpayPaymentId: paymentId }
    }),
    prisma.user.update({
      where: { id: payment.userId },
      data: {
        ...(isPremiumPlan && {
          isPremium: true,
          premiumExpiresAt: expiresAt,
        })
      }
    })
  ])

  // Grant recruiter credits (STACKING — adds to existing balance)
  if (payment.plan === 'recruiter') {
    await creditService.grantBonusCredits(payment.userId, {
      project: RECRUITER_BONUS_CREDITS.project,
      skill: RECRUITER_BONUS_CREDITS.skill,
      validForDays: RECRUITER_BONUS_CREDITS.validForDays,
      reason: 'recruiter_plan_purchase'
    })
  }

  // For premium plans, also grant a small skill credit bundle
  if (isPremiumPlan) {
    const skillCredits = payment.plan === 'yearly' ? 12 : 2
    const projectCredits = payment.plan === 'yearly' ? 36 : 6
    await creditService.grantBonusCredits(payment.userId, {
      project: projectCredits,
      skill: skillCredits,
      validForDays: durationDays,
      reason: `${payment.plan}_plan_purchase`
    })
  }

  // Emit real-time event
  try {
    const { getIO } = require('../socket')
    const io = getIO()
    if (io) {
      io.to(`user:${payment.userId}`).emit('payment_confirmed', {
        plan: payment.plan,
        expiresAt,
        title: 'Plan Activated!',
        message: `Your ${payment.plan} plan is now active.`
      })
    }
  } catch {}

  return { ...payment, status: 'paid', expiresAt }
}

// POST /create-order
const createOrder = asyncHandler(async (req, res) => {
  const { plan } = req.body
  const amount = PLAN_PRICES[plan]
  if (!amount) throw new ApiError(400, 'Invalid plan')

  const receipt = `order_${req.user.id.slice(-8)}_${Date.now()}`

  const order = await razorpay.orders.create({ amount, currency: 'INR', receipt })

  await prisma.payment.create({
    data: {
      userId: req.user.id,
      razorpayOrderId: order.id,
      amount,
      plan,
      status: 'pending'
    }
  })

  return res.status(201).json(new ApiResponse(201, {
    orderId: order.id,
    amount,
    currency: 'INR',
    razorpayKeyId: process.env.RAZORPAY_KEY_ID
  }))
})

// POST /verify
const verifyPayment = asyncHandler(async (req, res) => {
  const { razorpayOrderId, razorpayPaymentId, razorpaySignature } = req.body

  const body = `${razorpayOrderId}|${razorpayPaymentId}`
  const expected = crypto
    .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
    .update(body)
    .digest('hex')

  if (expected !== razorpaySignature) {
    throw new ApiError(400, 'Invalid payment signature')
  }

  const result = await applyPaymentSuccess(razorpayOrderId, razorpayPaymentId)
  if (!result) throw new ApiError(404, 'Payment record not found')

  await queues.emailQueue.add({
    type: 'payment_confirmed',
    userId: result.userId,
    paymentId: result.id
  }, defaultOpts)

  // Return updated credits so frontend can update immediately
  const credits = await creditService.getBalance(result.userId)

  return res.json(new ApiResponse(200, {
    expiresAt: result.expiresAt,
    plan: result.plan,
    credits
  }, 'Payment verified. Plan activated!'))
})

// POST /webhook — Razorpay webhook (server-to-server, no signature check from client)
const webhook = asyncHandler(async (req, res) => {
  const signature = req.headers['x-razorpay-signature']
  const body = JSON.stringify(req.body)

  const expected = crypto
    .createHmac('sha256', process.env.RAZORPAY_WEBHOOK_SECRET)
    .update(body)
    .digest('hex')

  if (expected !== signature) {
    return res.status(400).json({ success: false })
  }

  const event = req.body
  if (event.event === 'payment.captured') {
    const orderId = event.payload.payment.entity.order_id
    const paymentId = event.payload.payment.entity.id
    await applyPaymentSuccess(orderId, paymentId).catch(err => {
      console.error('[webhook] applyPaymentSuccess failed:', err.message)
    })
  }

  return res.json({ received: true })
})

// GET /history
const getPaymentHistory = asyncHandler(async (req, res) => {
  const payments = await prisma.payment.findMany({
    where: { userId: req.user.id },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true, amount: true, currency: true, status: true,
      plan: true, createdAt: true, razorpayPaymentId: true
    }
  })
  return res.json(new ApiResponse(200, { payments }))
})

module.exports = { createOrder, verifyPayment, webhook, getPaymentHistory }
