const prisma = require('../config/database')
const { ApiError } = require('../utils/ApiError')
const { ApiResponse } = require('../utils/ApiResponse')
const asyncHandler = require('../utils/asyncHandler')
// examGradingQueue.add() falls back to running gradeAttempt() inline (DB-only)
// automatically whenever Redis/Bull is unavailable — see src/queues/index.js.
// No isQueueAvailable() branching needed here; always go through the queue.
const queues = require('../queues')
const { defaultOpts } = queues
const { getPhase1Questions } = require('../services/examService')
const { getCategoryCountsForDomains } = require('../services/questionStatsService')
const { generatePhase2Questions } = require('../ai/evaluationEngine')
const { analyzeGithubRepo, classifyRepoDomain, domainsAreCompatible, aiAnalyzeDomainMatch } = require('../ai/githubAnalyzer')
const { analyzeZip } = require('../ai/zipAnalyzer')
const creditService = require('../services/creditService')
const multer = require('multer')
const fs = require('fs')
const path = require('path')
const os = require('os')
const {
  EXAM_CATEGORIES,
  DIFFICULTY_CONFIG,
  computeTimeLimit,
  MIN_QUESTIONS,
  MAX_QUESTIONS,
  DEFAULT_QUESTIONS,
  BASE_BUFFER_SEC,
  PHASE2_DIFFICULTY_CONFIG,
  PHASE2_MIN_QUESTIONS,
  PHASE2_MAX_QUESTIONS,
  PHASE2_DEFAULT_QUESTIONS,
  computePhase2TimeLimit,
} = require('../config/examCategories')

// Phase 2 project ZIP upload — same memory-storage pattern used in
// projectController.js. Kept here (rather than shared) since the exam route
// wires it directly via `upload.single('zipFile')`.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } })

// POST /check-github-domain
// Combo (Phase 1 + Phase 2 in one flow) needs to validate the candidate's
// GitHub repo BEFORE Phase 1 even starts — otherwise they could pass Phase 1,
// burn a Phase 2 credit, and only then discover the repo doesn't match the
// domain.
//
// This is the single strictest domain gate in the product: a combo run
// commits the candidate to BOTH phases up front, so a wrong "match" here is
// the most expensive mistake to let through. It uses the AI domain analyzer
// (aiAnalyzeDomainMatch — reads actual code content, not just tech-stack
// keywords/file paths) as the authoritative verdict, with the cheap
// classifyRepoDomain heuristic run first purely as an instant, free
// short-circuit for the obvious-mismatch case (saves an AI call when the
// tech stack alone already rules a domain out) — it is NEVER used to wave a
// submission through on its own, only to reject early.
const checkGithubDomain = asyncHandler(async (req, res) => {
  const { domain, githubUrl } = req.body
  if (!domain) throw new ApiError(400, 'domain is required')
  if (!githubUrl || !githubUrl.trim()) throw new ApiError(400, 'githubUrl is required')

  let context
  try {
    context = await analyzeGithubRepo(githubUrl.trim())
  } catch (err) {
    throw new ApiError(400, `Could not analyze that repository: ${err.message}`)
  }

  // Fast, free short-circuit: only acts on a confident heuristic mismatch,
  // never on a heuristic "match" (which could still be wrong — see
  // aiAnalyzeDomainMatch's docstring).
  const heuristic = classifyRepoDomain(context)
  if (heuristic.confidence === 'high' && !domainsAreCompatible(domain, heuristic)) {
    return res.status(200).json(new ApiResponse(200, {
      compatible: false,
      detectedDomain: heuristic.domain,
      message: `This repo looks like ${heuristic.domain}, not ${domain}. A certificate can only be earned when the repo's domain matches your exam domain.`
    }))
  }

  let verdict
  try {
    verdict = await aiAnalyzeDomainMatch({
      targetDomain: domain,
      techStack: context.techStack,
      fileTree: context.fileTree,
      fileContents: context.fileContents,
    })
  } catch (err) {
    throw new ApiError(502, `Could not verify this repository's domain right now: ${err.message}. Please try again.`)
  }

  // Combo is the strictest flow in the product — a low-confidence "match" is
  // not good enough to greenlight committing to both phases at once.
  const compatible = verdict.matches && verdict.confidence >= 60

  return res.status(200).json(new ApiResponse(200, {
    compatible,
    detectedDomain: verdict.detectedDomain,
    confidence: verdict.confidence,
    reasoning: verdict.reasoning,
    message: compatible
      ? 'Repo matches the selected domain.'
      : `This repo looks like ${verdict.detectedDomain || 'a different domain'}, not ${domain}. ${verdict.reasoning || ''} A certificate can only be earned when the repo's domain matches your exam domain.`
  }))
})

