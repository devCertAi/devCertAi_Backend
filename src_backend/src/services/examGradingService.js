 

const prisma = require('../config/database')
const { gradePhase1 } = require('./examService')
const { evaluatePhase2Answers, generatePhase1Explanations } = require('../ai/evaluationEngine')
const { calculateLevel } = require('../utils/scoreUtils')
const queues = require('../queues')
const { defaultOpts } = queues
const notificationService = require('./notificationService')

const GRADING_TIMEOUT_MS = 60_000 // hard ceiling — a hung AI call must not leave the attempt stuck forever

async function gradeAttempt(attemptId) {
  console.log(`[Grading] Starting attempt ${attemptId}`)
  try {
    await Promise.race([
      _gradeAttemptInner(attemptId),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Grading timed out after 60s')), GRADING_TIMEOUT_MS)
      ),
    ])
  } catch (err) {
    console.error(`[Grading] CRASHED for ${attemptId}:`, err.message, err.stack)
    // Safety net: mark as completed with 0 so polling stops
    try {
      await prisma.examAttempt.update({
        where: { id: attemptId },
        data: { status: 'completed', totalScore: 0, level: 'Beginner' }
      })
      console.log(`[Grading] Safety net applied for ${attemptId}`)
    } catch (e2) {
      console.error(`[Grading] Safety net also failed:`, e2.message)
    }
  }
}

