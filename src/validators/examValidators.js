const { z } = require('zod')

const DOMAINS = ['Frontend', 'Backend', 'Full Stack', 'Mobile', 'Data Science', 'DevOps']

const startExamSchema = z.object({
  domain: z.enum(DOMAINS),
  phase: z.number().int().min(1).max(2)
})

const startDemoExamSchema = z.object({
  domain: z.enum(DOMAINS)
})

const submitAnswerSchema = z.object({
  questionIndex: z.number().int().min(0),
  answer: z.string().min(1)
})

const violationSchema = z.object({
  type: z.string().min(1),
  timestamp: z.string()
})

module.exports = { startExamSchema, startDemoExamSchema, submitAnswerSchema, violationSchema }
