const express = require('express')
const router = express.Router()
const auth = require('../middleware/userAuth')
const validate = require('../middleware/validate')
const { createOrderSchema, verifyPaymentSchema } = require('../validators/paymentValidators')
const { createOrder, verifyPayment, webhook, getPaymentHistory } = require('../controllers/paymentController')

router.post('/create-order',  auth, validate(createOrderSchema), createOrder)
router.post('/verify',        auth, validate(verifyPaymentSchema), verifyPayment)
router.post('/webhook',       express.raw({ type: 'application/json' }), webhook)
router.get('/history',        auth, getPaymentHistory)

module.exports = router
