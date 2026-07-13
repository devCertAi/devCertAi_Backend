const crypto = require('crypto')

function generateVerificationId() {
  return crypto.randomBytes(16).toString('hex')
}

function generateToken() {
  return crypto.randomBytes(32).toString('hex')
}

function generateUsername(name) {
  const base = name.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 12) || 'user'
  const suffix = Math.floor(1000 + Math.random() * 9000)
  return `${base}${suffix}`
}

module.exports = { generateVerificationId, generateToken, generateUsername }
