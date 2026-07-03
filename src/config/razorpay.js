const Razorpay = require('razorpay')

// Lazy load Razorpay — only initializes when payments are actually used
function getRazorpay() {
  const Razorpay = require('razorpay')
  return new Razorpay({
    key_id:     process.env.RAZORPAY_KEY_ID     || 'rzp_test_dummy',
    key_secret: process.env.RAZORPAY_KEY_SECRET || 'dummy_secret'
  })
}

module.exports = { getRazorpay }

