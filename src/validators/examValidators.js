const { z } = require('zod')
const {
  DOMAINS,
  ALL_CATEGORIES,
  DIFFICULTIES,
  MIN_QUESTIONS,
  MAX_QUESTIONS,
  PHASE2_MIN_QUESTIONS,
  PHASE2_MAX_QUESTIONS,
  isValidCategoryForDomain,
} = require('../config/examCategories')

// Phase 1 requires a technology category + difficulty + question count.
// Phase 2 is project-based (GitHub repo / ZIP upload analysis) — no category,
// but difficulty + questionCount still apply (they control how many
// AI-generated questions the candidate gets and how deep they probe).
// Bounds differ per phase (Phase 1: 10-50 MCQs, Phase 2: 3-10 written answers),
// so questionCount is validated in a phase-aware refine below rather than a
// single min/max on the field itself.
const startExamSchema = z
  .object({
    domain: z.enum(DOMAINS),
    phase: z.number().int().min(1).max(2),
    category: z.enum(ALL_CATEGORIES).optional(),
    difficulty: z.enum(DIFFICULTIES).optional().default('medium'),
    questionCount: z.number().int().optional(),
  })
  .refine(
    (data) => data.phase !== 1 || isValidCategoryForDomain(data.domain, data.category),
    {
      message: 'Please select a valid technology category for this domain',
      path: ['category'],
    }
  )
  .refine(
    (data) => {
      if (data.questionCount === undefined) return true
      const [min, max] = data.phase === 1 ? [MIN_QUESTIONS, MAX_QUESTIONS] : [PHASE2_MIN_QUESTIONS, PHASE2_MAX_QUESTIONS]
      return data.questionCount >= min && data.questionCount <= max
    },
    {
      message: 'Question count out of range for this phase',
      path: ['questionCount'],
    }
  )

const startDemoExamSchema = z.object({
  domain: z.enum(DOMAINS),
  category: z.enum(ALL_CATEGORIES).optional(),
})

const submitAnswerSchema = z.object({
  questionIndex: z.number().int().min(0),
  answer: z.string().min(1),
})

const violationSchema = z.object({
  type: z.string().min(1),
  timestamp: z.string(),
})

module.exports = {
  startExamSchema,
  startDemoExamSchema,
  submitAnswerSchema,
  violationSchema,
}