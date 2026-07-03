 

const prisma = require('../config/database')
const { gradePhase1 } = require('./examService')
const { evaluatePhase2Answers } = require('../ai/evaluationEngine')
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
  const wasTerminated = attempt.status === 'terminated'

  if (!wasTerminated) {
    if (attempt.phase === 1) {
      const result = await gradePhase1(attemptId)
      totalScore = result.score
      level = result.level
      console.log(`[Grading] Phase 1: ${result.correct}/${result.total} correct = ${totalScore}/100`)

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
          answer: answers[String(i)] || answers[i] || ''
        }))
        const projectSummary = `Domain: ${attempt.domain}. ${answeredCount}/${questions.length} answered.`
        try {
          const evalResult = await evaluatePhase2Answers({ questionsAndAnswers, projectSummary })
          totalScore = Math.max(0, Math.min(100, evalResult.totalScore || 0))
          level = evalResult.level || calculateLevel(totalScore)
          console.log(`[Grading] Phase 2 AI: ${totalScore}/100`)
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
    ...(attempt.phase === 1 ? { phase1Score: totalScore } : { phase2Score: totalScore })
  }

  await prisma.examAttempt.update({ where: { id: attemptId }, data: updateData })
  console.log(`[Grading] Done ${attemptId}: status=${finalStatus} score=${totalScore}`)

  if (passed && attempt.source !== 'demo') {
    await queues.certificateGenQueue.add({
      type: 'skill_cert', examAttemptId: attemptId, userId: attempt.userId
    }, defaultOpts)
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