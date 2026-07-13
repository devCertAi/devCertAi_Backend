const prisma = require('../config/database')
const { ApiError } = require('../utils/ApiError')
const { ApiResponse } = require('../utils/ApiResponse')
const asyncHandler = require('../utils/asyncHandler')
const notificationService = require('../services/notificationService')
const queues = require('../queues')
const { defaultOpts } = queues
const { safeRedis } = require('../config/redis')
const { adjustStat, recomputeBucket, recomputeAll, getCategoryCountsForDomains } = require('../services/questionStatsService')
const { DOMAINS, EXAM_CATEGORIES, normalizeDomain, normalizeCategory } = require('../config/examCategories')

// GET /stats
const getStats = asyncHandler(async (req, res) => {
  const [userCount, projectCount, certCount, examCount, revenue, recruiterCount] = await Promise.all([
    prisma.user.count(),
    prisma.project.count(),
    prisma.certificate.count(),
    prisma.examAttempt.count({ where: { status: 'completed' } }),
    prisma.payment.aggregate({ where: { status: 'paid' }, _sum: { amount: true } }),
    prisma.recruiter.count()
  ])

  const passedExams = await prisma.examAttempt.count({
    where: { status: 'completed', totalScore: { gte: 50 } }
  })

  // G5 — recruiting analytics
  const [
    totalCompanies, verifiedCompanies, pendingVerifications,
    activePostingsCount, totalApplications, totalHired
  ] = await Promise.all([
    prisma.company.count(),
    prisma.company.count({ where: { verificationStatus: 'verified' } }),
    prisma.company.count({ where: { verificationStatus: 'pending' } }),
    prisma.jobPosting.count({ where: { status: 'active' } }),
    prisma.application.count(),
    prisma.application.count({ where: { status: 'selected' } })
  ])

  const [totalInProgress, allRejectedApps] = await Promise.all([
    prisma.application.count({ where: { status: 'in_progress' } }),
    prisma.application.findMany({
      where: { status: 'rejected' },
      select: { missingSkills: true }
    })
  ])

  const avgConversionRate = totalApplications > 0
    ? Math.round((totalHired / totalApplications) * 100 * 10) / 10
    : 0

  const skillCounts = {}
  for (const app of allRejectedApps) {
    for (const skill of (app.missingSkills || [])) {
      skillCounts[skill] = (skillCounts[skill] || 0) + 1
    }
  }
  const topMissingSkillsPlatformWide = Object.entries(skillCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([skill, count]) => ({ skill, count }))

  return res.json(new ApiResponse(200, {
    userCount,
    projectCount,
    certCount,
    examCount,
    recruiterCount,
    passRate: examCount > 0 ? Math.round((passedExams / examCount) * 100) : 0,
    revenue: (revenue._sum.amount || 0) / 100,
    recruiting: {
      totalCompanies,
      verifiedCompanies,
      pendingVerifications,
      activePostingsCount,
      totalApplications,
      totalHired,
      avgConversionRate,
      topMissingSkillsPlatformWide
    }
  }))
})

// GET /users
const getUsers = asyncHandler(async (req, res) => {
  const { page = 1, limit = 20, search, role } = req.query
  const skip = (parseInt(page) - 1) * parseInt(limit)

  const where = {}
  if (search) {
    where.OR = [
      { name: { contains: search, mode: 'insensitive' } },
      { email: { contains: search, mode: 'insensitive' } },
      { username: { contains: search, mode: 'insensitive' } }
    ]
  }
  if (role) where.role = role

  const [users, total] = await Promise.all([
    prisma.user.findMany({
      where, skip, take: parseInt(limit),
      orderBy: { createdAt: 'desc' },
      select: {
        id: true, name: true, email: true, username: true, role: true,
        isPremium: true, isEmailVerified: true, createdAt: true,
        _count: { select: { projects: true, certificates: true } }
      }
    }),
    prisma.user.count({ where })
  ])

  return res.json(new ApiResponse(200, {
    users,
    pagination: { total, page: parseInt(page), limit: parseInt(limit), pages: Math.ceil(total / parseInt(limit)) }
  }))
})

