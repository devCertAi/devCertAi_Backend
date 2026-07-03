/**
 * controllers/recruiterSettingsController.js
 *
 * Handles settings operations for recruiters:
 *   PUT    /recruiter/settings/profile         — update name
 *   POST   /recruiter/settings/change-email/send-otp    — send OTP to new email
 *   POST   /recruiter/settings/change-email/verify-otp  — verify OTP & update email
 *   PUT    /recruiter/settings/change-password  — change password
 *   DELETE /recruiter/settings/account          — delete recruiter account
 */

const bcrypt         = require('bcryptjs')
const prisma         = require('../config/database')
const { ApiError }   = require('../utils/ApiError')
const { ApiResponse } = require('../utils/ApiResponse')
const asyncHandler   = require('../utils/asyncHandler')
const { safeRedis }  = require('../config/redis')
const emailService   = require('../services/emailService')
const { CLEAR_COOKIE_OPTS } = require('../utils/tokenUtils')

const OTP_TTL          = 60 * 10       // 10 minutes
const OTP_MAX_ATTEMPTS = 5
const RESEND_COOLDOWN  = 60            // 1 minute between resends

// ── OTP helpers (mirrors recruiterAuthController pattern) ─────────────────────

function generateOtp() {
  return String(Math.floor(100000 + Math.random() * 900000))
}

function emailChangeKey(recruiterId) {
  return `recruiter:email-change:otp:${recruiterId}`
}

async function storeEmailChangeOtp(recruiterId, newEmail, otp) {
  const key       = emailChangeKey(recruiterId)
  const expiresAt = new Date(Date.now() + OTP_TTL * 1000)
  const value     = JSON.stringify({ otp, newEmail, attempts: 0, expiresAt: expiresAt.toISOString() })

  // Redis primary
  const ok = await safeRedis.set(key, value, 'EX', OTP_TTL)

  // DB fallback — upsert so repeated send-otp overwrites
  await prisma.otpStore.upsert({
    where:  { key },
    create: { key, value, expiresAt },
    update: { value, expiresAt },
  })

  return ok
}

async function verifyEmailChangeOtp(recruiterId, newEmail, inputOtp) {
  const key = emailChangeKey(recruiterId)

  let data
  let fromDb = false

  const raw = await safeRedis.get(key)
  if (raw) {
    data = JSON.parse(raw)
  } else {
    const record = await prisma.otpStore.findUnique({ where: { key } })
    if (!record) throw new ApiError(400, 'OTP expired or not found. Please request a new one.')
    if (record.expiresAt < new Date()) {
      await prisma.otpStore.delete({ where: { key } })
      throw new ApiError(400, 'OTP expired. Please request a new one.')
    }
    data   = JSON.parse(record.value)
    fromDb = true
  }

  if (data.newEmail !== newEmail) throw new ApiError(400, 'Email mismatch. Please request a new OTP.')

  if (data.attempts >= OTP_MAX_ATTEMPTS) {
    fromDb
      ? await prisma.otpStore.delete({ where: { key } })
      : await safeRedis.del(key)
    throw new ApiError(429, 'Too many incorrect attempts. Please request a new OTP.')
  }

  if (data.otp !== inputOtp) {
    // Increment attempts
    data.attempts += 1
    const updated = JSON.stringify(data)
    if (fromDb) {
      await prisma.otpStore.update({ where: { key }, data: { value: updated } })
    } else {
      const ttl = await safeRedis.ttl(key)
      if (ttl > 0) await safeRedis.set(key, updated, 'EX', ttl)
    }
    throw new ApiError(400, `Incorrect OTP. ${OTP_MAX_ATTEMPTS - data.attempts} attempts remaining.`)
  }

  // ✅ Valid — clean up
  fromDb
    ? await prisma.otpStore.delete({ where: { key } })
    : await safeRedis.del(key)
}

// ── PUT /recruiter/settings/profile ──────────────────────────────────────────

const updateProfile = asyncHandler(async (req, res) => {
  const { name } = req.body
  if (!name || !name.trim()) throw new ApiError(400, 'Name is required')

  const recruiter = await prisma.recruiter.update({
    where: { id: req.user.id },
    data:  { name: name.trim() },
    select: { id: true, name: true, email: true },
  })

  return res.json(new ApiResponse(200, { recruiter }, 'Profile updated'))
})

// ── POST /recruiter/settings/change-email/send-otp ───────────────────────────

