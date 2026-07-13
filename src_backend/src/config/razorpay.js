const Razorpay = require('razorpay')

// Lazy load Razorpay — only initializes when payments are actually used
function getRazorpay() {
  const Razorpay = require('razorpay')

  if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET) {
    console.warn(
      '[razorpay] RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET not set — falling back to ' +
      'dummy test credentials. Order creation will fail against the real Razorpay ' +
      'API. Set both in your .env to accept real payments.'
    )
  }

  return new Razorpay({
    key_id:     process.env.RAZORPAY_KEY_ID     || 'rzp_test_dummy',
    key_secret: process.env.RAZORPAY_KEY_SECRET || 'dummy_secret'
  })
}

module.exports = { getRazorpay }

