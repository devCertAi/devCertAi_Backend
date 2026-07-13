const { z } = require('zod')

const DOMAINS = ['Frontend', 'Backend', 'Full Stack', 'Mobile', 'Data Science', 'DevOps']

const submitProjectSchema = z.object({
  title: z.string().min(3, 'Title must be at least 3 characters').max(100),
  description: z.string().max(1000).optional(),
  githubUrl: z.string().url().optional(),
  liveUrl: z.string().url().optional(),
  domain: z.enum(['Frontend', 'Backend', 'Full Stack', 'Mobile', 'Data Science', 'DevOps'], {
    errorMap: () => ({ message: 'Invalid domain' })
  })
})

module.exports = { submitProjectSchema, DOMAINS }