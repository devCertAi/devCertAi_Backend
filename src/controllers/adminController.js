const prisma = require('../config/database')
const { ApiError } = require('../utils/ApiError')
const { ApiResponse } = require('../utils/ApiResponse')
const asyncHandler = require('../utils/asyncHandler')
const notificationService = require('../services/notificationService')
const queues = require('../queues')
const { defaultOpts } = queues
const { safeRedis } = require('../config/redis')

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
  const { domain, phase, level, question, options, answer, type } = req.body

  if (!domain || !phase || !level || !question || !answer || !type) {
    throw new ApiError(400, 'domain, phase, level, question, answer, and type are required')
  }

  const q = await prisma.questionBank.create({
    data: { domain, phase: parseInt(phase), level, question, options: options || [], answer, type }
  })

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
  const { question, options, answer, level, isActive } = req.body

  const updated = await prisma.questionBank.update({
    where: { id: req.params.id },
    data: {
      ...(question && { question }),
      ...(options && { options }),
      ...(answer && { answer }),
      ...(level && { level }),
      ...(isActive !== undefined && { isActive })
    }
  })

  return res.json(new ApiResponse(200, { question: updated }))
})

// DELETE /questions/:id — soft delete
const deleteQuestion = asyncHandler(async (req, res) => {
  await prisma.questionBank.update({
    where: { id: req.params.id },
    data: { isActive: false }
  })
  return res.json(new ApiResponse(200, {}, 'Question deactivated'))
})

// POST /questions/bulk-import
const bulkImportQuestions = asyncHandler(async (req, res) => {
  const { questions } = req.body
  if (!Array.isArray(questions) || questions.length === 0) {
    throw new ApiError(400, 'questions array is required')
  }

  const data = questions.map(q => ({
    domain: q.domain,
    phase: parseInt(q.phase),
    level: q.level,
    question: q.question,
    options: q.options || [],
    answer: q.answer,
    type: q.type || 'mcq'
  }))

  const result = await prisma.questionBank.createMany({ data, skipDuplicates: true })
  return res.status(201).json(new ApiResponse(201, { created: result.count }, `${result.count} questions imported`))
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
  getQueueStats, getCompanies, verifyCompany
}