/**
 * pipelineService.js — Recruiter Hiring Pipeline v2
 *
 * PIPELINE STAGES:
 *   applied → screened → [assignment_sent → assignment_submitted → project_evaluated] →
 *   [exam_phase1_sent → exam_phase1_completed → [exam_phase2_sent → exam_phase2_completed]] →
 *   ranked → selected | rejected
 *
 * NEW IN V2:
 * 1. Assignment split: assignmentBrief (student-visible) + assignmentEvalCriteria (private AI scoring)
 *    - Assignment deadline is an absolute date set by recruiter (must be > posting createdAt)
 *    - AI evaluates project against criteria, not generic scoring
 *
 * 2. Two-phase exam in pipeline:
 *    - Phase 1: MCQ in recruiter-chosen domain (from question bank)
 *    - Phase 2 (if enabled + student submitted project): AI generates code + typing questions
 *    - Phase 2 only triggers after project is submitted; if no project, phase 2 skipped
 *
 * 3. Manual mode: recruiter manually triggers each stage transition
 *    - Auto stages disabled; recruiter sees "awaiting your action" UI
 *    - Recruiter can reject at any stage with a reason
 *    - Stage reminders sent to recruiter for pending actions
 *
 * 4. Notifications: student notified when they pass each stage
 *    - Skill match notification on application creation
 *
 * 5. Hiring credits: 1 credit per posting activation (free first cycle)
 */

const prisma = require('../config/database')
const { callAIForJSON } = require('../ai/aiProvider')
const PROMPTS = require('../ai/promptTemplates')
const { generatePhase2Questions, evaluatePhase2Answers } = require('../ai/evaluationEngine')
const { calculateLevel, fishYatesShuffle } = require('../utils/scoreUtils')
const { computeRuleScore, getCandidateSkillNames } = require('./skillMatchService')
const { parseAndCacheResume } = require('./resumeParser')
const queues = require('../queues')
const { defaultOpts } = queues
const notificationService = require('./notificationService')

const DEFAULT_WEIGHTS = { ruleScore: 20, aiMatchScore: 20, projectScore: 30, examScore: 30 }
const SHARED_BANK_QUESTIONS_PER_EXAM = 20
const PERSONALIZED_QUESTIONS_COUNT = 5

// ─── Stage history ────────────────────────────────────────────────────────────

