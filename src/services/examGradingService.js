

const prisma = require('../config/database')
const queues = require('../queues')
const { defaultOpts } = queues
const notificationService = require('./notificationService')
const pipelineService = require('./pipelineService')
const { gradePhase1 } = require('./examService')
const { evaluatePhase2Answers, generatePhase1Explanations } = require('../ai/evaluationEngine')
const { calculateLevel, isPassing } = require('../utils/scoreUtils')

async function gradeAttempt(attemptId) {
  const attempt = await prisma.examAttempt.findUnique({ where: { id: attemptId } })
  if (!attempt) throw new Error(`Attempt ${attemptId} not found`)

  // Idempotency: this job can run more than once for the same attempt
  // (Bull retries on a transient failure, or a tab-switch termination fires
  // /violation and the candidate's client also happens to call /submit) —
  // never re-grade, re-notify, or re-email an attempt that's already scored.
  if (attempt.totalScore !== null && attempt.totalScore !== undefined) {
    console.log(`[ExamGrading] Attempt ${attemptId} already graded (score ${attempt.totalScore}) — skipping`)
    return
  }

  console.log(`[ExamGrading] Grading attempt ${attemptId} (phase ${attempt.phase}, domain "${attempt.domain}", source ${attempt.source || 'self'})`)

  // Pipeline-linked (recruiter) attempts have their own grading + stage-
  // advancement logic — fully delegated, never touched or duplicated here.
  if (attempt.source === 'pipeline' && attempt.applicationId) {
    const gradeResult = await pipelineService.gradePipelineExam(attempt)
    try {
      await pipelineService.onExamGraded(attempt, gradeResult)
    } catch (err) {
      // The score is already saved by gradePipelineExam at this point — a
      // failure here means the pipeline stage didn't advance, but the
      // candidate's result itself is intact. Log loudly rather than fail
      // the whole grading job (which would look to the candidate like
      // grading never finished).
      console.error(`[ExamGrading] Pipeline stage advance failed for attempt ${attemptId}:`, err.message, err.stack)
    }
    return
  }

  if (attempt.phase === 1) {
    await gradePhase1Attempt(attempt)
  } else {
    await gradePhase2Attempt(attempt)
  }
}

// ── Phase 1 — MCQ, graded against the QuestionBank answer key ──────────────
async function gradePhase1Attempt(attempt) {
  const { score, level, correct, total, breakdown } = await gradePhase1(attempt.id)

  // One batched AI call for short explanations on the WRONG answers only —
  // never lets a slow/failed AI call block the score itself.
  const wrongItems = breakdown
    .filter((b) => !b.isCorrect)
    .map((b) => ({
      question: b.question,
      options: b.options,
      givenAnswer: b.givenAnswer,
      correctAnswer: b.correctAnswer,
    }))

  let explanations = []
  if (wrongItems.length > 0) {
    try {
      explanations = await generatePhase1Explanations(wrongItems)
    } catch (err) {
      console.error(`[ExamGrading] Phase 1 explanation generation failed for attempt ${attempt.id}:`, err.message)
    }
  }

  let wrongIdx = 0
  const finalBreakdown = breakdown.map((b) => {
    if (b.isCorrect) return { ...b, explanation: null }
    const explanation = explanations[wrongIdx] ?? null
    wrongIdx++
    return { ...b, explanation }
  })

  const evaluationReport = { phase: 1, correct, total, breakdown: finalBreakdown }

  await finalizeAttempt(attempt, { totalScore: score, level, evaluationReport })
}

// ── Phase 2 — project-based, AI-graded against the candidate's own code ────
async function gradePhase2Attempt(attempt) {
  const questions = attempt.questions || []
  const answers = attempt.answers || {}

  // Candidate was terminated (e.g. tab-switch limit) before ever submitting
  // their project, so no questions were generated — nothing to grade.
  if (questions.length === 0) {
    await finalizeAttempt(attempt, {
      totalScore: 0,
      level: calculateLevel(0),
      evaluationReport: { phase: 2, summary: 'No project was submitted before the attempt ended.', breakdown: [] },
    })
    return
  }

  const questionsAndAnswers = questions.map((q, i) => ({
    question: q.question,
    answer: answers[i] ?? answers[String(i)] ?? '',
  }))

  const difficulty = attempt.difficulty || attempt.level || 'medium'
  const projectSummary = `${attempt.domain} project` + (attempt.projectId ? ` (submitted via ${attempt.projectId})` : '')

  const result = await evaluatePhase2Answers({ projectSummary, questionsAndAnswers, difficulty })

  const scores = Array.isArray(result?.scores) ? result.scores : []
  const feedback = Array.isArray(result?.feedback) ? result.feedback : []

  const breakdown = questions.map((q, i) => ({
    question: q.question,
    context: q.context || null,
    givenAnswer: answers[i] ?? answers[String(i)] ?? null,
    score: Number.isFinite(scores[i]) ? scores[i] : null,
    maxScore: 10,
    feedback: feedback[i] ?? null,
  }))

  // Prefer the AI's own totalScore (it can weigh questions non-uniformly);
  // fall back to averaging the per-question scores if that's missing or malformed.
  const fallbackScore = scores.length
    ? Math.round((scores.reduce((sum, n) => sum + (Number.isFinite(n) ? n : 0), 0) / (scores.length * 10)) * 100)
    : 0
  const totalScore = Number.isFinite(result?.totalScore)
    ? Math.max(0, Math.min(100, Math.round(result.totalScore)))
    : fallbackScore

  const level = calculateLevel(totalScore)
  const evaluationReport = { phase: 2, summary: result?.summary || null, breakdown }

  await finalizeAttempt(attempt, { totalScore, level, evaluationReport })
}

