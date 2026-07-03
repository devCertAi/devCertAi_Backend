const prisma = require('../config/database')
const { ApiError } = require('../utils/ApiError')
const { ApiResponse } = require('../utils/ApiResponse')
const asyncHandler = require('../utils/asyncHandler')
// examGradingQueue.add() falls back to running gradeAttempt() inline (DB-only)
// automatically whenever Redis/Bull is unavailable — see src/queues/index.js.
// No isQueueAvailable() branching needed here; always go through the queue.
const queues = require('../queues')
const { defaultOpts } = queues
const { getPhase1Questions, hasPassedPhase1 } = require('../services/examService')
const { generatePhase2Questions } = require('../ai/evaluationEngine')
const { analyzeGithubRepo } = require('../ai/githubAnalyzer')
const creditService = require('../services/creditService')

// POST /start
const startExam = asyncHandler(async (req, res) => {
  const { domain, phase } = req.body
  const userId = req.user.id

  // Phase 2 requires phase 1 pass for same domain
  if (phase === 2) {
    const passed = await hasPassedPhase1(userId, domain)
    if (!passed) throw new ApiError(400, `You must pass Phase 1 for ${domain} before attempting Phase 2`)
  }

  // Check for any in-progress attempt
  const inProgress = await prisma.examAttempt.findFirst({
    where: { userId, domain, phase, status: { in: ['pending', 'in_progress'] } }
  })
  if (inProgress) throw new ApiError(400, 'You already have an in-progress exam attempt for this domain and phase')

  // Credit gate — self-serve certification attempts only.
  // Phase 1 costs 1 skill credit. Phase 2 also costs 1 skill credit.
  // Premium users bypass entirely. Pipeline-linked attempts skip this (handled separately).
  if (!req.user.isPremium && (phase === 1 || phase === 2)) {
    await creditService.consumeCredit(userId, 'skill', { domain, phase })
  }

  let questions = []
  if (phase === 1) {
    questions = await getPhase1Questions(domain, 25)
  }
  // Phase 2 questions generated after project is submitted via /phase2/project

  const attempt = await prisma.examAttempt.create({
    data: {
      userId,
      domain,
      phase,
      status: 'in_progress',
      questions,
      answers: {},
      startedAt: new Date(),
      timeLimitSec: phase === 1 ? 2700 : 3600, // 45min phase1, 60min phase2
      proctorFlags: []
    }
  })

  // Return questions WITHOUT answers stripped
  const safeQuestions = phase === 1
    ? questions.map(({ id, question, options, level, type }) => ({ id, question, options, level, type }))
    : []

  return res.status(201).json(new ApiResponse(201, {
    attemptId: attempt.id,
    questions: safeQuestions,
    timeLimitSec: attempt.timeLimitSec,
    domain,
    phase
  }))
})

// POST /demo/start — free practice attempt, unlimited, no certificate.
// Lets a user try the exam experience before spending their monthly credit.
const startDemoExam = asyncHandler(async (req, res) => {
  const { domain } = req.body
  const userId = req.user.id

  const inProgress = await prisma.examAttempt.findFirst({
    where: { userId, domain, source: 'demo', status: { in: ['pending', 'in_progress'] } }
  })
  if (inProgress) throw new ApiError(400, 'You already have an in-progress demo attempt for this domain')

  const questions = await getPhase1Questions(domain, 5)

  const attempt = await prisma.examAttempt.create({
    data: {
      userId,
      domain,
      phase: 1,
      status: 'in_progress',
      questions,
      answers: {},
      startedAt: new Date(),
      timeLimitSec: 600, // 10 min demo
      proctorFlags: [],
      source: 'demo'
    }
  })

  const safeQuestions = questions.map(({ id, question, options, level, type }) => ({ id, question, options, level, type }))

  return res.status(201).json(new ApiResponse(201, {
    attemptId: attempt.id,
    questions: safeQuestions,
    timeLimitSec: attempt.timeLimitSec,
    domain,
    isDemo: true,
    message: 'This is a free demo — no certificate is issued and it doesn\'t use your monthly credit.'
  }))
})

// GET /attempt/:id
const getAttempt = asyncHandler(async (req, res) => {
  const attempt = await prisma.examAttempt.findFirst({
    where: { id: req.params.id, userId: req.user.id }
  })
  if (!attempt) throw new ApiError(404, 'Attempt not found')

  // Strip correct answers from questions for in-progress attempts
  const safeAttempt = {
    ...attempt,
    questions: (attempt.questions || []).map(q => {
      const { answer, ...safe } = q
      return safe
    })
  }

  return res.json(new ApiResponse(200, { attempt: safeAttempt }))
})

