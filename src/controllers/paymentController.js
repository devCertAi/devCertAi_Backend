 

const crypto = require('crypto')
const prisma = require('../config/database')
const { getRazorpay } = require('../config/razorpay')
const { ApiError } = require('../utils/ApiError')
const { ApiResponse } = require('../utils/ApiResponse')
const asyncHandler = require('../utils/asyncHandler')
const queues = require('../queues')
const { defaultOpts } = queues
const { PLAN_PRICES, PLAN_DURATIONS, PLAN_CREDITS } = require('../validators/paymentValidators')
const creditService = require('../services/creditService')
 
async function applyPaymentSuccess(orderId, paymentId) {
  const payment = await prisma.payment.findUnique({ where: { razorpayOrderId: orderId } })
  if (!payment || payment.status === 'paid') return payment

  const durationDays = PLAN_DURATIONS[payment.plan] || 30
  const expiresAt = new Date(Date.now() + durationDays * 24 * 60 * 60 * 1000)

  await prisma.$transaction([
    prisma.payment.update({
      where: { razorpayOrderId: orderId },
      data: { status: 'paid', razorpayPaymentId: paymentId }
    }),
    // isPremium/premiumExpiresAt now just unlock cosmetic perks (no ads,
    // full report, priority queue, higher re-eval cap) — every plan gets it
    // for the life of its credits, but it never bypasses credit checks.
    prisma.user.update({
      where: { id: payment.userId },
      data: { isPremium: true, premiumExpiresAt: expiresAt, premiumPlan: payment.plan }
    })
  ])

  // Grant the plan's credit bundle (STACKING — adds to existing balance,
  // expiry extends to the farthest date). Sized to cover real AI token
  // spend for that plan's price — see PLAN_CREDITS for the numbers.
  const bundle = PLAN_CREDITS[payment.plan]
  if (bundle) {
    await creditService.grantBonusCredits(payment.userId, {
      project: bundle.project,
      skill: bundle.skill,
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

  const razorpay = getRazorpay()
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
//
// Route is mounted with express.raw({ type: 'application/json' }), so
// req.body here is the raw request Buffer (not a parsed object) — that's
// required because the HMAC must be computed over the exact raw bytes
// Razorpay sent, not a re-serialized JSON string.
//
// The webhook secret is optional to configure: payments still get applied
// via the client-side /verify call after checkout succeeds. The webhook is
// a defense-in-depth backup for cases where the client never calls /verify
// (tab closed, network drop, etc). Until RAZORPAY_WEBHOOK_SECRET is set in
// Razorpay Dashboard → Settings → Webhooks, this endpoint just no-ops
// instead of crashing.
const webhook = asyncHandler(async (req, res) => {
  if (!process.env.RAZORPAY_WEBHOOK_SECRET) {
    console.warn('[webhook] RAZORPAY_WEBHOOK_SECRET not set — ignoring webhook call. ' +
      'Payments still work via /verify; set the secret to enable this backup path.')
    return res.status(200).json({ received: false, reason: 'webhook_secret_not_configured' })
  }

  const signature = req.headers['x-razorpay-signature']
  const rawBody = req.body // Buffer — do NOT JSON.stringify this, it must be the exact raw bytes

  const expected = crypto
    .createHmac('sha256', process.env.RAZORPAY_WEBHOOK_SECRET)
    .update(rawBody)
    .digest('hex')

  if (expected !== signature) {
    return res.status(400).json({ success: false })
  }

  const event = JSON.parse(rawBody.toString('utf8'))
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