const prisma = require('../config/database')
const { ApiError } = require('../utils/ApiError')
const { ApiResponse } = require('../utils/ApiResponse')
const asyncHandler = require('../utils/asyncHandler')
const queues = require('../queues')
const { defaultOpts } = queues
const pipelineService = require('../services/pipelineService')

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

function slugify(title) {
  return title
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 60)
}

async function generateUniqueSlug(title) {
  const base = slugify(title) || 'job'
  for (let i = 0; i < 5; i++) {
    const suffix = Math.random().toString(36).slice(2, 7)
    const candidate = `${base}-${suffix}`
    const existing = await prisma.jobPosting.findUnique({ where: { applyLinkSlug: candidate } })
    if (!existing) return candidate
  }
  // Extremely unlikely fallback
  return `${base}-${Date.now()}`
}

/**
 * Upserts `Skill` rows by name (case-insensitive) and replaces the
 * `JobPostingSkill` links for a posting inside a transaction.
 */
async function syncJobPostingSkills(tx, jobPostingId, requiredSkills) {
  await tx.jobPostingSkill.deleteMany({ where: { jobPostingId } })

  for (const ref of requiredSkills) {
    const name = ref.name.trim()
    let skill = await tx.skill.findFirst({ where: { name: { equals: name, mode: 'insensitive' } } })
    if (!skill) skill = await tx.skill.create({ data: { name } })

    await tx.jobPostingSkill.create({
      data: { jobPostingId, skillId: skill.id, required: ref.required !== false }
    })
  }
}

const POSTING_SUMMARY_SELECT = {
  id: true, title: true, companyName: true, status: true, openings: true,
  applyLinkSlug: true, minExperience: true, examEnabled: true, examDurationMin: true,
  ruleScoreThreshold: true, aiMatchThreshold: true, createdAt: true, updatedAt: true
}

async function getStageCounts(jobPostingId) {
  const counts = await prisma.application.groupBy({
    by: ['stage'],
    where: { jobPostingId },
    _count: { _all: true }
  })
  return counts.reduce((acc, c) => { acc[c.stage] = c._count._all; return acc }, {})
}

// ----------------------------------------------------------------------------
// Recruiter — Job posting CRUD (§4)
// ----------------------------------------------------------------------------

// POST /recruiter/postings
const createPosting = asyncHandler(async (req, res) => {
  const data = req.body

  const company = await prisma.company.findUnique({ where: { recruiterId: req.user.id } })
  if (!company) throw new ApiError(403, 'Create your company before posting a job')

  if (data.status === 'active' && company.verificationStatus !== 'verified') {
    throw new ApiError(403, 'Your company must be verified before publishing a job posting. Submit your company for verification from Settings.')
  }

  const applyLinkSlug = await generateUniqueSlug(data.title)

  const posting = await prisma.$transaction(async (tx) => {
    const created = await tx.jobPosting.create({
      data: {
        recruiterId: req.user.id,
        companyId: company.id,
        title: data.title,
        description: data.description,
        companyName: company.name,
        minExperience: data.minExperience,
        openings: data.openings,
        cutoffMode: data.cutoffMode,
        cutoffPercentage: data.cutoffPercentage,
        ruleScoreThreshold: data.ruleScoreThreshold,
        aiMatchThreshold: data.aiMatchThreshold,
        assignmentBrief: data.assignmentBrief,
        assignmentDeadlineDays: data.assignmentDeadlineDays,
        examEnabled: data.examEnabled,
        examDurationMin: data.examDurationMin,
        examWindowHours: data.examWindowHours,
        matchNotificationCap: data.matchNotificationCap,
        scoringWeights: data.scoringWeights || undefined,
        status: data.status,
        applyLinkSlug
      }
    })

    await syncJobPostingSkills(tx, created.id, data.requiredSkills)
    return created
  })

  if (posting.status === 'active') {
    await queues.matchQueue.add({ type: 'posting_match', jobPostingId: posting.id }, defaultOpts)
  }

  return res.status(201).json(new ApiResponse(201, { posting }))
})