// POST /start
const startExam = asyncHandler(async (req, res) => {
  const { domain, phase, category, difficulty = 'medium', questionCount = 25 } = req.body
  const userId = req.user.id

  // Phase 2 no longer requires passing Phase 1 first — both phases are
  // independently accessible for any domain (Frontend/Backend/Full Stack/etc).

  // Check for any in-progress attempt. Previously this just threw a 400 and
  // relied on the frontend to resume it — but that meant a candidate who
  // picked a NEW config (different questionCount/difficulty) on a retry
  // would silently get dropped back into their OLD attempt with the OLD
  // settings (wrong question count, wrong time limit) instead of the exam
  // they just configured. A fresh "Start" click is always an intentional
  // restart, so we abandon the stale attempt and create a new one instead.
  const inProgress = await prisma.examAttempt.findFirst({
    where: { userId, domain, phase, status: { in: ['pending', 'in_progress'] } }
  })
  if (inProgress) {
    await prisma.examAttempt.update({
      where: { id: inProgress.id },
      data: { status: 'abandoned', submittedAt: new Date() }
    })
  }

  // Credit gate — self-serve certification attempts only.
  // Phase 1 costs 1 skill credit. Phase 2 also costs 1 skill credit.
  // No plan is unlimited — every attempt (including premium) draws a real
  // skill credit. Pipeline-linked attempts skip this (handled separately).
  if (phase === 1 || phase === 2) {
    await creditService.consumeCredit(userId, 'skill', { domain, phase })
  }

  let questions = []

  // Phase 1: time scales with question count + difficulty (harder = more
  // time per question). Phase 2: candidate still picks difficulty + how many
  // AI-generated questions they want (3-10) — that also drives the time
  // limit — but the questions themselves aren't generated until the
  // candidate submits their GitHub URL / ZIP via /phase2/project.
  const phase2QuestionCount = Math.max(
    PHASE2_MIN_QUESTIONS,
    Math.min(PHASE2_MAX_QUESTIONS, Number(questionCount) || PHASE2_DEFAULT_QUESTIONS)
  )
  // FIX: Phase 1's question-count bound was only ever applied inside
  // computeTimeLimit() (for the time-limit calc) — the raw, client-supplied
  // `questionCount` was passed straight into getPhase1Questions() and into
  // the stored attempt. The Configure Exam modal clamps to [MIN_QUESTIONS,
  // MAX_QUESTIONS] client-side, but nothing stopped a direct API call from
  // requesting e.g. 500 questions (mismatched against the time limit that
  // was computed for a bounded count), or 0/negative values. Clamp here the
  // same way Phase 2 already does.
  const phase1QuestionCount = Math.max(
    MIN_QUESTIONS,
    Math.min(MAX_QUESTIONS, Number(questionCount) || DEFAULT_QUESTIONS)
  )
  const timeLimitSec = phase === 1
    ? computeTimeLimit(difficulty, phase1QuestionCount)
    : computePhase2TimeLimit(difficulty, phase2QuestionCount)

  if (phase === 1) {
    questions = await getPhase1Questions(domain, phase1QuestionCount, category, difficulty)
  }
  // Phase 2 questions generated after project is submitted via /phase2/project

  const attempt = await prisma.examAttempt.create({
    data: {
      userId,
      domain,
      phase,
      status: 'in_progress',
      category: phase === 1 ? category : null,
      level: difficulty,
      difficulty, // stable copy — `level` gets overwritten with the post-grading proficiency tier
      questionCount: phase === 1 ? questions.length : phase2QuestionCount,
      questions,
      answers: {},
      startedAt: new Date(),
      timeLimitSec,
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
    phase,
    category: attempt.category,
    difficulty: attempt.level,
    questionCount: attempt.questionCount
  }))
})