// PUT /users/:id/role
const updateUserRole = asyncHandler(async (req, res) => {
  const { role } = req.body
  if (!['user', 'admin'].includes(role)) throw new ApiError(400, 'Invalid role')
  if (req.params.id === req.user.id) throw new ApiError(400, 'Cannot change your own role')

  const user = await prisma.user.update({
    where: { id: req.params.id },
    data: { role },
    select: { id: true, name: true, email: true, role: true }
  })


  // Bust stale auth cache so new role takes effect immediately (fixes 403 for newly promoted admins)
  await safeRedis.del(`user:auth:${req.params.id}`)

  return res.json(new ApiResponse(200, { user }, 'Role updated'))
})

// DELETE /users/:id
const banUser = asyncHandler(async (req, res) => {
  if (req.params.id === req.user.id) throw new ApiError(400, 'Cannot ban yourself')
  await prisma.user.delete({ where: { id: req.params.id } })
  return res.json(new ApiResponse(200, {}, 'User banned and deleted'))
})

// POST /questions
const addQuestion = asyncHandler(async (req, res) => {
  const { domain, phase, level, category, question, options, answer, type } = req.body

  if (!domain || !phase || !level || !category || !question || !answer || !type) {
    throw new ApiError(400, 'domain, phase, level, category, question, answer, and type are required')
  }

  // Normalize domain/category to their canonical spelling BEFORE writing.
  // This is the fix for questions silently landing in an invisible bucket
  // (e.g. "frontend" or "Programming" typed instead of the canonical
  // "Frontend" / "Programming Languages") — such a row would still exist in
  // QuestionBank, but questionStatsService's exact-match domain lookup would
  // never surface it, so the candidate-facing category picker showed
  // "No sections have questions available" despite the question existing.
  const normalizedDomain = normalizeDomain(domain)
  if (!normalizedDomain) {
    throw new ApiError(400, `Invalid domain "${domain}". Must be one of: ${DOMAINS.join(', ')}`)
  }
  const normalizedCategory = normalizeCategory(normalizedDomain, category)
  if (!normalizedCategory) {
    throw new ApiError(
      400,
      `Invalid category "${category}" for domain "${normalizedDomain}". Must be one of: ${(EXAM_CATEGORIES[normalizedDomain] || []).join(', ')}`
    )
  }

  const parsedPhase = parseInt(phase)

  const q = await prisma.questionBank.create({
    data: { domain: normalizedDomain, phase: parsedPhase, level, category: normalizedCategory, question, options: options || [], answer, type }
  })

  // Keep the pre-aggregated stats bucket in sync instead of ever COUNTing
  // QuestionBank live — see questionStatsService.js.
  await adjustStat(normalizedDomain, normalizedCategory, parsedPhase, level, +1)

  return res.status(201).json(new ApiResponse(201, { question: q }))
})

// GET /questions
const getQuestions = asyncHandler(async (req, res) => {
  const { domain, phase, level, page = 1, limit = 50 } = req.query
  const skip = (parseInt(page) - 1) * parseInt(limit)

  const where = {}
  if (domain) where.domain = domain
  if (phase) where.phase = parseInt(phase)
  if (level) where.level = level

  const [questions, total] = await Promise.all([
    prisma.questionBank.findMany({
      where, skip, take: parseInt(limit),
      orderBy: { createdAt: 'desc' }
    }),
    prisma.questionBank.count({ where })
  ])

  return res.json(new ApiResponse(200, {
    questions,
    pagination: { total, page: parseInt(page), limit: parseInt(limit), pages: Math.ceil(total / parseInt(limit)) }
  }))
})

// PUT /questions/:id
const updateQuestion = asyncHandler(async (req, res) => {
  const { question, options, answer, level, category, isActive } = req.body

  const existing = await prisma.questionBank.findUnique({ where: { id: req.params.id } })
  if (!existing) throw new ApiError(404, 'Question not found')

  const updated = await prisma.questionBank.update({
    where: { id: req.params.id },
    data: {
      ...(question && { question }),
      ...(options && { options }),
      ...(answer && { answer }),
      ...(level && { level }),
      ...(category && { category }),
      ...(isActive !== undefined && { isActive })
    }
  })

  // A question only counts toward a bucket while isActive — so a change to
  // level, category, or isActive can move it out of one bucket and/or into
  // another. Handle every combination explicitly rather than guessing.
  const wasCounted = existing.isActive
  const isCounted = updated.isActive
  const movedBucket = existing.level !== updated.level || existing.category !== updated.category

  if (wasCounted && !isCounted) {
    await adjustStat(existing.domain, existing.category, existing.phase, existing.level, -1)
  } else if (!wasCounted && isCounted) {
    await adjustStat(updated.domain, updated.category, updated.phase, updated.level, +1)
  } else if (wasCounted && isCounted && movedBucket) {
    await adjustStat(existing.domain, existing.category, existing.phase, existing.level, -1)
    await adjustStat(updated.domain, updated.category, updated.phase, updated.level, +1)
  }

  return res.json(new ApiResponse(200, { question: updated }))
})