// GET /recruiter/postings — paginated list with per-stage application counts
const getMyPostings = asyncHandler(async (req, res) => {
  const { page = 1, limit = 10, status } = req.query
  const skip = (parseInt(page) - 1) * parseInt(limit)

  const where = { recruiterId: req.user.id }
  if (status) where.status = status

  const [postings, total] = await Promise.all([
    prisma.jobPosting.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip,
      take: parseInt(limit),
      select: { ...POSTING_SUMMARY_SELECT, _count: { select: { applications: true } } }
    }),
    prisma.jobPosting.count({ where })
  ])

  const postingIds = postings.map(p => p.id)
  const stageCounts = await prisma.application.groupBy({
    by: ['jobPostingId', 'stage'],
    where: { jobPostingId: { in: postingIds } },
    _count: { _all: true }
  })

  const stageMap = {}
  for (const sc of stageCounts) {
    stageMap[sc.jobPostingId] = stageMap[sc.jobPostingId] || {}
    stageMap[sc.jobPostingId][sc.stage] = sc._count._all
  }

  const postingsWithCounts = postings.map(p => ({
    ...p,
    applicationCount: p._count.applications,
    stageCounts: stageMap[p.id] || {}
  }))

  return res.json(new ApiResponse(200, {
    postings: postingsWithCounts,
    pagination: { total, page: parseInt(page), limit: parseInt(limit), pages: Math.ceil(total / parseInt(limit)) }
  }))
})

// GET /recruiter/postings/:id — full detail + stage counts
const getPosting = asyncHandler(async (req, res) => {
  const posting = await prisma.jobPosting.findFirst({
    where: { id: req.params.id, recruiterId: req.user.id },
    include: { requiredSkills: { include: { skill: true } } }
  })
  if (!posting) throw new ApiError(404, 'Posting not found')

  const stageCounts = await getStageCounts(posting.id)
  const applicationCount = await prisma.application.count({ where: { jobPostingId: posting.id } })

  return res.json(new ApiResponse(200, { posting, stageCounts, applicationCount }))
})

// PATCH /recruiter/postings/:id — edit (full edit if draft, limited fields if active)
const updatePosting = asyncHandler(async (req, res) => {
  const posting = await prisma.jobPosting.findFirst({
    where: { id: req.params.id, recruiterId: req.user.id }
  })
  if (!posting) throw new ApiError(404, 'Posting not found')

  const data = req.body
  const wasActive = posting.status === 'active'

  // Gate: drafts can only flip to "active" once the recruiter's company is verified.
  if (posting.status === 'draft' && data.status === 'active') {
    const company = await prisma.company.findUnique({ where: { recruiterId: req.user.id } })
    if (!company || company.verificationStatus !== 'verified') {
      throw new ApiError(403, 'Your company must be verified before publishing a job posting. Submit your company for verification from Settings.')
    }
  }

  let updateData
  if (posting.status === 'draft') {
    // Full edit allowed while draft
    updateData = {
      title: data.title ?? posting.title,
      description: data.description ?? posting.description,
      companyName: data.companyName ?? posting.companyName,
      minExperience: data.minExperience ?? posting.minExperience,
      openings: data.openings ?? posting.openings,
      cutoffMode: data.cutoffMode ?? posting.cutoffMode,
      cutoffPercentage: data.cutoffPercentage ?? posting.cutoffPercentage,
      ruleScoreThreshold: data.ruleScoreThreshold ?? posting.ruleScoreThreshold,
      aiMatchThreshold: data.aiMatchThreshold ?? posting.aiMatchThreshold,
      assignmentBrief: data.assignmentBrief ?? posting.assignmentBrief,
      assignmentDeadlineDays: data.assignmentDeadlineDays ?? posting.assignmentDeadlineDays,
      examEnabled: data.examEnabled ?? posting.examEnabled,
      examDurationMin: data.examDurationMin ?? posting.examDurationMin,
      examWindowHours: data.examWindowHours ?? posting.examWindowHours,
      matchNotificationCap: data.matchNotificationCap ?? posting.matchNotificationCap,
      scoringWeights: data.scoringWeights ?? posting.scoringWeights,
      status: data.status ?? posting.status
    }
  } else {
    // Active/closed — only allow operational tuning, not structural changes
    // (title/requiredSkills/minExperience are already baked into running applications)
    updateData = {
      assignmentDeadlineDays: data.assignmentDeadlineDays ?? posting.assignmentDeadlineDays,
      examEnabled: posting.examEnabled, // locked once active
      examDurationMin: posting.examDurationMin,
      matchNotificationCap: data.matchNotificationCap ?? posting.matchNotificationCap,
      scoringWeights: data.scoringWeights ?? posting.scoringWeights,
      status: data.status === 'closed' ? 'closed' : posting.status
    }
  }

  const updated = await prisma.$transaction(async (tx) => {
    const result = await tx.jobPosting.update({ where: { id: posting.id }, data: updateData })
    if (posting.status === 'draft' && data.requiredSkills) {
      await syncJobPostingSkills(tx, posting.id, data.requiredSkills)
    }
    return result
  })

  // Newly published → run the skill-based auto-match
  if (!wasActive && updated.status === 'active') {
    await queues.matchQueue.add({ type: 'posting_match', jobPostingId: updated.id }, defaultOpts)
  }

  return res.json(new ApiResponse(200, { posting: updated }))
})