// POST /demo/start — free practice attempt, unlimited, no certificate.
// Lets a user try the exam experience before spending their monthly credit.
const startDemoExam = asyncHandler(async (req, res) => {
  const { domain, category } = req.body
  const userId = req.user.id

  const inProgress = await prisma.examAttempt.findFirst({
    where: { userId, domain, source: 'demo', status: { in: ['pending', 'in_progress'] } }
  })
  if (inProgress) throw new ApiError(400, 'You already have an in-progress demo attempt for this domain')

  const questions = await getPhase1Questions(domain, 5, category, 'medium')

  const attempt = await prisma.examAttempt.create({
    data: {
      userId,
      domain,
      phase: 1,
      status: 'in_progress',
      category: category || null,
      level: 'medium',
      questionCount: questions.length,
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
    where: { id: req.params.id, userId: req.user.id },
    include: { certificate: { select: { id: true, verificationId: true } } }
  })
  if (!attempt) throw new ApiError(404, 'Attempt not found')

  // Work out whether the OTHER phase (for this same domain) has already
  // been completed by this user. The frontend needs this for two things:
  //   1. Phase 2 lobby — only offer "Skip Phase 2 -> see Phase 1 result"
  //      when a Phase 1 attempt for this domain actually exists. Phase 2
  //      can be started completely standalone, so this is NOT always true.
  //   2. Result page — only claim "Both Phases Passed" / combo-certificate
  //      messaging when Phase 1 was genuinely passed too, instead of
  //      assuming it every time Phase 2 is passed.
  const otherPhase = attempt.phase === 1 ? 2 : 1
  let otherPhaseInfo = null
  if (attempt.source !== 'demo') {
    const otherAttempts = await prisma.examAttempt.findMany({
      where: {
        userId: attempt.userId,
        domain: attempt.domain,
        phase: otherPhase,
        status: 'completed',
        source: { not: 'demo' }
      },
      orderBy: { totalScore: 'desc' },
      select: { id: true, totalScore: true },
      take: 1
    })
    const best = otherAttempts[0]
    if (best) {
      otherPhaseInfo = { attemptId: best.id, passed: (best.totalScore || 0) >= 50 }
    }
  }

  // Strip correct answers from questions ONLY while the attempt is still
  // active — once it's completed/terminated the candidate is reviewing
  // their result, and the correct-answer breakdown is exactly what powers
  // that review (see evaluationReport for Phase 1/2 wrong-answer detail).
  const stillActive = attempt.status === 'in_progress' || attempt.status === 'pending'
  const isPipeline = attempt.source === 'pipeline'
  const safeAttempt = {
    ...attempt,
    // For pipeline exams, hide scores and evaluation from the candidate
    // (recruiter still sees them in the pipeline dashboard)
    totalScore: isPipeline ? null : attempt.totalScore,
    level: isPipeline ? null : attempt.level,
    evaluationReport: isPipeline ? null : attempt.evaluationReport,
    questions: (attempt.questions || []).map(q => {
      if (!stillActive) return q
      const { answer, ...safe } = q
      return safe
    }),
    otherPhase: otherPhaseInfo,
    // Pipeline exams show a generic "under review" message instead of scores
    pipelineExam: isPipeline
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
// Accepts EITHER a GitHub repo URL OR an uploaded ZIP file for a single-stack
// domain (req.body.githubUrl / req.files.zipFile) — exactly one is required.
//
// For the 'Full Stack' domain, one project isn't enough to probe both halves
// of the stack, so this instead requires BOTH a frontend project AND a
// backend project — each independently either a GitHub URL or a ZIP
// (req.body.frontendGithubUrl/backendGithubUrl, req.files.frontendZip/backendZip).
// Both are analyzed separately then merged into a single AI context so the
// generated questions draw from the whole submission.
const submitPhase2Project = asyncHandler(async (req, res) => {
  const { githubUrl, frontendGithubUrl, backendGithubUrl } = req.body
  const { id } = req.params
  const files = req.files || {}

  const attempt = await prisma.examAttempt.findFirst({
    where: { id, userId: req.user.id, phase: 2, status: 'in_progress' }
  })
  if (!attempt) throw new ApiError(404, 'Active Phase 2 attempt not found')

  const isFullStack = attempt.domain === 'Full Stack'
  const tmpFiles = []
  let context
  let projectRef

  try {
    if (isFullStack) {
      const frontendZip = files.frontendZip?.[0]
      const backendZip = files.backendZip?.[0]

      if (!frontendGithubUrl && !frontendZip) {
        throw new ApiError(400, 'Provide a frontend GitHub URL or ZIP file')
      }
      if (frontendGithubUrl && frontendZip) {
        throw new ApiError(400, 'Provide either a frontend GitHub URL or ZIP, not both')
      }
      if (!backendGithubUrl && !backendZip) {
        throw new ApiError(400, 'Provide a backend GitHub URL or ZIP file')
      }
      if (backendGithubUrl && backendZip) {
        throw new ApiError(400, 'Provide either a backend GitHub URL or ZIP, not both')
      }

      const [frontendContext, frontendRef] = await analyzeProjectSide('frontend', frontendGithubUrl, frontendZip, id, tmpFiles)
      const [backendContext, backendRef] = await analyzeProjectSide('backend', backendGithubUrl, backendZip, id, tmpFiles)

      // Domain gate for the Full Stack COMBO submission — this previously had
      // NO validation at all: a candidate could submit two Backend repos (or
      // even swap the frontend/backend slots) and it would sail straight
      // through to question generation. Full Stack is the two-project combo
      // case, so it deserves the strictest check in the product: each half
      // is independently verified against its own expected sub-domain via the
      // AI analyzer (sampleLabel tells the model which half it's looking at,
      // so a plain "Frontend"/"Backend" verdict on the matching half still
      // counts as a pass — see DOMAIN_ANALYZER_SYSTEM's special case).
      await assertDomainMatches('Frontend', frontendContext, 'frontend')
      await assertDomainMatches('Backend', backendContext, 'backend')

      context = mergeProjectContexts(frontendContext, backendContext)
      projectRef = `frontend:${frontendRef} | backend:${backendRef}`
    } else {
      const zipFile = files.zipFile?.[0]
      if (!githubUrl && !zipFile) {
        throw new ApiError(400, 'Provide a GitHub repository URL or upload a ZIP of your project for Phase 2')
      }
      if (githubUrl && zipFile) {
        throw new ApiError(400, 'Provide either a GitHub URL or a ZIP file, not both')
      }

      if (githubUrl) {
        context = await analyzeGithubRepo(githubUrl)
        projectRef = githubUrl
      } else {
        const tmpZipPath = path.join(os.tmpdir(), `phase2-${id}-${Date.now()}.zip`)
        fs.writeFileSync(tmpZipPath, zipFile.buffer)
        tmpFiles.push(tmpZipPath)
        context = await analyzeZip(tmpZipPath)
        projectRef = `zip:${zipFile.originalname}`
      }

      // Domain gate — do this BEFORE spending an AI call on question
      // generation, and for BOTH submission methods (GitHub URL or ZIP
      // upload). A certificate can only be earned when the submitted
      // project actually matches the domain the candidate is being examined
      // in (e.g. picking "Frontend" must not be satisfiable with a Backend
      // repo/zip, and vice versa), so a mismatch here should stop the
      // attempt cold rather than generate questions for a project that can
      // never lead to a certificate.
      await assertDomainMatches(attempt.domain, context)
    }
  } catch (err) {
    if (err instanceof ApiError) throw err
    throw new ApiError(400, `Could not analyze your project: ${err.message}`)
  } finally {
    tmpFiles.forEach((p) => fs.unlink(p, () => {}))
  }

  context.title = `${attempt.domain} Project`
  context.domain = attempt.domain

  // Honor the difficulty + question count the candidate picked when they
  // started Phase 2 (defaults kept for older attempts created before this
  // config existed).
  const difficulty = attempt.level || 'medium'
  const difficultyCfg = PHASE2_DIFFICULTY_CONFIG[difficulty] || PHASE2_DIFFICULTY_CONFIG.medium
  const questionCount = Math.max(
    PHASE2_MIN_QUESTIONS,
    Math.min(PHASE2_MAX_QUESTIONS, attempt.questionCount || PHASE2_DEFAULT_QUESTIONS)
  )

  let rawQuestions
  try {
    rawQuestions = await generatePhase2Questions(context, questionCount, difficultyCfg.description, difficulty)
  } catch (err) {
    // Surface the real cause (bad/missing AI provider key, rate limit,
    // malformed AI response, etc.) instead of letting this bubble up as an
    // unhandled 500 with no message — that's what previously showed up on
    // the frontend as the generic "Could not analyze your project" fallback.
    console.error('[Phase2] AI question generation failed:', err.message)
    throw new ApiError(502, `Question generation failed: ${err.message}. Your repo was analyzed fine — please try submitting again.`)
  }

  if (!Array.isArray(rawQuestions) || rawQuestions.length === 0) {
    throw new ApiError(500, 'Failed to generate questions from your project')
  }

  const questions = rawQuestions.slice(0, questionCount)

  await prisma.examAttempt.update({
    where: { id },
    data: {
      questions,
      answers: {},
      projectId: projectRef
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

// Shared domain gate for single-domain (non-Full-Stack) Phase 2 submissions.
// Uses the AI domain analyzer (real code content, not just tech-stack
// keywords/file paths) as the authoritative verdict — classifyRepoDomain is
// only used first as a free, instant short-circuit for an obvious mismatch,
// exactly like checkGithubDomain above. Throws a 400 if the project doesn't
// match the domain the candidate selected for this attempt.
async function assertDomainMatches(examDomain, context, sampleLabel = null) {
  const heuristic = classifyRepoDomain(context)
  if (heuristic.confidence === 'high' && !domainsAreCompatible(examDomain, heuristic)) {
    throw new ApiError(
      400,
      `Domain mismatch: this project looks like ${heuristic.domain}, but you're taking the ` +
      `${examDomain} exam. A certificate can only be earned when the project's domain matches ` +
      `your exam domain — submit a ${examDomain} project to continue, or exit and start a new ` +
      `${heuristic.domain} exam instead.`
    )
  }

  let verdict
  try {
    verdict = await aiAnalyzeDomainMatch({
      targetDomain: examDomain,
      techStack: context.techStack,
      fileTree: context.fileTree,
      fileContents: context.fileContents,
      sampleLabel,
    })
  } catch (err) {
    throw new ApiError(502, `Could not verify your project's domain right now: ${err.message}. Please try submitting again.`)
  }

  if (!verdict.matches || verdict.confidence < 60) {
    throw new ApiError(
      400,
      `Domain mismatch: this project looks like ${verdict.detectedDomain || 'a different domain'}, but you're ` +
      `taking the ${examDomain} exam. ${verdict.reasoning || ''} A certificate can only be earned when the ` +
      `project's domain matches your exam domain — submit a ${examDomain} project to continue, or exit and ` +
      `start a new exam in the domain that matches your project instead.`
    )
  }
}

// Analyzes one side (frontend or backend) of a Full Stack Phase 2 submission —
// either a GitHub URL or an uploaded ZIP — and returns [context, ref] where
// ref is a human-readable label for what was submitted (stored on the attempt).
async function analyzeProjectSide(label, githubUrl, zipFile, attemptId, tmpFiles) {
  if (githubUrl) {
    const context = await analyzeGithubRepo(githubUrl)
    return [context, githubUrl]
  }
  const tmpZipPath = path.join(os.tmpdir(), `phase2-${attemptId}-${label}-${Date.now()}.zip`)
  fs.writeFileSync(tmpZipPath, zipFile.buffer)
  tmpFiles.push(tmpZipPath)
  const context = await analyzeZip(tmpZipPath)
  return [context, `zip:${zipFile.originalname}`]
}

// Combines a frontend + backend analysis into one project context shaped the
// same way a single-project analysis is (techStack, fileTree, fileContents),
// so generatePhase2Questions doesn't need to know about Full Stack at all.
// Each side's file content is capped so the merged total stays within the
// same budget a single-project submission would use.
const MERGED_CONTENT_CHAR_BUDGET = 15000
function mergeProjectContexts(frontendContext, backendContext) {
  const perSideBudget = Math.floor(MERGED_CONTENT_CHAR_BUDGET / 2)
  const frontendContent = (frontendContext.fileContents || '').slice(0, perSideBudget)
  const backendContent = (backendContext.fileContents || '').slice(0, perSideBudget)

  return {
    techStack: [...new Set([...(frontendContext.techStack || []), ...(backendContext.techStack || [])])],
    fileTree: { frontend: frontendContext.fileTree, backend: backendContext.fileTree },
    fileContents: `--- FRONTEND ---\n${frontendContent}\n\n--- BACKEND ---\n${backendContent}`,
  }
}

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
    attempts: attempts.map(a => ({
      ...a,
      // Hide scores for pipeline exams (recruiter sees them, candidate doesn't)
      totalScore: a.source === 'pipeline' ? null : a.totalScore,
      level: a.source === 'pipeline' ? null : a.level,
    })),
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
  const DOMAINS = Object.keys(EXAM_CATEGORIES)
  const userId = req.user.id

  const attempts = await prisma.examAttempt.findMany({
    where: { userId, status: 'completed', source: { notIn: ['demo', 'pipeline'] } },
    select: { domain: true, phase: true, totalScore: true }
  })

  // Per-category question availability (easy/medium/hard/total), read from
  // the small pre-aggregated QuestionBankStats table — NOT a live COUNT over
  // QuestionBank. One query for all domains at once.
  const categoryCountsByDomain = await getCategoryCountsForDomains(DOMAINS, 1)

  const domainStatus = DOMAINS.map(domain => {
    const phase1Attempts = attempts.filter(a => a.domain === domain && a.phase === 1)
    const phase2Attempts = attempts.filter(a => a.domain === domain && a.phase === 2)

    const phase1Passed = phase1Attempts.some(a => (a.totalScore || 0) >= 50)
    const phase2Passed = phase2Attempts.some(a => (a.totalScore || 0) >= 50)
    const bestPhase1Score = Math.max(0, ...phase1Attempts.map(a => a.totalScore || 0))
    const bestPhase2Score = Math.max(0, ...phase2Attempts.map(a => a.totalScore || 0))

    // { [category]: { easy, medium, hard, total } } — lets the exam config
    // slider cap itself to what's actually available instead of always
    // offering up to MAX_QUESTIONS regardless of the question bank.
    const questionCounts = categoryCountsByDomain[domain] || {}

    // Sub-domains (categories) shown to the candidate are driven by what's
    // actually sitting in the question bank right now — NOT the full static
    // EXAM_CATEGORIES list. A category with 0 active Phase 1 questions
    // (nothing seeded/added for it yet) is dropped instead of being offered
    // as a pickable pill that only fails once selected.
    const categories = Object.keys(questionCounts).filter(cat => questionCounts[cat].total > 0)

    return {
      domain,
      categories,
      categoryQuestionCounts: questionCounts,
      // Lets the frontend disable/grey out a domain card entirely (instead
      // of showing "Start P1" for a domain with nothing in the bank yet).
      hasQuestions: categories.length > 0,
      phase1: { attempted: phase1Attempts.length > 0, passed: phase1Passed, bestScore: bestPhase1Score },
      phase2: { attempted: phase2Attempts.length > 0, passed: phase2Passed, bestScore: bestPhase2Score, unlocked: true },
      // Combo certificate applies only when BOTH phases have been passed
      // independently — this is distinct from just passing Phase 2 alone.
      combo: { passed: phase1Passed && phase2Passed }
    }
  })

  // Difficulty presets so the frontend can render options + live time estimate
  // without duplicating the formula.
  const difficulties = Object.entries(DIFFICULTY_CONFIG).map(([value, cfg]) => ({
    value,
    label: cfg.label,
    secPerQuestion: cfg.secPerQuestion
  }))

  const phase2Difficulties = Object.entries(PHASE2_DIFFICULTY_CONFIG).map(([value, cfg]) => ({
    value,
    label: cfg.label,
    secPerQuestion: cfg.secPerQuestion,
    description: cfg.description
  }))

  return res.json(new ApiResponse(200, {
    domains: domainStatus,
    difficulties,
    questionCount: { min: MIN_QUESTIONS, max: MAX_QUESTIONS, default: DEFAULT_QUESTIONS },
    baseBufferSec: BASE_BUFFER_SEC,
    phase2: {
      difficulties: phase2Difficulties,
      questionCount: { min: PHASE2_MIN_QUESTIONS, max: PHASE2_MAX_QUESTIONS, default: PHASE2_DEFAULT_QUESTIONS },
    },
  }))
})

module.exports = {
  startExam, startDemoExam, getAttempt, submitAnswer, submitExam,
  reportTabSwitch, reportViolation, heartbeat,
  submitPhase2Project, getExamHistory, getDomains,
  checkGithubDomain,
  upload,
}