// DELETE /questions/:id — soft delete
const deleteQuestion = asyncHandler(async (req, res) => {
  const existing = await prisma.questionBank.findUnique({ where: { id: req.params.id } })
  if (!existing) throw new ApiError(404, 'Question not found')

  await prisma.questionBank.update({
    where: { id: req.params.id },
    data: { isActive: false }
  })

  // Only decrement if it was actually counted before (an already-inactive
  // question being "deleted" again shouldn't double-decrement).
  if (existing.isActive) {
    await adjustStat(existing.domain, existing.category, existing.phase, existing.level, -1)
  }

  return res.json(new ApiResponse(200, {}, 'Question deactivated'))
})

// POST /questions/bulk-import
const bulkImportQuestions = asyncHandler(async (req, res) => {
  const { questions } = req.body
  if (!Array.isArray(questions) || questions.length === 0) {
    throw new ApiError(400, 'questions array is required')
  }

  // Normalize every row's domain/category to its canonical spelling BEFORE
  // writing — bulk import is the single most likely place for a batch of
  // rows to be silently mis-cased (e.g. a spreadsheet/CSV column that says
  // "frontend" or "Programming" instead of "Frontend" / "Programming
  // Languages"), which is exactly what produced buckets that existed in
  // QuestionBank but were invisible to the candidate-facing category picker
  // (see questionStatsService.getCategoryCountsForDomains). Reject the whole
  // import with a precise error rather than silently importing bad rows.
  const rejected = []
  const data = questions.map((q, i) => {
    const normalizedDomain = normalizeDomain(q.domain)
    if (!normalizedDomain) {
      rejected.push(`Row ${i + 1}: invalid domain "${q.domain}"`)
      return null
    }
    const normalizedCategory = normalizeCategory(normalizedDomain, q.category)
    if (!normalizedCategory) {
      rejected.push(`Row ${i + 1}: invalid category "${q.category}" for domain "${normalizedDomain}"`)
      return null
    }
    return {
      domain: normalizedDomain,
      category: normalizedCategory,
      phase: parseInt(q.phase),
      level: q.level,
      question: q.question,
      options: q.options || [],
      answer: q.answer,
      type: q.type || 'mcq'
    }
  })

  if (rejected.length > 0) {
    throw new ApiError(400, `Bulk import rejected — fix these rows and retry: ${rejected.join('; ')}`)
  }

  const result = await prisma.questionBank.createMany({ data, skipDuplicates: true })

  // skipDuplicates means we can't tell from result.count alone how many
  // landed in each bucket, so recompute the exact count for just the
  // buckets this import touched — a handful of scoped COUNT queries, not a
  // full-table scan, and this only happens on an admin bulk-import action.
  const buckets = new Map()
  for (const d of data) {
    if (!d.domain || !d.category || !d.level) continue
    buckets.set(`${d.domain}|${d.category}|${d.phase}|${d.level}`, d)
  }
  for (const d of buckets.values()) {
    await recomputeBucket(d.domain, d.category, d.phase, d.level)
  }

  return res.status(201).json(new ApiResponse(201, { created: result.count }, `${result.count} questions imported`))
})

// GET /questions/stats — the "separate table" of how many questions exist
// per domain/category/difficulty. Reads ONLY the small pre-aggregated
// QuestionBankStats table (no COUNT over QuestionBank), so this is cheap
// to call as often as the admin panel wants.
const getQuestionBankStats = asyncHandler(async (req, res) => {
  const counts = await getCategoryCountsForDomains(DOMAINS, 1)
  return res.json(new ApiResponse(200, { counts }))
})