// POST /attempt/:id/answer
const submitAnswer = asyncHandler(async (req, res) => {
  const { questionIndex, answer } = req.body
  const { id } = req.params

  const attempt = await prisma.examAttempt.findFirst({
    where: { id, userId: req.user.id, status: 'in_progress' }
  })
  if (!attempt) throw new ApiError(404, 'Active attempt not found')

  // Enforce time limit (30s grace period)
  const elapsed = (Date.now() - new Date(attempt.startedAt).getTime()) / 1000
  if (elapsed > attempt.timeLimitSec + 30) {
    throw new ApiError(400, 'Exam time has expired')
  }

  const answers = { ...(attempt.answers || {}) }

  if (attempt.phase === 1) {
    // Key by question ID for accurate grading
    const question = attempt.questions?.[questionIndex]
    if (!question) throw new ApiError(400, `Invalid question index: ${questionIndex}`)
    answers[question.id] = answer
  } else {
    // Phase 2: key by index (text answers)
    answers[questionIndex] = answer
  }

  await prisma.examAttempt.update({ where: { id }, data: { answers } })

  return res.json(new ApiResponse(200, { success: true, questionIndex }))
})

// POST /attempt/:id/submit
const submitExam = asyncHandler(async (req, res) => {
  const { id } = req.params

  const attempt = await prisma.examAttempt.findFirst({
    where: { id, userId: req.user.id }
  })
  if (!attempt) throw new ApiError(404, 'Attempt not found')

  if (!['in_progress', 'terminated'].includes(attempt.status)) {
    throw new ApiError(400, `Exam already ${attempt.status}`)
  }

  // Only update status if not already terminated
  if (attempt.status === 'in_progress') {
    await prisma.examAttempt.update({
      where: { id },
      data: { status: 'submitted', submittedAt: new Date() }
    })
  }

  // The queue itself falls back to running grading inline (DB-only) if
  // Redis/Bull isn't available — no branching needed here.
  await queues.examGradingQueue.add({ attemptId: id }, defaultOpts)

  return res.json(new ApiResponse(200, {
    message: 'Exam submitted. Results will be ready shortly.',
    attemptId: id
  }))
})

// POST /attempt/:id/tab-switch
const reportTabSwitch = asyncHandler(async (req, res) => {
  const { id } = req.params

  const attempt = await prisma.examAttempt.findFirst({
    where: { id, userId: req.user.id, status: 'in_progress' }
  })
  if (!attempt) throw new ApiError(404, 'Active attempt not found')

  const newCount = (attempt.tabSwitchCount || 0) + 1
  const flags = [...(attempt.proctorFlags || []), {
    type: 'TAB_SWITCH',
    timestamp: new Date().toISOString(),
    count: newCount
  }]

  const shouldTerminate = newCount >= 3
  const updateData = {
    tabSwitchCount: newCount,
    proctorFlags: flags,
    ...(shouldTerminate && {
      status: 'terminated',
      terminationReason: 'TAB_SWITCH_LIMIT',
      submittedAt: new Date()
    })
  }

  await prisma.examAttempt.update({ where: { id }, data: updateData })

  if (shouldTerminate) {
    await queues.examGradingQueue.add({ attemptId: id }, defaultOpts)
  }

  return res.json(new ApiResponse(200, {
    tabSwitchCount: newCount,
    shouldTerminate,
    warningsRemaining: Math.max(0, 3 - newCount)
  }))
})

// POST /attempt/:id/violation
const reportViolation = asyncHandler(async (req, res) => {
  const { type, timestamp } = req.body
  const { id } = req.params

  const attempt = await prisma.examAttempt.findFirst({
    where: { id, userId: req.user.id }
  })
  if (!attempt) throw new ApiError(404, 'Attempt not found')

  const flags = [...(attempt.proctorFlags || []), { type, timestamp }]
  const updateData = { proctorFlags: flags }

  let shouldTerminate = false
  let terminationReason = null

  if (type === 'FULLSCREEN_EXIT') {
    const fsExits = (attempt.fullscreenExits || 0) + 1
    updateData.fullscreenExits = fsExits

    if (fsExits >= 2 && attempt.status === 'in_progress') {
      shouldTerminate = true
      terminationReason = 'FULLSCREEN_VIOLATION'
    }
  }

  if (type === 'SCREEN_SHARE_STOPPED' && attempt.status === 'in_progress') {
    // Screen share stopping is a serious violation — terminate immediately
    shouldTerminate = true
    terminationReason = 'SCREEN_SHARE_STOPPED'
  }

  if (shouldTerminate) {
    updateData.status = 'terminated'
    updateData.terminationReason = terminationReason
    updateData.submittedAt = new Date()
  }

  await prisma.examAttempt.update({ where: { id }, data: updateData })

  if (shouldTerminate) {
    await queues.examGradingQueue.add({ attemptId: id }, defaultOpts)
  }

  return res.json(new ApiResponse(200, { success: true, shouldTerminate, terminationReason }))
})

