const nodemailer = require('nodemailer')

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT) || 587,
  secure: process.env.SMTP_SECURE === 'true', // true for port 465, false for 587/25
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS
  }
})

if (!process.env.SMTP_USER || !process.env.SMTP_PASS) {
  console.warn('[Email] SMTP_USER/SMTP_PASS not set — email sending is disabled until configured.')
} else {
  transporter.verify((err) => {
    if (err) {
      console.error('[Email] SMTP transporter verification failed:', err.message)
    } else {
      console.log('[Email] SMTP transporter ready')
    }
  })
}

module.exports = transporter