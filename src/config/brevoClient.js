const axios = require('axios')

// Sends email via Brevo's HTTP API (port 443) instead of raw SMTP.
//
// WHY: many hosts (Render, Railway, some DigitalOcean setups, etc.) block
// or silently drop outbound connections on SMTP ports (25/465/587),
// especially on free/starter tiers. That produces exactly the symptom we
// saw: "Connection timeout" in production while everything works locally.
// The HTTP API rides over normal HTTPS traffic, which these hosts never
// block, so it sidesteps the problem entirely instead of fighting it.
const brevoHttp = axios.create({
  baseURL: 'https://api.brevo.com/v3',
  timeout: 10000,
  headers: {
    'api-key': process.env.BREVO_API_KEY,
    'content-type': 'application/json',
    accept: 'application/json',
  },
})

async function sendTransactionalEmail({ to, subject, html, fromEmail, fromName = 'Proeva' }) {
  return brevoHttp.post('/smtp/email', {
    sender: { email: fromEmail, name: fromName },
    to: [{ email: to }],
    subject,
    htmlContent: html,
  })
}

module.exports = { sendTransactionalEmail }