const sendEmailChangeOtp = asyncHandler(async (req, res) => {
  const { newEmail } = req.body
  if (!newEmail) throw new ApiError(400, 'New email is required')

  const normalized = newEmail.toLowerCase().trim()

  // Must differ from current
  const recruiter = await prisma.recruiter.findUnique({ where: { id: req.user.id } })
  if (recruiter.email === normalized) throw new ApiError(400, 'New email must differ from current email')

  // Check not already taken
  const taken = await prisma.recruiter.findUnique({ where: { email: normalized } })
  if (taken) throw new ApiError(409, 'This email is already in use by another account')

  // Resend cooldown — check existing OTP timestamp
  const existing = await safeRedis.get(emailChangeKey(req.user.id))
  if (existing) {
    const data      = JSON.parse(existing)
    const remaining = Math.ceil((new Date(data.expiresAt).getTime() - Date.now()) / 1000)
    if (remaining > OTP_TTL - RESEND_COOLDOWN) {
      throw new ApiError(429, `Please wait ${RESEND_COOLDOWN} seconds before requesting another OTP`)
    }
  }

  const otp = generateOtp()
  await storeEmailChangeOtp(req.user.id, normalized, otp)

  // Send email — reuse the existing recruiter OTP email template
  await emailService.sendRecruiterOtpEmail(
    { name: recruiter.name, email: normalized },
    otp,
    'email_change'    // you may want a dedicated purpose string/template
  )

  return res.json(new ApiResponse(200, { email: normalized }, 'OTP sent to new email address'))
})

// ── POST /recruiter/settings/change-email/verify-otp ─────────────────────────

const verifyEmailChangeOtpHandler = asyncHandler(async (req, res) => {
  const { newEmail, otp } = req.body
  if (!newEmail || !otp) throw new ApiError(400, 'newEmail and otp are required')

  const normalized = newEmail.toLowerCase().trim()

  await verifyEmailChangeOtp(req.user.id, normalized, otp)

  // Re-check uniqueness (race condition guard)
  const taken = await prisma.recruiter.findUnique({ where: { email: normalized } })
  if (taken && taken.id !== req.user.id) throw new ApiError(409, 'Email already taken')

  const recruiter = await prisma.recruiter.update({
    where: { id: req.user.id },
    data:  { email: normalized, isEmailVerified: true },
    select: { id: true, name: true, email: true },
  })

  return res.json(new ApiResponse(200, { recruiter }, 'Email updated successfully'))
})

// ── PUT /recruiter/settings/change-password ───────────────────────────────────

const changePassword = asyncHandler(async (req, res) => {
  const { oldPassword, newPassword } = req.body
  if (!oldPassword || !newPassword) throw new ApiError(400, 'Old and new passwords are required')
  if (newPassword.length < 8) throw new ApiError(400, 'New password must be at least 8 characters')

  const recruiter = await prisma.recruiter.findUnique({ where: { id: req.user.id } })
  if (!recruiter.password) throw new ApiError(400, 'Your account has no password set')

  const isMatch = await bcrypt.compare(oldPassword, recruiter.password)
  if (!isMatch) throw new ApiError(400, 'Current password is incorrect')

  const hashed = await bcrypt.hash(newPassword, 12)
  await prisma.recruiter.update({ where: { id: req.user.id }, data: { password: hashed } })

  return res.json(new ApiResponse(200, {}, 'Password changed successfully'))
})

// ── DELETE /recruiter/settings/account ────────────────────────────────────────

const deleteAccount = asyncHandler(async (req, res) => {
  const recruiterId = req.user.id

  // Cascade: delete job postings, applications, company, then recruiter
  // Adjust to your actual Prisma schema relations / onDelete settings
  await prisma.$transaction(async (tx) => {
    // Delete applications linked to this recruiter's postings
    await tx.application.deleteMany({
      where: { jobPosting: { recruiterId } },
    })
    // Delete postings
    await tx.jobPosting.deleteMany({ where: { recruiterId } })
    // Delete company
    await tx.company.deleteMany({ where: { recruiterId } })
    // Delete recruiter
    await tx.recruiter.delete({ where: { id: recruiterId } })
  })

  res.clearCookie('recruiterRefreshToken', CLEAR_COOKIE_OPTS)
  return res.json(new ApiResponse(200, {}, 'Recruiter account deleted'))
})

module.exports = {
  updateProfile,
  sendEmailChangeOtp,
  verifyEmailChangeOtpHandler,
  changePassword,
  deleteAccount,
}