async function _gradeAttemptInner(attemptId) {
  const attempt = await prisma.examAttempt.findUnique({
    where: { id: attemptId },
    include: { user: { select: { id: true, name: true } } }
  })
  if (!attempt) throw new Error(`Attempt ${attemptId} not found`)

  if (attempt.status === 'completed') {
    console.log(`[Grading] ${attemptId} already completed, skipping`)
    return
  }

  // Pipeline exams use their own grading service
  if (attempt.source === 'pipeline') {
    const pipelineService = require('./pipelineService')
    if (attempt.status === 'terminated') {
      await prisma.examAttempt.update({
        where: { id: attemptId },
        data: { status: 'terminated', totalScore: 0, level: 'Beginner' }
      })
      await pipelineService.onExamGraded(attempt, { totalScore: 0, level: 'Beginner' })
      return
    }
    const result = await pipelineService.gradePipelineExam(attempt)
    await pipelineService.onExamGraded(attempt, result)
    return
  }

  let totalScore = 0
  let level = 'Beginner'
  let evaluationReport = null
  const wasTerminated = attempt.status === 'terminated'

  if (!wasTerminated) {
    if (attempt.phase === 1) {
      const result = await gradePhase1(attemptId)
      totalScore = result.score
      level = result.level
      console.log(`[Grading] Phase 1: ${result.correct}/${result.total} correct = ${totalScore}/100`)

      // Best-effort: explain the wrong answers via one batched AI call. If
      // this fails (AI down, timeout, etc.) the candidate still gets their
      // score and the raw right/wrong breakdown — just without the "why".
      let breakdown = result.breakdown || []
      const wrongOnes = breakdown.filter(b => !b.isCorrect)
      if (wrongOnes.length > 0) {
        try {
          const explanations = await generatePhase1Explanations(
            wrongOnes.map(({ question, options, givenAnswer, correctAnswer }) => ({ question, options, givenAnswer, correctAnswer }))
          )
          let idx = 0
          breakdown = breakdown.map(b => b.isCorrect ? b : { ...b, explanation: explanations[idx++] || null })
        } catch (err) {
          console.error(`[Grading] Phase 1 explanation generation failed:`, err.message)
        }
      }

      evaluationReport = {
        phase: 1,
        correct: result.correct,
        total: result.total,
        breakdown,
      }

    } else if (attempt.phase === 2) {
      const questions = attempt.questions || []
      const answers = attempt.answers || {}
      const answeredCount = Object.keys(answers).length

      if (answeredCount === 0) {
        totalScore = 0
        level = 'Beginner'
      } else {
        const questionsAndAnswers = questions.map((q, i) => ({
          question: q.question || q,
          context: q.context || '',
          answer: (answers[String(i)] || answers[i] || '').trim()
        }))
        const projectSummary = `Domain: ${attempt.domain}. ${answeredCount}/${questions.length} answered.`
        try {
          const evalResult = await evaluatePhase2Answers({
            questionsAndAnswers,
            projectSummary,
            difficulty: attempt.difficulty || 'medium'
          })

          // Safety net: never trust the AI to award credit for blank
          // answers, even though the prompt already tells it not to. Force
          // any question the candidate left unanswered to a 0 and recompute
          // totalScore from the (corrected) per-question scores so the
          // aggregate is always internally consistent, rather than blindly
          // using whatever totalScore the AI returned.
          let scores = Array.isArray(evalResult.scores) ? evalResult.scores.slice(0, questionsAndAnswers.length) : null
          if (scores) {
            scores = scores.map((s, i) => (questionsAndAnswers[i].answer ? s : 0))
            const maxPerQ = 10
            totalScore = Math.round((scores.reduce((a, b) => a + (Number(b) || 0), 0) / (scores.length * maxPerQ)) * 100)
          } else {
            totalScore = Math.max(0, Math.min(100, evalResult.totalScore || 0))
          }
          totalScore = Math.max(0, Math.min(100, totalScore))
          level = evalResult.level || calculateLevel(totalScore)
          console.log(`[Grading] Phase 2 AI: ${totalScore}/100`)

          const feedback = Array.isArray(evalResult.feedback) ? evalResult.feedback : []
          evaluationReport = {
            phase: 2,
            summary: evalResult.summary || null,
            breakdown: questionsAndAnswers.map((qa, i) => ({
              question: qa.question,
              context: qa.context,
              givenAnswer: qa.answer || null,
              score: scores ? Number(scores[i]) || 0 : null,
              maxScore: 10,
              feedback: feedback[i] || null,
            })),
          }
        } catch (err) {
          console.error(`[Grading] Phase 2 AI failed:`, err.message)
          totalScore = 0
          level = 'Beginner'
        }
      }
    }
  }

  const finalStatus = wasTerminated ? 'terminated' : 'completed'
  const passed = !wasTerminated && totalScore >= 50

  const updateData = {
    status: finalStatus,
    totalScore,
    level,
    ...(evaluationReport ? { evaluationReport } : {}),
    ...(attempt.phase === 1 ? { phase1Score: totalScore } : { phase2Score: totalScore })
  }

  await prisma.examAttempt.update({ where: { id: attemptId }, data: updateData })
  console.log(`[Grading] Done ${attemptId}: status=${finalStatus} score=${totalScore}`)

  // Each phase gets its own certificate independently when passed...
  if (passed && attempt.source !== 'demo') {
    await queues.certificateGenQueue.add({
      type: 'skill_cert', examAttemptId: attemptId, userId: attempt.userId
    }, defaultOpts)

    // ...and if the OTHER phase for this domain has also been passed at some
    // point, queue an additional combo certificate (Phase 1 + Phase 2) too.
    // The Certificate schema already supports this via `metadata` (which
    // records both attempt ids/scores) since `examAttemptId` can only point
    // at a single attempt.
    const otherPhase = attempt.phase === 1 ? 2 : 1
    const otherPassedAttempt = await prisma.examAttempt.findFirst({
      where: {
        userId: attempt.userId,
        domain: attempt.domain,
        phase: otherPhase,
        status: 'completed',
        source: { not: 'demo' },
        totalScore: { gte: 50 }
      },
      orderBy: { totalScore: 'desc' }
    })

    if (otherPassedAttempt) {
      const phase1AttemptId = attempt.phase === 1 ? attemptId : otherPassedAttempt.id
      const phase2AttemptId = attempt.phase === 2 ? attemptId : otherPassedAttempt.id
      await queues.certificateGenQueue.add({
        type: 'combo_cert',
        userId: attempt.userId,
        domain: attempt.domain,
        phase1AttemptId,
        phase2AttemptId
      }, defaultOpts)
    }
  }

  const title = wasTerminated ? 'Exam Terminated' : `Exam ${passed ? 'Passed ✓' : 'Failed ✗'}`
  const message = wasTerminated
    ? `${attempt.domain} Phase ${attempt.phase} terminated`
    : `${attempt.domain} Phase ${attempt.phase}: ${totalScore}/100 (${level})`

  await notificationService.create(attempt.userId, {
    type: 'exam_result', title, message,
    data: { attemptId, score: totalScore, passed, domain: attempt.domain, phase: attempt.phase, terminated: wasTerminated }
  })

  await queues.emailQueue.add({ type: 'exam_result', userId: attempt.userId, attemptId }, defaultOpts)
}

module.exports = { gradeAttempt }