const { z } = require('zod')
const {
  DOMAINS,
  DIFFICULTIES,
  MIN_QUESTIONS,
  MAX_QUESTIONS,
  PHASE2_MIN_QUESTIONS,
  PHASE2_MAX_QUESTIONS,
} = require('../config/examCategories')

// `category` (technology sub-domain, e.g. "React", "HTML & CSS") is a
// free-form non-empty string rather than a fixed z.enum(ALL_CATEGORIES).
// Sub-domains are now sourced dynamically from whatever actually has active
// questions in QuestionBankStats (see examController.getDomains /
// questionStatsService), not from the static EXAM_CATEGORIES config — so any
// real, DB-backed category name must not be rejected here before it ever
// reaches examService's DB-aware lookup/fallback logic. (Frontend/Full
// Stack's HTML and CSS questions are seeded under one merged 'HTML & CSS'
// category — see prisma/seed.js — rather than two separate ones.)
const categoryField = z.string().trim().min(1).max(100)

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
    category: categoryField.optional(),
    difficulty: z.enum(DIFFICULTIES).optional().default('medium'),
    questionCount: z.number().int().optional(),
  })
  .refine(
    (data) => data.phase !== 1 || !!data.category,
    {
      message: 'Please select a technology category for this domain',
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
  category: categoryField.optional(),
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