// POST /attempt/:id/heartbeat  — frontend pings every 30s to confirm exam is live
const heartbeat = asyncHandler(async (req, res) => {
  const { id } = req.params
  const { cameraActive, fullscreen, tabFocused } = req.body

  const attempt = await prisma.examAttempt.findFirst({
    where: { id, userId: req.user.id }
  })
  if (!attempt) throw new ApiError(404, 'Attempt not found')

  // Log suspicious states but don't terminate — just flag
  if (!cameraActive || !fullscreen || !tabFocused) {
    const flags = [...(attempt.proctorFlags || []), {
      type: 'HEARTBEAT_ANOMALY',
      timestamp: new Date().toISOString(),
      cameraActive,
      fullscreen,
      tabFocused
    }]
    await prisma.examAttempt.update({ where: { id }, data: { proctorFlags: flags } })
  }

  return res.json(new ApiResponse(200, {
    status: attempt.status,
    timeRemaining: attempt.timeLimitSec - Math.floor((Date.now() - new Date(attempt.startedAt).getTime()) / 1000)
  }))
})

// POST /attempt/:id/phase2/project
const submitPhase2Project = asyncHandler(async (req, res) => {
  const { githubUrl } = req.body
  const { id } = req.params

  if (!githubUrl) throw new ApiError(400, 'GitHub URL is required for Phase 2')

  const attempt = await prisma.examAttempt.findFirst({
    where: { id, userId: req.user.id, phase: 2, status: 'in_progress' }
  })
  if (!attempt) throw new ApiError(404, 'Active Phase 2 attempt not found')

  // Analyze repo and generate 6 project-specific questions
  let context
  try {
    context = await analyzeGithubRepo(githubUrl)
  } catch (err) {
    throw new ApiError(400, `Could not analyze GitHub repository: ${err.message}`)
  }

  context.title = `${attempt.domain} Project`
  context.domain = attempt.domain

  const rawQuestions = await generatePhase2Questions(context)

  if (!Array.isArray(rawQuestions) || rawQuestions.length === 0) {
    throw new ApiError(500, 'Failed to generate questions from your project')
  }

  // Ensure exactly 6 questions
  const questions = rawQuestions.slice(0, 6)

  await prisma.examAttempt.update({
    where: { id },
    data: {
      questions,
      answers: {},
      projectId: githubUrl
    }
  })

  return res.json(new ApiResponse(200, {
    questions: questions.map((q, i) => ({
      index: i,
      question: q.question,
      context: q.context,
      type: q.type
    })),
    totalQuestions: questions.length
  }))
})

// GET /history
const getExamHistory = asyncHandler(async (req, res) => {
  const { page = 1, limit = 10, includeDemo = false } = req.query
  const skip = (parseInt(page) - 1) * parseInt(limit)
  const where = { userId: req.user.id, ...(includeDemo === 'true' ? {} : { source: { not: 'demo' } }) }

  const [attempts, total] = await Promise.all([
    prisma.examAttempt.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip,
      take: parseInt(limit),
      select: {
        id: true, domain: true, phase: true, status: true,
        totalScore: true, level: true, startedAt: true, submittedAt: true,
        tabSwitchCount: true, fullscreenExits: true,
        terminationReason: true, timeLimitSec: true, source: true,
        certificate: { select: { id: true, verificationId: true } }
      }
    }),
    prisma.examAttempt.count({ where })
  ])

  return res.json(new ApiResponse(200, {
    attempts,
    pagination: {
      total,
      page: parseInt(page),
      limit: parseInt(limit),
      pages: Math.ceil(total / parseInt(limit))
    }
  }))
})

// GET /domains — get available domains with user's pass status
const getDomains = asyncHandler(async (req, res) => {
  const DOMAINS = ['Frontend', 'Backend', 'Full Stack', 'Mobile', 'Data Science', 'DevOps']
  const userId = req.user.id

  const attempts = await prisma.examAttempt.findMany({
    where: { userId, status: 'completed', source: { not: 'demo' } },
    select: { domain: true, phase: true, totalScore: true }
  })

  const domainStatus = DOMAINS.map(domain => {
    const phase1Attempts = attempts.filter(a => a.domain === domain && a.phase === 1)
    const phase2Attempts = attempts.filter(a => a.domain === domain && a.phase === 2)

    const phase1Passed = phase1Attempts.some(a => (a.totalScore || 0) >= 50)
    const phase2Passed = phase2Attempts.some(a => (a.totalScore || 0) >= 50)
    const bestPhase1Score = Math.max(0, ...phase1Attempts.map(a => a.totalScore || 0))
    const bestPhase2Score = Math.max(0, ...phase2Attempts.map(a => a.totalScore || 0))

    return {
      domain,
      phase1: { attempted: phase1Attempts.length > 0, passed: phase1Passed, bestScore: bestPhase1Score },
      phase2: { attempted: phase2Attempts.length > 0, passed: phase2Passed, bestScore: bestPhase2Score, unlocked: phase1Passed }
    }
  })

  return res.json(new ApiResponse(200, { domains: domainStatus }))
})

module.exports = {
  startExam, startDemoExam, getAttempt, submitAnswer, submitExam,
  reportTabSwitch, reportViolation, heartbeat,
  submitPhase2Project, getExamHistory, getDomains
}