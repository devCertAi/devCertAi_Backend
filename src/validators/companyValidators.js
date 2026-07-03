const { z } = require('zod')

const createCompanySchema = z.object({
  name: z.string().min(2).max(150),
  website: z.string().url().optional().or(z.literal('')),
  logo: z.string().url().optional().or(z.literal('')),
  industry: z.string().max(80).optional(),
  size: z.enum(['1-10', '11-50', '51-200', '201-1000', '1000+']).optional(),
  description: z.string().max(2000).optional()
})

const updateCompanySchema = createCompanySchema.partial()

const submitVerificationSchema = z.object({
  verificationDocUrl: z.string().url().optional().or(z.literal(''))
})

const verifyCompanySchema = z.object({
  approve: z.boolean(),
  note: z.string().max(1000).optional()
})

module.exports = { createCompanySchema, updateCompanySchema, submitVerificationSchema, verifyCompanySchema }