// PATCH /recruiter/postings/:id/close
const closePosting = asyncHandler(async (req, res) => {
  const posting = await prisma.jobPosting.findFirst({
    where: { id: req.params.id, recruiterId: req.user.id }
  })
  if (!posting) throw new ApiError(404, 'Posting not found')

  const updated = await prisma.jobPosting.update({ where: { id: posting.id }, data: { status: 'closed' } })
  return res.json(new ApiResponse(200, { posting: updated }))
})

// POST /recruiter/postings/:id/clone — clone as new draft (template reuse)
const clonePosting = asyncHandler(async (req, res) => {
  const posting = await prisma.jobPosting.findFirst({
    where: { id: req.params.id, recruiterId: req.user.id },
    include: { requiredSkills: { include: { skill: true } } }
  })
  if (!posting) throw new ApiError(404, 'Posting not found')

  const applyLinkSlug = await generateUniqueSlug(`${posting.title}-copy`)

  const clone = await prisma.$transaction(async (tx) => {
    const created = await tx.jobPosting.create({
      data: {
        recruiterId: req.user.id,
        title: `${posting.title} (Copy)`,
        description: posting.description,
        companyName: posting.companyName,
        minExperience: posting.minExperience,
        openings: posting.openings,
        ruleScoreThreshold: posting.ruleScoreThreshold,
        aiMatchThreshold: posting.aiMatchThreshold,
        assignmentBrief: posting.assignmentBrief,
        assignmentDeadlineDays: posting.assignmentDeadlineDays,
        examEnabled: posting.examEnabled,
        examDurationMin: posting.examDurationMin,
        examWindowHours: posting.examWindowHours,
        matchNotificationCap: posting.matchNotificationCap,
        scoringWeights: posting.scoringWeights || undefined,
        status: 'draft',
        applyLinkSlug
        // questionBank intentionally NOT copied — regenerated per posting
      }
    })

    await syncJobPostingSkills(tx, created.id, posting.requiredSkills.map(rs => ({ name: rs.skill.name, required: rs.required })))
    return created
  })

  return res.status(201).json(new ApiResponse(201, { posting: clone }))
})

// ----------------------------------------------------------------------------
// Public apply page (§4) — GET is fully public, POST requires auth (see routes/apply.js)
// ----------------------------------------------------------------------------

