const { z } = require('zod')

const registerSchema = z.object({
  name: z.string().min(2, 'Name must be at least 2 characters').max(50),
  email: z.string().email('Invalid email address'),
  password: z
    .string()
    .min(8, 'Password must be at least 8 characters')
    .regex(/[A-Z]/, 'Password must contain at least one uppercase letter')
    .regex(/[0-9]/, 'Password must contain at least one number')
})

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1, 'Password is required')
})

const forgotPasswordSchema = z.object({
  email: z.string().email()
})

const resetPasswordSchema = z.object({
  password: z
    .string()
    .min(8)
    .regex(/[A-Z]/, 'Password must contain at least one uppercase letter')
    .regex(/[0-9]/, 'Password must contain at least one number')
})

const googleAuthSchema = z.object({
  accessToken: z.string().min(1)   // was: idToken
})

const resendVerificationSchema = z.object({
  email: z.string().email()
})

// Recruiter registration is validated separately in
// validators/recruiterAuthValidators.js (used by the OTP-based
// /auth/recruiter/register/* flow against the `Recruiter` table).

module.exports = { registerSchema, loginSchema, forgotPasswordSchema, resetPasswordSchema, googleAuthSchema, resendVerificationSchema }