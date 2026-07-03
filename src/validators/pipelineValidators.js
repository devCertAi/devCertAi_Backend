const { z } = require('zod')

const skillRefSchema = z.object({
  name: z.string().min(1).max(60),
  required: z.boolean().optional().default(true)
})

const scoringWeightsSchema = z.object({
  ruleScore:    z.number().min(0).max(100).optional(),
  aiMatchScore: z.number().min(0).max(100).optional(),
  projectScore: z.number().min(0).max(100).optional(),
  examScore:    z.number().min(0).max(100).optional()
}).optional()

const EXAM_DOMAINS = ['Frontend', 'Backend', 'Full Stack', 'Mobile', 'Data Science', 'DevOps', 'Blockchain', 'AI/ML']

const createJobPostingSchema = z.object({
  title:            z.string().min(3).max(150),
  description:      z.string().min(10).max(5000),
  companyName:      z.string().min(1).max(150).optional(),
  requiredSkills:   z.array(skillRefSchema).min(1, 'At least one skill required'),
  minExperience:    z.number().int().min(0).max(40).optional().default(0),
  openings:         z.number().int().min(1).max(1000).optional().default(1),
  cutoffMode:       z.enum(['count', 'percentage']).optional().default('count'),
  cutoffPercentage: z.number().int().min(1).max(100).optional(),

  // Screening thresholds
  ruleScoreThreshold: z.number().int().min(0).max(100).optional().default(60),
  aiMatchThreshold:   z.number().int().min(0).max(100).optional().default(50),

  // Assignment — two separate fields
  assignmentEnabled:      z.boolean().optional().default(false),
  assignmentBrief:        z.string().max(5000).optional(),   // student sees this
  assignmentEvalCriteria: z.string().max(5000).optional(),   // private, recruiter only
  // Deadline as absolute date (ISO string), must be > now
  assignmentDeadlineDate: z.string().datetime({ offset: true }).optional()
    .refine(v => !v || new Date(v) > new Date(), {
      message: 'Assignment deadline must be in the future'
    }),
  assignmentDeadlineDays: z.number().int().min(1).max(60).optional(),

  // Exam
  examEnabled:     z.boolean().optional().default(true),
  examPhase1:      z.boolean().optional().default(true),
  examPhase2:      z.boolean().optional().default(false),
  examDomain:      z.enum(EXAM_DOMAINS).optional().default('Full Stack'),
  examDurationMin: z.number().int().min(5).max(180).optional().default(30),
  examWindowHours: z.number().int().min(1).max(168).optional().default(48),

  // Manual pipeline mode
  manualMode: z.boolean().optional().default(false),

  // Misc
  matchNotificationCap: z.number().int().min(0).max(2000).optional().default(200),
  scoringWeights:       scoringWeightsSchema,
  status:               z.enum(['active', 'closed', 'draft']).optional().default('draft')

}).superRefine((data, ctx) => {
  if (data.cutoffMode === 'percentage' && !data.cutoffPercentage) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['cutoffPercentage'],
      message: 'cutoffPercentage (1-100) is required when cutoffMode is "percentage"'
    })
  }
  if (data.assignmentEnabled && !data.assignmentBrief?.trim()) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['assignmentBrief'],
      message: 'Assignment brief (student-visible task) is required when assignment is enabled'
    })
  }
  if (data.examEnabled && data.examPhase2 && !data.examPhase1) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['examPhase2'],
      message: 'Phase 2 requires Phase 1 to be enabled'
    })
  }
})

const updateJobPostingSchema = z.object({
  title:            z.string().min(3).max(150).optional(),
  description:      z.string().min(10).max(5000).optional(),
  companyName:      z.string().min(1).max(150).optional(),
  requiredSkills:   z.array(skillRefSchema).optional(),
  minExperience:    z.number().int().min(0).max(40).optional(),
  openings:         z.number().int().min(1).max(1000).optional(),
  cutoffMode:       z.enum(['count', 'percentage']).optional(),
  cutoffPercentage: z.number().int().min(1).max(100).optional(),
  ruleScoreThreshold: z.number().int().min(0).max(100).optional(),
  aiMatchThreshold:   z.number().int().min(0).max(100).optional(),
  assignmentEnabled:      z.boolean().optional(),
  assignmentBrief:        z.string().max(5000).optional(),
  assignmentEvalCriteria: z.string().max(5000).optional(),
  assignmentDeadlineDate: z.string().datetime({ offset: true }).optional()
    .refine(v => !v || new Date(v) > new Date(), {
      message: 'Assignment deadline must be in the future'
    }),
  assignmentDeadlineDays: z.number().int().min(1).max(60).optional(),
  examEnabled:     z.boolean().optional(),
  examPhase1:      z.boolean().optional(),
  examPhase2:      z.boolean().optional(),
  examDomain:      z.enum(EXAM_DOMAINS).optional(),
  examDurationMin: z.number().int().min(5).max(180).optional(),
  examWindowHours: z.number().int().min(1).max(168).optional(),
  manualMode:      z.boolean().optional(),
  matchNotificationCap: z.number().int().min(0).max(2000).optional(),
  scoringWeights:       scoringWeightsSchema,
  status:               z.enum(['active', 'closed', 'draft']).optional()
})

const applySchema = z.object({
  coverNote: z.string().max(2000).optional()
})

const updateUserSkillsSchema = z.object({
  skills: z.array(z.object({
    name:  z.string().min(1).max(60),
    level: z.enum(['beginner', 'intermediate', 'advanced']).optional()
  }))
})

const submitAssignmentSchema = z.object({
  githubUrl:   z.string().url().optional(),
  liveUrl:     z.string().url().optional(),
  zipFileUrl:  z.string().url().optional(),
  title:       z.string().max(150).optional(),
  description: z.string().max(2000).optional(),
  domain:      z.enum([...EXAM_DOMAINS, 'Other']).optional()
}).refine(d => d.githubUrl || d.liveUrl || d.zipFileUrl, {
  message: 'At least one of githubUrl, liveUrl, or zipFileUrl is required'
})

const manualAdvanceSchema = z.object({
  targetStage: z.string().optional(),
  note:        z.string().max(1000).optional()
})

const manualRejectSchema = z.object({
  reason: z.string().max(1000).optional()
})

const sendReminderSchema = z.object({
  note: z.string().max(500).optional()
})

module.exports = {
  createJobPostingSchema,
  updateJobPostingSchema,
  applySchema,
  updateUserSkillsSchema,
  submitAssignmentSchema,
  manualAdvanceSchema,
  manualRejectSchema,
  sendReminderSchema,
  EXAM_DOMAINS
}