// GET /apply/:slug — public
const getPublicPosting = asyncHandler(async (req, res) => {
  const posting = await prisma.jobPosting.findUnique({
    where: { applyLinkSlug: req.params.slug },
    include: { requiredSkills: { include: { skill: true } } }
  })
  if (!posting || posting.status !== 'active') throw new ApiError(404, 'This job posting is not available')

  return res.json(new ApiResponse(200, {
    posting: {
      id: posting.id,
      title: posting.title,
      companyName: posting.companyName,
      description: posting.description,
      minExperience: posting.minExperience,
      examEnabled: posting.examEnabled,
      requiredSkills: posting.requiredSkills.map(rs => ({ name: rs.skill.name, required: rs.required })),
      applyLinkSlug: posting.applyLinkSlug
    }
  }))
})

// POST /apply/:slug — requires auth (see routes/apply.js)
const submitApplication = asyncHandler(async (req, res) => {
  const posting = await prisma.jobPosting.findUnique({ where: { applyLinkSlug: req.params.slug } })
  if (!posting || posting.status !== 'active') throw new ApiError(404, 'This job posting is not available')

  const existing = await prisma.application.findUnique({
    where: { jobPostingId_userId: { jobPostingId: posting.id, userId: req.user.id } }
  })
  if (existing) throw new ApiError(400, 'You have already applied to this posting')

  let resumeUrl = null
  if (req.file) {
    const { uploadBuffer } = require('../services/storageService')
    const result = await uploadBuffer(req.file.buffer, { folder: 'devcert/resumes', resource_type: 'raw', access_mode: 'public' })
    resumeUrl = result.secure_url
  }

  const application = await pipelineService.createApplication({
    jobPostingId: posting.id,
    userId: req.user.id,
    resumeUrl,
    coverNote: req.body.coverNote
  })

  return res.status(201).json(new ApiResponse(201, {
    applicationId: application.id,
    message: 'Application submitted. We will email you with updates as your application progresses.'
  }))
})

// ----------------------------------------------------------------------------
// Recruiter — pipeline dashboard (§9)
// ----------------------------------------------------------------------------

const APPLICATION_LIST_SELECT = {
  id: true, stage: true, status: true, ruleScore: true, aiMatchScore: true,
  projectScore: true, examScore: true, finalScore: true, rank: true,
  missingSkills: true, createdAt: true, updatedAt: true,
  pipelineError: true, // surfaces a stuck/failed stage instead of silently showing nothing
  user: { select: { id: true, name: true, username: true, email: true, avatar: true } }
}

// GET /recruiter/postings/:id/applications — paginated, filterable, sortable
const getPostingApplications = asyncHandler(async (req, res) => {
  const posting = await prisma.jobPosting.findFirst({ where: { id: req.params.id, recruiterId: req.user.id } })
  if (!posting) throw new ApiError(404, 'Posting not found')

  const { page = 1, limit = 25, stage, status, sortBy = 'createdAt', sortDir = 'desc' } = req.query
  const skip = (parseInt(page) - 1) * parseInt(limit)

  const where = { jobPostingId: posting.id }
  if (stage) where.stage = stage
  if (status) where.status = status

  const allowedSort = ['finalScore', 'rank', 'createdAt', 'ruleScore', 'aiMatchScore', 'projectScore', 'examScore']
  const orderBy = { [allowedSort.includes(sortBy) ? sortBy : 'createdAt']: sortDir === 'asc' ? 'asc' : 'desc' }

  const [applications, total] = await Promise.all([
    prisma.application.findMany({ where, orderBy, skip, take: parseInt(limit), select: APPLICATION_LIST_SELECT }),
    prisma.application.count({ where })
  ])

  return res.json(new ApiResponse(200, {
    applications,
    pagination: { total, page: parseInt(page), limit: parseInt(limit), pages: Math.ceil(total / parseInt(limit)) }
  }))
})