// POST /questions/stats/recompute — rebuilds QuestionBankStats from the real
// QuestionBank table. Use this once after adding the QuestionBankStats model
// to an existing database (pre-existing questions were never counted since
// adjustStat only fires on new add/edit/delete actions going forward), or any
// time the numbers shown to candidates look wrong/stale. Safe to re-run any
// time — it's idempotent, just does a real GROUP BY, so don't wire it into a
// candidate-facing request path.
const recomputeQuestionBankStats = asyncHandler(async (req, res) => {
  const result = await recomputeAll()
  return res.json(new ApiResponse(200, result, 'Question bank stats recomputed'))
})

// GET /queues — Bull queue stats
const getQueueStats = asyncHandler(async (req, res) => {
  const { projectEvalQueue, examGradingQueue, certificateGenQueue, emailQueue } = require('../queues')

  const [projectStats, examStats, certStats, emailStats] = await Promise.all([
    Promise.all([
      projectEvalQueue.getWaitingCount(),
      projectEvalQueue.getActiveCount(),
      projectEvalQueue.getCompletedCount(),
      projectEvalQueue.getFailedCount()
    ]),
    Promise.all([
      examGradingQueue.getWaitingCount(),
      examGradingQueue.getActiveCount(),
      examGradingQueue.getCompletedCount(),
      examGradingQueue.getFailedCount()
    ]),
    Promise.all([
      certificateGenQueue.getWaitingCount(),
      certificateGenQueue.getActiveCount(),
      certificateGenQueue.getCompletedCount(),
      certificateGenQueue.getFailedCount()
    ]),
    Promise.all([
      emailQueue.getWaitingCount(),
      emailQueue.getActiveCount(),
      emailQueue.getCompletedCount(),
      emailQueue.getFailedCount()
    ])
  ])

  const fmt = ([waiting, active, completed, failed]) => ({ waiting, active, completed, failed })

  return res.json(new ApiResponse(200, {
    queues: {
      'project-evaluation': fmt(projectStats),
      'exam-grading': fmt(examStats),
      'certificate-generation': fmt(certStats),
      'email': fmt(emailStats)
    }
  }))
})

// GET /admin/companies?status=pending — paginated list of companies by verification status
const getCompanies = asyncHandler(async (req, res) => {
  const { page = 1, limit = 20, status } = req.query
  const skip = (parseInt(page) - 1) * parseInt(limit)

  const where = {}
  if (status) where.verificationStatus = status

  const [companies, total] = await Promise.all([
    prisma.company.findMany({
      where, skip, take: parseInt(limit),
      orderBy: { createdAt: 'desc' },
      include: {
        recruiter: { select: { name: true, email: true } },
        _count: { select: { jobPostings: true } }
      }
    }),
    prisma.company.count({ where })
  ])

  return res.json(new ApiResponse(200, {
    companies,
    pagination: { total, page: parseInt(page), limit: parseInt(limit), pages: Math.ceil(total / parseInt(limit)) }
  }))
})

// POST /admin/companies/:id/verify — body: { approve: boolean, note?: string }
const verifyCompany = asyncHandler(async (req, res) => {
  const { approve, note } = req.body

  const company = await prisma.company.findUnique({ where: { id: req.params.id } })
  if (!company) throw new ApiError(404, 'Company not found')

  const updated = await prisma.company.update({
    where: { id: req.params.id },
    data: approve
      ? { verificationStatus: 'verified', verifiedAt: new Date(), verifiedBy: req.user.id, verificationNote: null }
      : { verificationStatus: 'rejected', verificationNote: note || 'Your submission did not meet our verification requirements.' }
  })

 await notificationService.create(company.recruiterId, {
  type: approve ? 'company_verified' : 'company_rejected',
  title: approve ? 'Your company is verified ✅' : 'Company verification update',
  message: approve
    ? `${company.name} is now verified — you can publish job postings.`
    : `${company.name} was not verified. ${updated.verificationNote}`,
  data: { companyId: company.id }
}, { isRecruiter: true })   

  await queues.emailQueue.add({
    type: 'company_status',
    companyId: company.id,
    emailType: approve ? 'company_verified' : 'company_rejected'
  }, defaultOpts)

  return res.json(new ApiResponse(200, { company: updated }, approve ? 'Company verified' : 'Company rejected'))
})

module.exports = {
  getStats, getUsers, updateUserRole, banUser,
  addQuestion, getQuestions, updateQuestion, deleteQuestion, bulkImportQuestions,
  getQuestionBankStats,
  recomputeQuestionBankStats,
  getQueueStats, getCompanies, verifyCompany
}