// ── Shared finish line: save the score, notify, email, and (if passed)
//    queue the skill certificate + any combo certificate. ──────────────────
async function finalizeAttempt(attempt, { totalScore, level, evaluationReport }) {
  // A terminated attempt stays terminated (disqualified) even though we
  // still compute and show its score — only a clean submission can become
  // 'completed'.
  const finalStatus = attempt.status === 'terminated' ? 'terminated' : 'completed'

  await prisma.examAttempt.update({
    where: { id: attempt.id },
    data: { status: finalStatus, totalScore, level, evaluationReport },
  })

  console.log(`[ExamGrading] Attempt ${attempt.id} graded: ${totalScore}/100 (${level}, ${finalStatus})`)

  // Real-time push so the result page updates the instant grading finishes,
  // instead of waiting for its next 5s poll.
  try {
    const { getIO } = require('../socket')
    const io = getIO()
    if (io) {
      io.to(`user:${attempt.userId}`).emit('exam:graded', {
        attemptId: attempt.id, status: finalStatus, totalScore, level,
      })
    }
  } catch (_) {}

  // Demo attempts are throwaway practice — no certificate, email, or notification.
  // Pipeline exams (recruiter-invited) also skip candidate-facing results —
  // the recruiter sees scores in the pipeline dashboard, the candidate
  // only gets a generic "under review" status.
  if (attempt.source === 'demo' || attempt.source === 'pipeline') return

  const passed = finalStatus !== 'terminated' && isPassing(totalScore)

  await notificationService.create(attempt.userId, {
    type: 'exam_graded',
    title: passed
      ? `✅ ${attempt.domain} — Phase ${attempt.phase} Passed`
      : `📊 ${attempt.domain} — Phase ${attempt.phase} Result`,
    message: `You scored ${totalScore}/100 (${level}) on Phase ${attempt.phase} of the ${attempt.domain} exam.`,
    data: { attemptId: attempt.id, phase: attempt.phase, totalScore, level, passed },
  })

  // Reuses the SAME emailQueue your recruiter pipeline already uses —
  // handled by the untouched emailWorker.js -> emailService.js.
  await queues.emailQueue.add({ type: 'exam_result', userId: attempt.userId, attemptId: attempt.id }, defaultOpts)

  if (!passed) return

  // Independent skill certificate for this attempt/phase.
  await queues.certificateGenQueue.add(
    { type: 'skill_cert', examAttemptId: attempt.id, userId: attempt.userId, domain: attempt.domain },
    defaultOpts
  )

  // Combo certificate — only once BOTH phases have been independently
  // passed for this domain. Safe to enqueue from whichever phase finishes
  // second (or even both, in a race) since certificateWorker's combo_cert
  // handler already checks for an existing combo cert before creating one.
  const otherPhase = attempt.phase === 1 ? 2 : 1
  const otherPassedAttempt = await prisma.examAttempt.findFirst({
    where: {
      userId: attempt.userId,
      domain: attempt.domain,
      phase: otherPhase,
      status: 'completed',
      totalScore: { gte: 50 },
      source: { not: 'demo' },
    },
    orderBy: { totalScore: 'desc' },
  })

  if (otherPassedAttempt) {
    const phase1AttemptId = attempt.phase === 1 ? attempt.id : otherPassedAttempt.id
    const phase2AttemptId = attempt.phase === 2 ? attempt.id : otherPassedAttempt.id
    await queues.certificateGenQueue.add(
      { type: 'combo_cert', phase1AttemptId, phase2AttemptId, userId: attempt.userId, domain: attempt.domain },
      defaultOpts
    )
  }
}

module.exports = { gradeAttempt }