// GET /recruiter/applications/:id — full detail
const getApplicationDetail = asyncHandler(async (req, res) => {
  const application = await prisma.application.findUnique({
    where: { id: req.params.id },
    include: {
      user: { select: { id: true, name: true, username: true, email: true, avatar: true, skills: { include: { skill: true } } } },
      jobPosting: { include: { requiredSkills: { include: { skill: true } } } }
    }
  })
  if (!application) throw new ApiError(404, 'Application not found')
  if (application.jobPosting.recruiterId !== req.user.id && req.user.role !== 'admin') {
    throw new ApiError(403, 'Not authorized')
  }

  let project = null
  if (application.projectId) {
    project = await prisma.project.findUnique({
      where: { id: application.projectId },
      select: { id: true, title: true, githubUrl: true, liveUrl: true, status: true, score: true, level: true, evaluationReport: true }
    })
  }

  let examAttempt = null
  if (application.examAttemptId) {
    examAttempt = await prisma.examAttempt.findUnique({
      where: { id: application.examAttemptId },
      select: { id: true, status: true, totalScore: true, level: true, evaluationReport: true, startedAt: true, submittedAt: true }
    })
  }

  return res.json(new ApiResponse(200, { application, project, examAttempt }))
})

// POST /recruiter/postings/:id/rank — manual ranking trigger
const triggerRanking = asyncHandler(async (req, res) => {
  const posting = await prisma.jobPosting.findFirst({ where: { id: req.params.id, recruiterId: req.user.id } })
  if (!posting) throw new ApiError(404, 'Posting not found')

  await queues.applicationQueue.add({ jobPostingId: posting.id, action: 'rank_posting' }, defaultOpts)

  return res.json(new ApiResponse(200, { message: 'Ranking started' }))
})