async function recordStageEvent(applicationId, stage) {
  await prisma.applicationStageEvent.create({ data: { applicationId, stage } }).catch(() => {})
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function loadApplicationFull(applicationId) {
  return prisma.application.findUnique({
    where: { id: applicationId },
    include: {
      user: { select: { id: true, name: true, email: true } },
      jobPosting: { include: { requiredSkills: { include: { skill: true } } } }
    }
  })
}

function effectiveWeights(jobPosting) {
  const weights = jobPosting.scoringWeights || DEFAULT_WEIGHTS
  if (jobPosting.examEnabled) return { ...DEFAULT_WEIGHTS, ...weights }

  const w = { ...DEFAULT_WEIGHTS, ...weights, examScore: 0 }
  const restTotal = w.ruleScore + w.aiMatchScore + w.projectScore
  const examWeight = (jobPosting.scoringWeights?.examScore ?? DEFAULT_WEIGHTS.examScore)
  if (restTotal > 0) {
    const scale = (restTotal + examWeight) / restTotal
    w.ruleScore = Math.round(w.ruleScore * scale)
    w.aiMatchScore = Math.round(w.aiMatchScore * scale)
    w.projectScore = Math.round(w.projectScore * scale)
  }
  return w
}

async function enqueueStatusEmail(applicationId, emailType, extra = {}) {
  await queues.emailQueue.add({ type: 'application_status', applicationId, emailType, ...extra }, defaultOpts)
}

function rejectionReasonFromSkills(missingSkills, ruleScore, threshold) {
  if (missingSkills.length === 0) {
    return `Your overall profile match (${ruleScore}%) was below this role's screening threshold (${threshold}%).`
  }
  return `Skill match ${ruleScore}% — required skills missing: ${missingSkills.join(', ')}.`
}

// ─── Notification helpers ─────────────────────────────────────────────────────

async function notifyStudent(userId, { type, title, message, data = {} }) {
  await notificationService.create(userId, { type, title, message, data }).catch(() => {})
}

async function notifyRecruiter(recruiterId, { type, title, message, data = {} }) {
  await prisma.recruiterNotification.create({
    data: { recruiterId, type, title, message, data }
  }).catch(() => {})
}

// Remind recruiter of pending manual action
async function sendRecruiterStageReminder(applicationId) {
  const app = await loadApplicationFull(applicationId)
  if (!app) return
  const recruiterId = app.jobPosting.recruiterId

  await notifyRecruiter(recruiterId, {
    type: 'manual_stage_reminder',
    title: `⏳ Action needed: ${app.user.name}`,
    message: `Application from ${app.user.name} for "${app.jobPosting.title}" is waiting for your review at stage: ${app.stage}.`,
    data: { applicationId, stage: app.stage, jobPostingId: app.jobPosting.id }
  })

  await queues.emailQueue.add({
    type: 'recruiter_stage_reminder',
    applicationId,
    stage: app.stage,
    recruiterId
  }, { ...defaultOpts, delay: 0 })
}

// ─── Stage 0 — Application created ───────────────────────────────────────────

async function createApplication({ jobPostingId, userId, resumeUrl, coverNote }) {
  const jobPosting = await prisma.jobPosting.findUnique({
    where: { id: jobPostingId },
    include: { requiredSkills: { include: { skill: true } } }
  })
  if (!jobPosting) throw new Error('Job posting not found')

  // Block applications after deadline has passed
  if (jobPosting.applicationDeadline && new Date(jobPosting.applicationDeadline) <= new Date()) {
    throw new Error('The application deadline for this posting has passed. No new applications are being accepted.')
  }

  const existing = await prisma.application.findUnique({
    where: { jobPostingId_userId: { jobPostingId, userId } }
  })
  if (existing) return existing

  let application
  try {
    application = await prisma.application.create({
      data: {
        jobPostingId, userId, resumeUrl,
        coverNote: coverNote || null,
        stage: 'applied',
        status: 'in_progress'
      }
    })
  } catch (err) {
    // Unique constraint race: two near-simultaneous submissions (e.g. a
    // slow first request retried by the client, or a double network send)
    // both passed the pre-check above before either row existed. Whoever
    // loses the race must NOT surface as an error — the application the
    // person wanted now exists, so return it exactly as if this call had
    // created it.
    if (err?.code === 'P2002') {
      const winner = await prisma.application.findUnique({
        where: { jobPostingId_userId: { jobPostingId, userId } }
      })
      if (winner) return winner
    }
    throw err
  }

  // From here on, the application row is committed. None of the following
  // side effects are allowed to turn a successful submission into a client-
  // visible failure — each is independently best-effort.
  try { await recordStageEvent(application.id, 'applied') } catch {}
  try { await enqueueStatusEmail(application.id, 'application_received') } catch {}

  // Skill match notification — check if candidate skills match job requirements
  try { await checkAndNotifySkillMatch(application.id, userId, jobPosting) } catch {}

  // Check application deadline — delay pipeline start if deadline not reached
  if (jobPosting.applicationDeadline) {
    const deadline = new Date(jobPosting.applicationDeadline)
    if (deadline > new Date()) {
      // Don't start pipeline yet — will be picked up by deadline worker
      return application
    }
  }

  try {
    await queues.applicationQueue.add({ applicationId: application.id, action: 'stage1_screen' }, defaultOpts)
  } catch {}

  return application
}

async function checkAndNotifySkillMatch(applicationId, userId, jobPosting) {
  try {
    const { skillNames } = await getCandidateSkillNames(userId)
    const requiredSkills = jobPosting.requiredSkills.map(rs => rs.skill.name.toLowerCase())
    const candidateSkillsLower = skillNames.map(s => s.toLowerCase())
    const matched = requiredSkills.filter(s => candidateSkillsLower.includes(s))
    const matchPct = requiredSkills.length > 0 ? Math.round((matched.length / requiredSkills.length) * 100) : 0

    if (matchPct >= 70) {
      await notifyStudent(userId, {
        type: 'skill_match',
        title: '🎯 Strong skill overlap!',
        // Deliberately not "you're a great fit" — this % is required-skill
        // overlap only. Final screening also weighs experience and an AI
        // resume/JD match score, so a candidate can see 100% here and still
        // be screened out. Overstating this caused real confusion.
        message: `Your profile has ${matchPct}% of the required skills for "${jobPosting.title}". Screening also considers experience and resume fit, so this isn't a guaranteed pass — but it's a strong signal.`,
        data: { applicationId, jobPostingId: jobPosting.id, matchPct, matchedSkills: matched }
      })
    }
  } catch {}
}

// ─── Deadline processing — start pipelines after deadline passes ──────────────

async function processDeadlineApplications() {
  const now = new Date()
  const postings = await prisma.jobPosting.findMany({
    where: {
      status: 'active',
      applicationDeadline: { not: null, lte: now }
    }
  })

  for (const posting of postings) {
    const pendingApps = await prisma.application.findMany({
      where: {
        jobPostingId: posting.id,
        stage: 'applied'
      }
    })
    for (const app of pendingApps) {
      try {
        await queues.applicationQueue.add({ applicationId: app.id, action: 'stage1_screen' }, defaultOpts)
      } catch {}
    }
    // Clear deadline after processing
    await prisma.jobPosting.update({
      where: { id: posting.id },
      data: { applicationDeadline: null }
    })
  }
}

// ─── Stage 1 — Rule-based screening ──────────────────────────────────────────

async function runStage1Screening(applicationId) {
  const application = await loadApplicationFull(applicationId)
  if (!application) return

  if (application.resumeUrl) {
    const parsed = await parseAndCacheResume(application.userId, application.resumeUrl)
    if (parsed?.rawText && !application.resumeText) {
      await prisma.application.update({
        where: { id: applicationId },
        data: { resumeText: parsed.rawText.slice(0, 4000) }
      })
    }
  }

  const { skillNames, experienceYears } = await getCandidateSkillNames(application.userId)
  const requiredSkills = application.jobPosting.requiredSkills.map(rs => ({
    name: rs.skill.name, required: rs.required
  }))
  const { ruleScore, missingSkills } = computeRuleScore({
    candidateSkills: skillNames, requiredSkills,
    minExperience: application.jobPosting.minExperience, experienceYears
  })

  await prisma.application.update({ where: { id: applicationId }, data: { ruleScore, missingSkills } })

  if (ruleScore >= application.jobPosting.ruleScoreThreshold) {
    await queues.applicationQueue.add({ applicationId, action: 'stage2_ai_match' }, defaultOpts)
  } else {
    const rejectionReason = rejectionReasonFromSkills(missingSkills, ruleScore, application.jobPosting.ruleScoreThreshold)
    await prisma.application.update({
      where: { id: applicationId },
      data: { status: 'rejected', rejectionReason }
    })
    await recordStageEvent(applicationId, 'rejected')
    await enqueueStatusEmail(applicationId, 'screening_rejected')
  }
}

// ─── Stage 2 — AI resume/JD match ────────────────────────────────────────────

async function runStage2AIMatch(applicationId) {
  const application = await loadApplicationFull(applicationId)
  if (!application) return

  const requiredSkillNames = application.jobPosting.requiredSkills.map(rs => rs.skill.name)
  const { skillNames } = await getCandidateSkillNames(application.userId)

  let aiMatchScore = application.ruleScore || 0
  let missingSkills = application.missingSkills || []
  let aiReasoning = 'AI match scoring unavailable — used rule-based score.'

  try {
    const result = await callAIForJSON({
      systemPrompt: PROMPTS.RESUME_MATCH_SYSTEM,
      userPrompt: PROMPTS.RESUME_MATCH_USER({
        jobTitle: application.jobPosting.title,
        requiredSkills: requiredSkillNames,
        minExperience: application.jobPosting.minExperience,
        jobDescription: (application.jobPosting.description || '').slice(0, 1200),
        resumeText: (application.resumeText || '').slice(0, 2000),
        candidateSkills: skillNames
      }),
      maxTokens: 300, temperature: 0.2
    })
    aiMatchScore = Math.max(0, Math.min(100, parseInt(result.matchScore) || 0))
    if (Array.isArray(result.missingSkills)) {
      missingSkills = [...new Set([...missingSkills, ...result.missingSkills])]
    }
    aiReasoning = result.reasoning || aiReasoning
  } catch (err) {
    console.error(`[Pipeline] Stage2 AI match failed:`, err.message)
  }

  await prisma.application.update({
    where: { id: applicationId },
    data: { aiMatchScore, missingSkills, aiReasoning }
  })

  if (aiMatchScore >= application.jobPosting.aiMatchThreshold) {
    await prisma.application.update({ where: { id: applicationId }, data: { stage: 'screened' } })
    await recordStageEvent(applicationId, 'screened')
    await enqueueStatusEmail(applicationId, 'shortlisted')

    await notifyStudent(application.userId, {
      type: 'pipeline_stage',
      title: '✅ You passed the screening!',
      message: `Your application for "${application.jobPosting.title}" passed initial screening. Next steps will follow shortly.`,
      data: { applicationId, stage: 'screened' }
    })

    await advanceAfterScreening(applicationId)
  } else {
    const rejectionReason = `AI resume match score (${aiMatchScore}%) was below this role's threshold. ${aiReasoning}`
    await prisma.application.update({
      where: { id: applicationId },
      data: { stage: 'screened', status: 'rejected', rejectionReason }
    })
    await recordStageEvent(applicationId, 'rejected')
    await enqueueStatusEmail(applicationId, 'screening_rejected')
  }
}

// Decide next stage after screening passes
async function advanceAfterScreening(applicationId) {
  const application = await loadApplicationFull(applicationId)
  if (!application) return

  const jp = application.jobPosting

  if (jp.manualMode) {
    // Manual mode: stop here, notify recruiter to take action
    await notifyRecruiter(jp.recruiterId, {
      type: 'manual_action_needed',
      title: `📋 Review ${application.user.name}`,
      message: `${application.user.name} passed screening for "${jp.title}". Manually trigger the next stage.`,
      data: { applicationId, stage: 'screened', jobPostingId: jp.id }
    })
    return
  }

  if (jp.assignmentEnabled && jp.assignmentBrief) {
    await moveToAssignmentSent(applicationId)
  } else if (jp.examEnabled) {
    try {
      await moveToExamPhase1Sent(applicationId)
    } catch (err) {
      console.error(`[Pipeline] Exam creation failed for application ${applicationId}:`, err.message)
      // Record the error so the application isn't silently stuck — recruiter
      // can see the issue and retry, or the reminder worker can pick it up.
      await prisma.application.update({
        where: { id: applicationId },
        data: { pipelineError: `Exam creation failed: ${err.message}` }
      })
      await notifyRecruiter(jp.recruiterId, {
        type: 'manual_action_needed',
        title: `⚠️ Assessment setup failed for ${application.user.name}`,
        message: `Could not create exam for "${jp.title}": ${err.message}`,
        data: { applicationId, stage: 'screened', jobPostingId: jp.id }
      })
    }
  } else {
    await markReadyForRanking(applicationId)
  }
}

// ─── Stage — Assignment ───────────────────────────────────────────────────────

async function moveToAssignmentSent(applicationId) {
  const application = await loadApplicationFull(applicationId)
  if (!application) return

  const jp = application.jobPosting
  let assignmentDeadlineAt = null

  if (jp.assignmentDeadlineDate) {
    // Use absolute date set by recruiter
    assignmentDeadlineAt = new Date(jp.assignmentDeadlineDate)
  } else if (jp.assignmentDeadlineDays) {
    assignmentDeadlineAt = new Date(Date.now() + jp.assignmentDeadlineDays * 24 * 60 * 60 * 1000)
  }

  await prisma.application.update({
    where: { id: applicationId },
    data: { stage: 'assignment_sent', assignmentDeadlineAt }
  })
  await recordStageEvent(applicationId, 'assignment_sent')
  await enqueueStatusEmail(applicationId, 'assignment_sent')

  await notifyStudent(application.userId, {
    type: 'pipeline_stage',
    title: '📝 Assignment received!',
    message: `You have an assignment for "${jp.title}". Submit by ${assignmentDeadlineAt ? new Date(assignmentDeadlineAt).toLocaleDateString() : 'the deadline'}.`,
    data: { applicationId, stage: 'assignment_sent', deadline: assignmentDeadlineAt }
  })
}

/**
 * Student submits their assignment.
 * The student only sees assignmentBrief (what to build).
 * AI evaluates against assignmentEvalCriteria (private).
 */
async function submitAssignment(applicationId, userId, { githubUrl, liveUrl, zipFileUrl, title, description, domain }) {
  const application = await prisma.application.findFirst({
    where: { id: applicationId, userId },
    include: { jobPosting: true }
  })
  if (!application) throw new Error('Application not found')
  if (!['assignment_sent', 'assignment_submitted'].includes(application.stage)) {
    throw new Error(`Cannot submit assignment in stage "${application.stage}"`)
  }

  const jp = application.jobPosting

  let project
  if (application.projectId) {
    project = await prisma.project.update({
      where: { id: application.projectId },
      data: { githubUrl, liveUrl, zipFileUrl, status: 'pending' }
    })
  } else {
    project = await prisma.project.create({
      data: {
        userId,
        title: title || `${jp.title} — Assignment`,
        // Description uses BRIEF (student-visible) not the private eval criteria
        description: description || jp.assignmentBrief,
        githubUrl, liveUrl, zipFileUrl,
        domain: domain || jp.examDomain || 'Full Stack',
        status: 'pending'
      }
    })
  }

  await prisma.application.update({
    where: { id: applicationId },
    data: { stage: 'assignment_submitted', projectId: project.id }
  })
  await recordStageEvent(applicationId, 'assignment_submitted')

  // Queue project evaluation — with private eval criteria injected
  await queues.projectEvalQueue.add({
    projectId: project.id,
    // Pass private eval criteria so evaluationEngine can score against it
    evalCriteria: jp.assignmentEvalCriteria || null
  }, defaultOpts)

  await notifyStudent(userId, {
    type: 'pipeline_stage',
    title: '✅ Assignment submitted!',
    message: `Your assignment for "${jp.title}" is being evaluated. We'll notify you of the result.`,
    data: { applicationId, stage: 'assignment_submitted' }
  })

  return project
}

/**
 * Called when project evaluation finishes.
 * If assignmentEvalCriteria exists, it was used to score the project.
 */
async function onProjectEvaluated(projectId) {
  const application = await prisma.application.findFirst({
    where: { projectId },
    include: { jobPosting: true }
  })
  if (!application) return
  if (application.stage !== 'assignment_submitted') return

  const project = await prisma.project.findUnique({ where: { id: projectId } })
  const projectScore = project?.evaluationReport?.overallScore ?? null

  await prisma.application.update({
    where: { id: application.id },
    data: { stage: 'project_evaluated', projectScore }
  })
  await recordStageEvent(application.id, 'project_evaluated')

  const jp = application.jobPosting
  const passed = projectScore == null || projectScore >= 40  // lenient threshold

  if (!passed) {
    // Project failed assignment evaluation — reject
    await prisma.application.update({
      where: { id: application.id },
      data: {
        status: 'rejected',
        rejectionReason: `Your assignment project score (${Math.round(projectScore)}/100) did not meet the requirement for this role.`
      }
    })
    await recordStageEvent(application.id, 'rejected')
    await enqueueStatusEmail(application.id, 'assignment_rejected')
    return
  }

  await notifyStudent(application.userId, {
    type: 'pipeline_stage',
    title: '🎉 Assignment passed!',
    message: `Your project for "${jp.title}" was evaluated${projectScore != null ? ` — score: ${Math.round(projectScore)}/100` : ''}. Moving to next stage!`,
    data: { applicationId: application.id, stage: 'project_evaluated', projectScore }
  })

  if (jp.manualMode) {
    await notifyRecruiter(jp.recruiterId, {
      type: 'manual_action_needed',
      title: `📁 Project ready: ${application.user?.name || 'Candidate'}`,
      message: `Assignment project evaluated for "${jp.title}". Score: ${projectScore != null ? Math.round(projectScore) : 'N/A'}. Take the next action.`,
      data: { applicationId: application.id, stage: 'project_evaluated', jobPostingId: jp.id }
    })
    return
  }

  if (jp.examEnabled) {
    await moveToExamPhase1Sent(application.id)
  } else {
    await markReadyForRanking(application.id)
  }
}

// ─── Stage — Exam Phase 1 (MCQ) ───────────────────────────────────────────────

async function ensureQuestionBank(jobPosting) {
  if (Array.isArray(jobPosting.questionBank) && jobPosting.questionBank.length > 0) {
    return jobPosting.questionBank
  }

  const LEVEL_MAP = { easy: 'Beginner', medium: 'Intermediate', hard: 'Expert' }
  const difficulty = jobPosting.examDifficulty || 'mixed'
  const categories = jobPosting.examCategories || (jobPosting.examCategory ? [jobPosting.examCategory] : [])
  const domain = jobPosting.examDomain || 'Full Stack'

  // Always filter by the recruiter's selected categories — never mix in
  // questions from unrelated categories (e.g. React questions for a Node.js exam).
  const categoryFilter = categories.length > 0 ? { category: { in: categories } } : {}

  const where = {
    domain,
    phase: 1,
    isActive: true,
    ...categoryFilter
  }

  // Apply difficulty filter unless mixed
  if (difficulty !== 'mixed' && LEVEL_MAP[difficulty]) {
    where.level = LEVEL_MAP[difficulty]
  }

  let rows = await prisma.questionBank.findMany({ where })

  // If not enough with strict difficulty, drop difficulty but KEEP category filter
  if (rows.length < SHARED_BANK_QUESTIONS_PER_EXAM && difficulty !== 'mixed') {
    const fallback = { domain, phase: 1, isActive: true, ...categoryFilter }
    rows = await prisma.questionBank.findMany({ where: fallback })
  }

  const label = categories.length > 0
    ? `${domain} / ${categories.join(',')}`
    : `${domain} (all)`

  if (rows.length > 0) {
    console.log(`[QuestionBank] Selected ${rows.length} questions from: ${label}`)
  }

  const bank = rows.map(q => ({
    id: q.id,
    question: q.question,
    options: Array.isArray(q.options) ? q.options : [],
    answer: q.answer,
    topic: q.category || '',
    level: q.level,
    type: 'mcq'
  }))

  // Cache on the posting so we don't re-query on every subsequent call —
  // this is a performance cache only; correctness for grading always goes
  // back to the QuestionBank table (see gradePipelineExam).
  await prisma.jobPosting.update({ where: { id: jobPosting.id }, data: { questionBank: bank } })
  return bank
}

async function moveToExamPhase1Sent(applicationId) {
  const application = await loadApplicationFull(applicationId)
  if (!application) return

  // Idempotent: if an exam attempt already exists, just ensure stage is correct
  if (application.examAttemptId) {
    if (application.stage !== 'exam_sent') {
      await prisma.application.update({
        where: { id: applicationId },
        data: { stage: 'exam_sent' }
      })
      await recordStageEvent(applicationId, 'exam_sent')
    }
    return
  }

  const jp = await prisma.jobPosting.findUnique({
    where: { id: application.jobPosting.id },
    include: { requiredSkills: { include: { skill: true } } }
  })

  const bank = await ensureQuestionBank(jp)
  if (bank.length < SHARED_BANK_QUESTIONS_PER_EXAM) {
    throw new Error(
      `Not enough active QuestionBank entries for domain "${jp.examDomain || jp.title}"` +
      (jp.examCategory ? ` / category "${jp.examCategory}"` : '') +
      ` (phase 1) — need at least ${SHARED_BANK_QUESTIONS_PER_EXAM}, found ${bank.length}.`
    )
  }

  const sharedSubset = fishYatesShuffle(bank)
    .slice(0, Math.min(SHARED_BANK_QUESTIONS_PER_EXAM, bank.length))
    .map(q => ({ ...q, options: fishYatesShuffle(q.options) }))

  const timeLimitSec = (jp.examDurationMin || 30) * 60
  const examWindowExpiresAt = new Date(Date.now() + (jp.examWindowHours || 48) * 60 * 60 * 1000)

  const examAttempt = await prisma.examAttempt.create({
    data: {
      userId: application.userId,
      domain: jp.examDomain || jp.title,
      phase: 1,
      status: 'pending',
      questions: sharedSubset,
      answers: {},
      timeLimitSec,
      proctorFlags: [],
      startedAt: new Date(),
      source: 'pipeline',
      applicationId
    }
  })

  await prisma.application.update({
    where: { id: applicationId },
    data: {
      stage: 'exam_sent',
      examAttemptId: examAttempt.id,
      examWindowExpiresAt
    }
  })
  await recordStageEvent(applicationId, 'exam_sent')
  await enqueueStatusEmail(applicationId, 'exam_unlocked')

  await notifyStudent(application.userId, {
    type: 'pipeline_stage',
    title: '📝 Assessment unlocked!',
    message: `Phase 1 exam for "${jp.title}" is ready. You have ${jp.examWindowHours || 48} hours to complete it.`,
    data: { applicationId, stage: 'exam_sent', examAttemptId: examAttempt.id }
  })
}

// ─── Stage — Exam Phase 1 Completed → Phase 2 or Ranking ─────────────────────

async function gradePipelineExam(attempt) {
  const questions = attempt.questions || []
  const answers = attempt.answers || {}

  const mcqQuestions = questions.filter(q => q.type === 'mcq')
  const explanationQuestions = questions.filter(q => q.type !== 'mcq')

  let mcqScore = 0
  if (mcqQuestions.length > 0) {
    const bankIds = mcqQuestions.map(q => q.id).filter(Boolean)
    const bankRows = await prisma.questionBank.findMany({
      where: { id: { in: bankIds } },
      select: { id: true, answer: true }
    })
    const correctAnswerById = new Map(bankRows.map(r => [r.id, r.answer]))

    let correct = 0
    mcqQuestions.forEach(q => {
      const given = answers[q.id] ?? answers[questions.indexOf(q)] ?? answers[String(questions.indexOf(q))]
      // Fall back to the embedded answer only for legacy attempts created
      // before the switch to the seeded bank (their ids won't resolve here).
      const correctAnswer = correctAnswerById.has(q.id) ? correctAnswerById.get(q.id) : q.answer
      if (given === correctAnswer) correct++
    })
    mcqScore = Math.round((correct / mcqQuestions.length) * 100)
  }

  let explanationScore = 0
  let explanationReport = null
  if (explanationQuestions.length > 0) {
    const qas = explanationQuestions.map(q => {
      const gi = questions.indexOf(q)
      return {
        question: q.question,
        context: q.context || '',
        answer: answers[q.id] ?? answers[gi] ?? answers[String(gi)] ?? ''
      }
    }).filter(qa => qa.answer?.trim())

    if (qas.length > 0) {
      try {
        explanationReport = await evaluatePhase2Answers({
          questionsAndAnswers: qas,
          projectSummary: `Pipeline exam — "${attempt.domain}"`
        })
        explanationScore = explanationReport.totalScore || 0
      } catch (err) {
        console.error(`[Pipeline] Explanation grading failed:`, err.message)
      }
    }
  }

  let totalScore
  if (mcqQuestions.length > 0 && explanationQuestions.length > 0) {
    totalScore = Math.round(mcqScore * 0.7 + explanationScore * 0.3)
  } else if (mcqQuestions.length > 0) {
    totalScore = mcqScore
  } else {
    totalScore = explanationScore
  }

  const level = calculateLevel(totalScore)

  await prisma.examAttempt.update({
    where: { id: attempt.id },
    data: {
      status: 'completed', totalScore, level,
      evaluationReport: { mcqScore, explanationScore, explanationReport }
    }
  })

  return { totalScore, level }
}

async function onExamGraded(examAttempt, gradeResult) {
  if (!examAttempt.applicationId) return

  const application = await prisma.application.findUnique({
    where: { id: examAttempt.applicationId },
    include: { jobPosting: true, user: { select: { id: true, name: true } } }
  })
  if (!application) return

  // Determine: is this phase 1 or phase 2?
  const isPhase2 = application.phase2ExamAttemptId === examAttempt.id

  if (!isPhase2) {
    // Phase 1 completed
    await prisma.application.update({
      where: { id: application.id },
      data: { stage: 'exam_completed', examScore: gradeResult.totalScore }
    })
    await recordStageEvent(application.id, 'exam_completed')

    await notifyStudent(application.user.id, {
      type: 'pipeline_stage',
      title: `📊 Phase 1 result: ${gradeResult.totalScore}/100`,
      message: `You scored ${gradeResult.totalScore}/100 (${gradeResult.level}) in Phase 1 of "${application.jobPosting.title}".`,
      data: { applicationId: application.id, stage: 'exam_completed', score: gradeResult.totalScore }
    })

    // If Phase 2 enabled and student has a project → start Phase 2
    if (application.jobPosting.examPhase2 && application.projectId) {
      await moveToExamPhase2Sent(application.id)
      return
    }

    // Otherwise go to ranking
    if (application.jobPosting.manualMode) {
      await notifyRecruiter(application.jobPosting.recruiterId, {
        type: 'manual_action_needed',
        title: `🧪 Phase 1 done: ${application.user.name}`,
        message: `${application.user.name} scored ${gradeResult.totalScore}/100 on Phase 1 for "${application.jobPosting.title}". Take the next action.`,
        data: { applicationId: application.id, stage: 'exam_completed', jobPostingId: application.jobPosting.id }
      })
      return
    }

    await markReadyForRanking(application.id)
  } else {
    // Phase 2 completed — update with combined score and go to ranking
    const phase1Score = application.examScore || 0
    const combinedExamScore = Math.round(phase1Score * 0.4 + gradeResult.totalScore * 0.6)

    await prisma.application.update({
      where: { id: application.id },
      data: { stage: 'exam_phase2_completed', examScore: combinedExamScore }
    })
    await recordStageEvent(application.id, 'exam_phase2_completed')

    await notifyStudent(application.user.id, {
      type: 'pipeline_stage',
      title: `📊 Phase 2 result: ${gradeResult.totalScore}/100`,
      message: `Phase 2 complete! Combined exam score: ${combinedExamScore}/100. Final ranking coming soon.`,
      data: { applicationId: application.id, stage: 'exam_phase2_completed', score: combinedExamScore }
    })

    if (application.jobPosting.manualMode) {
      await notifyRecruiter(application.jobPosting.recruiterId, {
        type: 'manual_action_needed',
        title: `🧪 All exams done: ${application.user.name}`,
        message: `${application.user.name} completed both exam phases. Combined score: ${combinedExamScore}/100. Ready to rank.`,
        data: { applicationId: application.id, stage: 'exam_phase2_completed', jobPostingId: application.jobPosting.id }
      })
      return
    }

    await markReadyForRanking(application.id)
  }
}

// ─── Stage — Exam Phase 2 (Project-based, AI-generated) ──────────────────────

/**
 * Phase 2 exam only runs if:
 *   1. jp.examPhase2 = true
 *   2. Student has submitted a project (application.projectId exists)
 *
 * Questions are AI-generated from the project code + include:
 *   - Code comprehension (text answer)
 *   - Architecture explanation (text answer)
 *   - Domain-specific coding challenge (text answer describing approach)
 */
async function moveToExamPhase2Sent(applicationId) {
  const application = await loadApplicationFull(applicationId)
  if (!application) return

  const jp = application.jobPosting

  // Safety: only if project exists
  if (!application.projectId) {
    console.log(`[Pipeline] Phase 2 skipped for ${applicationId} — no project submitted`)
    await markReadyForRanking(applicationId)
    return
  }

  const project = await prisma.project.findUnique({ where: { id: application.projectId } })
  if (!project?.evaluationReport) {
    // Project not yet evaluated — skip Phase 2
    await markReadyForRanking(applicationId)
    return
  }

  let phase2Questions = []

  try {
    const context = {
      title: project.title,
      domain: project.domain,
      description: project.description,
      fileTree: project.evaluationReport.fileTree || [],
      fileContents: JSON.stringify(project.evaluationReport.categories || {}).slice(0, 1500)
    }

    const raw = await generatePhase2Questions(context)
    if (Array.isArray(raw) && raw.length > 0) {
      phase2Questions = raw.slice(0, PERSONALIZED_QUESTIONS_COUNT).map((q, i) => ({
        id: `p2_${i}`,
        question: q.question,
        context: q.context || '',
        type: q.type === 'code' ? 'code' : 'explanation',  // code | explanation
        domain: jp.examDomain || project.domain
      }))
    }
  } catch (err) {
    console.error(`[Pipeline] Phase 2 question generation failed:`, err.message)
    await markReadyForRanking(applicationId)
    return
  }

  if (phase2Questions.length === 0) {
    await markReadyForRanking(applicationId)
    return
  }

  const timeLimitSec = Math.min(jp.examDurationMin * 60 * 2, 7200) // max 2h
  const examWindowExpiresAt = new Date(Date.now() + jp.examWindowHours * 60 * 60 * 1000)

  const phase2Attempt = await prisma.examAttempt.create({
    data: {
      userId: application.userId,
      domain: `${jp.examDomain || jp.title} — Phase 2`,
      phase: 2,
      status: 'pending',
      questions: phase2Questions,
      answers: {},
      timeLimitSec,
      proctorFlags: [],
      startedAt: new Date(),
      source: 'pipeline',
      applicationId: null  // not directly linked to avoid unique constraint
    }
  })

  // Link phase2 attempt via separate field
  await prisma.application.update({
    where: { id: applicationId },
    data: {
      stage: 'exam_phase2_sent',
      phase2ExamAttemptId: phase2Attempt.id,
      examWindowExpiresAt
    }
  })
  await recordStageEvent(applicationId, 'exam_phase2_sent')

  await notifyStudent(application.userId, {
    type: 'pipeline_stage',
    title: '🔬 Phase 2 exam ready!',
    message: `AI has generated personalized questions from your project for "${jp.title}". Complete Phase 2 to finalize your application.`,
    data: { applicationId, stage: 'exam_phase2_sent', examAttemptId: phase2Attempt.id }
  })

  await enqueueStatusEmail(applicationId, 'exam_phase2_unlocked')
}

// ─── Manual Pipeline Controls ─────────────────────────────────────────────────

/**
 * Recruiter manually triggers the next stage for an application.
 * Only valid in manualMode = true.
 */
async function manualAdvanceStage(applicationId, recruiterId, { targetStage, note } = {}) {
  const application = await loadApplicationFull(applicationId)
  if (!application) throw new Error('Application not found')
  if (application.jobPosting.recruiterId !== recruiterId) throw new Error('Not authorized')
  if (!application.jobPosting.manualMode) throw new Error('This posting is not in manual mode')

  const jp = application.jobPosting
  const currentStage = application.stage

  const STAGE_FLOW = {
    screened: async () => {
      if (jp.assignmentEnabled && jp.assignmentBrief) {
        await moveToAssignmentSent(applicationId)
      } else if (jp.examEnabled) {
        await moveToExamPhase1Sent(applicationId)
      } else {
        await markReadyForRanking(applicationId)
      }
    },
    project_evaluated: async () => {
      if (jp.examEnabled) {
        await moveToExamPhase1Sent(applicationId)
      } else {
        await markReadyForRanking(applicationId)
      }
    },
    exam_completed: async () => {
      if (jp.examPhase2 && application.projectId) {
        await moveToExamPhase2Sent(applicationId)
      } else {
        await markReadyForRanking(applicationId)
      }
    },
    exam_phase2_completed: async () => {
      await markReadyForRanking(applicationId)
    },
    ranked: async () => {
      // Recruiter can override and select/reject individual candidates
      if (targetStage === 'selected') {
        await prisma.application.update({
          where: { id: applicationId },
          data: { status: 'selected', selectionNarrative: note || 'Manually selected by recruiter.' }
        })
        await recordStageEvent(applicationId, 'selected')
        await enqueueStatusEmail(applicationId, 'selected')
        await notifyStudent(application.userId, {
          type: 'application_selected',
          title: '🎉 Congratulations! You\'ve been selected!',
          message: `You have been selected for "${jp.title}".`,
          data: { applicationId }
        })
      }
    }
  }

  const handler = STAGE_FLOW[currentStage]
  if (!handler) throw new Error(`No manual advance defined from stage "${currentStage}"`)

  await handler()

  // Notify student that recruiter took action
  await notifyStudent(application.userId, {
    type: 'pipeline_stage',
    title: '📋 Your application moved forward',
    message: `Recruiter has reviewed your application for "${jp.title}" and moved it to the next stage.`,
    data: { applicationId, fromStage: currentStage }
  })
}

/**
 * Recruiter manually rejects a candidate at any stage.
 */
async function manualRejectCandidate(applicationId, recruiterId, { reason } = {}) {
  const application = await loadApplicationFull(applicationId)
  if (!application) throw new Error('Application not found')
  if (application.jobPosting.recruiterId !== recruiterId) throw new Error('Not authorized')
  if (['selected', 'rejected'].includes(application.status)) throw new Error('Already finalized')

  const rejectionReason = reason || 'Does not meet requirements for this role.'

  await prisma.application.update({
    where: { id: applicationId },
    data: { status: 'rejected', rejectionReason }
  })
  await recordStageEvent(applicationId, 'rejected')
  await enqueueStatusEmail(applicationId, 'final_rejected')

  await notifyStudent(application.userId, {
    type: 'application_rejected',
    title: 'Application update',
    message: `Your application for "${application.jobPosting.title}" was not selected at this time. ${rejectionReason}`,
    data: { applicationId, reason: rejectionReason }
  })
}

// ─── Ranking ──────────────────────────────────────────────────────────────────

async function markReadyForRanking(applicationId) {
  const application = await prisma.application.update({
    where: { id: applicationId },
    data: { stage: 'ranked' }
  })
  await recordStageEvent(applicationId, 'ranked')

  const jp = await prisma.jobPosting.findUnique({ where: { id: application.jobPostingId } })

  // In manual mode, notify recruiter to trigger ranking manually
  if (jp?.manualMode) {
    await notifyRecruiter(jp.recruiterId, {
      type: 'manual_action_needed',
      title: '📊 Ready to rank',
      message: `An application for "${jp.title}" is ready for ranking. Trigger ranking when all candidates are ready.`,
      data: { applicationId, jobPostingId: jp.id }
    })
    return
  }

  // Auto mode: check if all in-progress apps are ready
  const pending = await prisma.application.count({
    where: {
      jobPostingId: application.jobPostingId,
      status: 'in_progress',
      stage: { not: 'ranked' }
    }
  })

  if (pending === 0) {
    await queues.applicationQueue.add({ jobPostingId: application.jobPostingId, action: 'rank_posting' }, defaultOpts)
  }
}

function buildRejectionReason(app, cutoffScore, weights) {
  const parts = []
  if (app.projectScore != null && app.projectScore < 60) parts.push(`project score (${Math.round(app.projectScore)}) was below average`)
  if (app.examScore != null && app.examScore < 60) parts.push(`assessment score (${Math.round(app.examScore)}) was below average`)
  if ((app.missingSkills || []).length > 0) parts.push(`missing skills: ${app.missingSkills.join(', ')}`)
  const detail = parts.length > 0 ? parts.join('; ') : 'overall score was below the cutoff'
  return `Final score (${Math.round(app.finalScore)}) was below cutoff (${Math.round(cutoffScore)}). ${detail}.`
}

/**
 * triggerRanking — computes score + rank for every candidate and stores a
 * *recommended* selection cutoff on the posting. It does NOT change any
 * application's status and does NOT send any selection/rejection emails.
 *
 * The recruiter reviews the ranked list in the UI, picks who to select
 * (pre-checked with the recommended cutoff), and clicks "Send Decisions" —
 * which calls finalizeSelection() below. That is the only place selection
 * and rejection emails go out.
 */
async function triggerRanking(jobPostingId) {
  const jobPosting = await prisma.jobPosting.findUnique({ where: { id: jobPostingId } })
  if (!jobPosting) return

  const applications = await prisma.application.findMany({
    where: { jobPostingId, stage: 'ranked', status: 'in_progress' },
    include: { user: { select: { id: true, name: true, email: true } } }
  })
  if (applications.length === 0) return

  const weights = effectiveWeights(jobPosting)
  const scored = applications.map(app => {
    const finalScore =
      ((app.ruleScore || 0) * weights.ruleScore +
       (app.aiMatchScore || 0) * weights.aiMatchScore +
       (app.projectScore || 0) * weights.projectScore +
       (app.examScore || 0) * weights.examScore) / 100
    return { ...app, finalScore: Math.round(finalScore * 100) / 100 }
  })

  scored.sort((a, b) => b.finalScore - a.finalScore)
  scored.forEach((app, idx) => { app.rank = idx + 1 })

  // Persist score + rank only — status stays 'in_progress' until the
  // recruiter finalizes the decision.
  for (const app of scored) {
    await prisma.application.update({
      where: { id: app.id },
      data: { finalScore: app.finalScore, rank: app.rank }
    })
  }

  // Work out a *recommended* selection cutoff, purely for pre-checking
  // candidates in the recruiter UI — nothing is decided or emailed here.
  let recommended
  if (jobPosting.cutoffMode === 'percentage' && jobPosting.cutoffPercentage) {
    const cutoffCount = Math.max(1, Math.ceil(scored.length * (jobPosting.cutoffPercentage / 100)))
    recommended = scored.slice(0, cutoffCount)
  } else {
    const openings = Math.max(1, jobPosting.openings)
    recommended = scored.slice(0, openings)
  }
  const cutoffScore = recommended.length > 0 ? recommended[recommended.length - 1].finalScore : 0

  await prisma.jobPosting.update({
    where: { id: jobPostingId },
    data: {
      rankingSummary: {
        rankedAt: new Date().toISOString(),
        totalRanked: scored.length,
        recommendedSelectedIds: recommended.map(a => a.id),
        cutoffScore,
        finalized: false
      }
    }
  })

  await notifyRecruiter(jobPosting.recruiterId, {
    type: 'ranking_complete',
    title: '🏆 Rankings ready',
    message: `Rankings for "${jobPosting.title}" are ready to review — ${scored.length} candidates ranked. Select who to hire and send decisions.`,
    data: { jobPostingId }
  })
}

/**
 * finalizeSelection — the ONLY place that sends selection/rejection emails.
 *
 * Recruiter reviews the ranked list, checks off who to select, and calls
 * this once. Everyone checked gets a "selected" email; every other ranked
 * (still in_progress) applicant for this posting gets a "rejected" email.
 * The posting is then closed so it stops accepting new applications.
 */
async function finalizeSelection(jobPostingId, recruiterId, selectedApplicationIds = []) {
  const jobPosting = await prisma.jobPosting.findFirst({ where: { id: jobPostingId, recruiterId } })
  if (!jobPosting) throw new Error('Job posting not found')

  const applications = await prisma.application.findMany({
    where: { jobPostingId, stage: 'ranked', status: 'in_progress' },
    include: { user: { select: { id: true, name: true, email: true } } }
  })
  if (applications.length === 0) throw new Error('No ranked candidates to decide on. Generate rankings first.')

  const selectedIdSet = new Set(selectedApplicationIds)
  const selected = applications.filter(a => selectedIdSet.has(a.id))
  const rejected = applications.filter(a => !selectedIdSet.has(a.id))

  if (selected.length === 0) throw new Error('Select at least one candidate before sending decisions.')

  const weights = effectiveWeights(jobPosting)
  const cutoffScore = selected.length > 0
    ? Math.min(...selected.map(s => s.finalScore || 0))
    : 0

  // AI selection narratives for the chosen candidates only
  let narrativeByUser = {}
  try {
    const narratives = await callAIForJSON({
      systemPrompt: PROMPTS.SELECTION_NARRATIVE_SYSTEM,
      userPrompt: PROMPTS.SELECTION_NARRATIVE_USER({
        jobTitle: jobPosting.title,
        candidates: selected.map(s => ({
          userId: s.userId, ruleScore: s.ruleScore, aiMatchScore: s.aiMatchScore,
          projectScore: s.projectScore, examScore: s.examScore,
          finalScore: s.finalScore, rank: s.rank
        }))
      }),
      maxTokens: 1200, temperature: 0.4
    })
    if (Array.isArray(narratives)) {
      narrativeByUser = Object.fromEntries(narratives.map(n => [n.userId, n.narrative]))
    }
  } catch (err) {
    console.error(`[Pipeline] Selection narrative failed:`, err.message)
  }

  for (const app of selected) {
    await prisma.application.update({
      where: { id: app.id },
      data: {
        status: 'selected',
        selectionNarrative: narrativeByUser[app.userId] || null
      }
    })
    await recordStageEvent(app.id, 'selected')
    await enqueueStatusEmail(app.id, 'selected')

    await notifyStudent(app.userId, {
      type: 'application_selected',
      title: '🎉 You\'ve been selected!',
      message: `Congratulations! You have been selected for "${jobPosting.title}". Rank #${app.rank}.`,
      data: { applicationId: app.id, rank: app.rank, finalScore: app.finalScore, jobPostingId }
    })
  }

  for (const app of rejected) {
    const rejectionReason = buildRejectionReason(app, cutoffScore, weights)
    await prisma.application.update({
      where: { id: app.id },
      data: { status: 'rejected', rejectionReason }
    })
    await recordStageEvent(app.id, 'rejected')
    await enqueueStatusEmail(app.id, 'final_rejected')

    await notifyStudent(app.userId, {
      type: 'application_rejected',
      title: 'Application update',
      message: `Your application for "${jobPosting.title}" was not selected at this time.`,
      data: { applicationId: app.id, jobPostingId, reason: rejectionReason }
    })
  }

  // Make the post "not functional" — close it so it stops accepting new
  // applications now that a decision has been made.
  await prisma.jobPosting.update({
    where: { id: jobPostingId },
    data: {
      status: 'closed',
      rankingSummary: {
        ...(jobPosting.rankingSummary || {}),
        finalizedAt: new Date().toISOString(),
        selectedCount: selected.length,
        rejectedCount: rejected.length,
        cutoffScore,
        finalized: true
      }
    }
  })

  await notifyRecruiter(jobPosting.recruiterId, {
    type: 'decisions_sent',
    title: '✅ Decisions sent',
    message: `Decisions for "${jobPosting.title}" sent — ${selected.length} selected, ${rejected.length} rejected. Posting closed.`,
    data: { jobPostingId }
  })

  await queues.emailQueue.add({ type: 'recruiter_digest', jobPostingId }, defaultOpts)

  return { selectedCount: selected.length, rejectedCount: rejected.length }
}

// ─── Hiring Credits ───────────────────────────────────────────────────────────

/**
 * Check if recruiter has a hiring credit available.
 * Each recruiter gets 1 free hiring cycle. Purchased plans grant more.
 */
async function checkHiringCredit(recruiterId) {
  const credits = await prisma.userCredits.findUnique({ where: { userId: recruiterId } })
  if (!credits) {
    // Create record — 1 free hiring cycle by default
    const created = await prisma.userCredits.create({
      data: {
        userId: recruiterId,
        hiringCredits: 1,
        hiringCreditsUsed: 0,
        cycleResetAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
      }
    })
    return { canHire: true, creditsRemaining: 1, record: created }
  }

  const remaining = (credits.hiringCredits || 1) - (credits.hiringCreditsUsed || 0)
  return { canHire: remaining > 0, creditsRemaining: remaining, record: credits }
}

async function consumeHiringCredit(recruiterId) {
  await prisma.userCredits.upsert({
    where: { userId: recruiterId },
    update: { hiringCreditsUsed: { increment: 1 } },
    create: {
      userId: recruiterId,
      hiringCredits: 1,
      hiringCreditsUsed: 1,
      cycleResetAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
    }
  })

  await prisma.creditTransaction.create({
    data: {
      userId: recruiterId,
      kind: 'hiring_cycle',
      bucket: 'hiring',
      amount: -1,
      source: 'free',
      meta: { reason: 'posting_activation' }
    }
  })
}

module.exports = {
  createApplication,
  runStage1Screening,
  runStage2AIMatch,
  advanceAfterScreening,
  moveToAssignmentSent,
  submitAssignment,
  onProjectEvaluated,
  moveToExamPhase1Sent,
  moveToExamPhase2Sent,
  ensureQuestionBank,
  gradePipelineExam,
  onExamGraded,
  manualAdvanceStage,
  manualRejectCandidate,
  markReadyForRanking,
  triggerRanking,
  finalizeSelection,
  effectiveWeights,
  checkHiringCredit,
  consumeHiringCredit,
  sendRecruiterStageReminder,
  processDeadlineApplications,
  notifyStudent,
  notifyRecruiter
}