// GET /recruiter/postings/:id/stats — counts, avg scores, funnel data
const getPostingStats = asyncHandler(async (req, res) => {
  const posting = await prisma.jobPosting.findFirst({ where: { id: req.params.id, recruiterId: req.user.id } })
  if (!posting) throw new ApiError(404, 'Posting not found')

  const STAGES = ['applied', 'screened', 'assignment_sent', 'assignment_submitted', 'project_evaluated', 'exam_sent', 'exam_completed', 'ranked']

  const [stageCounts, statusCounts, avgScores] = await Promise.all([
    prisma.application.groupBy({ by: ['stage'], where: { jobPostingId: posting.id }, _count: { _all: true } }),
    prisma.application.groupBy({ by: ['status'], where: { jobPostingId: posting.id }, _count: { _all: true } }),
    prisma.application.aggregate({
      where: { jobPostingId: posting.id },
      _avg: { ruleScore: true, aiMatchScore: true, projectScore: true, examScore: true, finalScore: true }
    })
  ])

  const stageMap = stageCounts.reduce((acc, c) => { acc[c.stage] = c._count._all; return acc }, {})
  const statusMap = statusCounts.reduce((acc, c) => { acc[c.status] = c._count._all; return acc }, {})

  const total = Object.values(stageMap).reduce((a, b) => a + b, 0)
  let remaining = total
  const funnel = STAGES.map((stage) => {
    const point = { stage, count: remaining }
    remaining -= (stageMap[stage] || 0)
    return point
  })

  // ---- G2: stageVelocity ----
  const allStageEvents = await prisma.applicationStageEvent.findMany({
    where: { application: { jobPostingId: posting.id } },
    orderBy: { enteredAt: 'asc' }
  })
  const eventsByApp = {}
  for (const e of allStageEvents) {
    if (!eventsByApp[e.applicationId]) eventsByApp[e.applicationId] = []
    eventsByApp[e.applicationId].push(e)
  }
  const stageOrder = ['applied', 'screened', 'assignment_sent', 'assignment_submitted', 'project_evaluated', 'exam_sent', 'exam_completed', 'ranked', 'selected']
  const velocityAccum = {}
  for (const events of Object.values(eventsByApp)) {
    for (let i = 0; i < stageOrder.length - 1; i++) {
      const from = events.find(e => e.stage === stageOrder[i])
      const to = events.find(e => e.stage === stageOrder[i + 1])
      if (from && to) {
        const key = `${stageOrder[i]}→${stageOrder[i + 1]}`
        if (!velocityAccum[key]) velocityAccum[key] = []
        velocityAccum[key].push((new Date(to.enteredAt) - new Date(from.enteredAt)) / 3600000)
      }
    }
  }
  const stageVelocity = Object.fromEntries(
    Object.entries(velocityAccum).map(([k, vals]) => [k, Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 10) / 10])
  )

  // ---- G2: scoreDistribution histograms (10-wide buckets) ----
  const allApps = await prisma.application.findMany({
    where: { jobPostingId: posting.id },
    select: { ruleScore: true, aiMatchScore: true, projectScore: true, examScore: true }
  })
  function buildHistogram(values) {
    const buckets = Array.from({ length: 10 }, (_, i) => ({ range: `${i * 10}-${i * 10 + 10}`, count: 0 }))
    values.forEach(v => {
      if (v == null) return
      const idx = Math.min(Math.floor(v / 10), 9)
      buckets[idx].count++
    })
    return buckets
  }
  const scoreDistribution = {
    ruleScore: buildHistogram(allApps.map(a => a.ruleScore)),
    aiMatchScore: buildHistogram(allApps.map(a => a.aiMatchScore)),
    projectScore: buildHistogram(allApps.map(a => a.projectScore)),
    examScore: buildHistogram(allApps.map(a => a.examScore))
  }

  // ---- G2: dropoffReasons ----
  const rejectedApps = await prisma.application.findMany({
    where: { jobPostingId: posting.id, status: 'rejected' },
    select: { rejectionReason: true }
  })
  const dropoffReasons = { rule_score: 0, ai_match: 0, project_score: 0, exam_score: 0, final_ranking: 0, other: 0 }
  for (const { rejectionReason } of rejectedApps) {
    if (!rejectionReason) { dropoffReasons.other++; continue }
    if (/rule.*score|skill.*match|missing.*skill/i.test(rejectionReason)) dropoffReasons.rule_score++
    else if (/ai.*match|resume.*match/i.test(rejectionReason)) dropoffReasons.ai_match++
    else if (/project.*score/i.test(rejectionReason)) dropoffReasons.project_score++
    else if (/exam.*score|assessment.*score/i.test(rejectionReason)) dropoffReasons.exam_score++
    else if (/final.*score|cutoff/i.test(rejectionReason)) dropoffReasons.final_ranking++
    else dropoffReasons.other++
  }

  return res.json(new ApiResponse(200, {
    total,
    stageCounts: stageMap,
    statusCounts: statusMap,
    avgScores: avgScores._avg,
    funnel,
    rankingSummary: posting.rankingSummary || null,
    // G2 additions
    stageVelocity,
    scoreDistribution,
    dropoffReasons
  }))
})

// GET /recruiter/overview — cross-posting summary (Part G2)
const getRecruiterOverview = asyncHandler(async (req, res) => {
  const now = new Date()
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1)

  const postings = await prisma.jobPosting.findMany({
    where: { recruiterId: req.user.id },
    include: { _count: { select: { applications: true } } }
  })
  const postingIds = postings.map(p => p.id)

  const [totalApplicantsThisMonth, totalHiredAllTime, statusCounts] = await Promise.all([
    prisma.application.count({ where: { jobPostingId: { in: postingIds }, createdAt: { gte: monthStart } } }),
    prisma.application.count({ where: { jobPostingId: { in: postingIds }, status: 'selected' } }),
    prisma.application.groupBy({ by: ['jobPostingId', 'status'], where: { jobPostingId: { in: postingIds } }, _count: { _all: true } })
  ])

  // Avg time-to-hire from stage events
  const hiringEvents = await prisma.applicationStageEvent.findMany({
    where: { application: { jobPostingId: { in: postingIds }, status: 'selected' }, stage: { in: ['applied', 'selected'] } }
  })
  const byApp = {}
  for (const e of hiringEvents) {
    if (!byApp[e.applicationId]) byApp[e.applicationId] = {}
    byApp[e.applicationId][e.stage] = e.enteredAt
  }
  const hireTimes = Object.values(byApp)
    .filter(e => e.applied && e.selected)
    .map(e => (new Date(e.selected) - new Date(e.applied)) / 3600000)
  const avgTimeToHireHours = hireTimes.length > 0
    ? Math.round((hireTimes.reduce((a, b) => a + b, 0) / hireTimes.length) * 10) / 10
    : null

  // Per-posting health
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
  const recentActivity = await prisma.applicationStageEvent.groupBy({
    by: ['applicationId'],
    where: { application: { jobPostingId: { in: postingIds }, status: 'in_progress' }, enteredAt: { gte: sevenDaysAgo } },
    _count: { _all: true }
  })
  const activeAppIds = new Set(recentActivity.map(r => r.applicationId))

  const stalledByPosting = await prisma.application.groupBy({
    by: ['jobPostingId'],
    where: { jobPostingId: { in: postingIds }, status: 'in_progress', id: { notIn: [...activeAppIds] } },
    _count: { _all: true }
  })
  const stalledMap = Object.fromEntries(stalledByPosting.map(s => [s.jobPostingId, s._count._all]))

  const countsByPosting = {}
  for (const sc of statusCounts) {
    if (!countsByPosting[sc.jobPostingId]) countsByPosting[sc.jobPostingId] = {}
    countsByPosting[sc.jobPostingId][sc.status] = sc._count._all
  }

  const postingSummaries = postings.map(p => {
    const counts = countsByPosting[p.id] || {}
    const total = p._count.applications
    const selected = counts.selected || 0
    return {
      id: p.id, title: p.title, status: p.status,
      applicantCount: total,
      conversionRate: total > 0 ? Math.round((selected / total) * 100) : 0,
      stalledCount: stalledMap[p.id] || 0
    }
  }).sort((a, b) => (b.stalledCount - a.stalledCount) || (a.conversionRate - b.conversionRate))

  return res.json(new ApiResponse(200, {
    activePostingsCount: postings.filter(p => p.status === 'active').length,
    totalApplicantsThisMonth,
    totalHiredAllTime,
    avgTimeToHireHours,
    postings: postingSummaries
  }))
})

// GET /recruiter/postings/:id/threshold-suggestions (Part G2)
const getThresholdSuggestions = asyncHandler(async (req, res) => {
  const posting = await prisma.jobPosting.findFirst({ where: { id: req.params.id, recruiterId: req.user.id } })
  if (!posting) throw new ApiError(404, 'Posting not found')

  const applications = await prisma.application.findMany({
    where: { jobPostingId: posting.id },
    select: { ruleScore: true, aiMatchScore: true, finalScore: true }
  })

  function computeAtThreshold(field, threshold) {
    const passing = applications.filter(a => (a[field] || 0) >= threshold)
    const avgFinal = passing.filter(a => a.finalScore != null)
    return {
      threshold,
      wouldPass: passing.length,
      avgFinalScore: avgFinal.length > 0
        ? Math.round((avgFinal.reduce((s, a) => s + a.finalScore, 0) / avgFinal.length) * 10) / 10
        : null
    }
  }

  const offsets = [-20, -10, 0, 10, 20]
  return res.json(new ApiResponse(200, {
    ruleScoreThreshold: offsets.map(o => computeAtThreshold('ruleScore', Math.max(0, Math.min(100, posting.ruleScoreThreshold + o)))),
    aiMatchThreshold: offsets.map(o => computeAtThreshold('aiMatchScore', Math.max(0, Math.min(100, posting.aiMatchThreshold + o))))
  }))
})

module.exports = {
  createPosting, getMyPostings, getPosting, updatePosting, closePosting, clonePosting,
  getPublicPosting, submitApplication,
  getPostingApplications, getApplicationDetail, triggerRanking, getPostingStats,
  getRecruiterOverview, getThresholdSuggestions
}npx prisma migrate resolve --applied 0_init