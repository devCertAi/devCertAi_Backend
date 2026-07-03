const prisma = require('../config/database')
const { fishYatesShuffle, calculateLevel } = require('../utils/scoreUtils')

/**
 * examService
 *
 * BUGS FIXED:
 * 1. gradePhase1: answers were stored as { [questionId]: answer } by the
 *    fixed controller, but this was already the correct design. Verified the
 *    lookup: dbQuestions fetched by id, answerMap keyed by id, comparison
 *    uses answers[q.id]. This is now consistent end-to-end.
 *
 * 2. getPhase1Questions: if the question bank has fewer than `count` questions,
 *    the error message was generic. Now includes how many exist vs needed.
 *    Also: questions with no `id` field in the DB would cause silent grading
 *    failures — added defensive check.
 *
 * 3. hasPassedPhase1: used case-insensitive domain match (mode: 'insensitive')
 *    correctly. No change needed. Kept as-is.
 */

async function getPhase1Questions(domain, count = 25) {
  const questions = await prisma.questionBank.findMany({
    where: {
      domain: { equals: domain, mode: 'insensitive' },
      phase: 1,
      isActive: true
    },
    // Include answer so it can be stored server-side for grading
    select: { id: true, question: true, options: true, answer: true, level: true, type: true }
  })

  if (questions.length < count) {
    throw new Error(
      `Not enough questions in bank for ${domain} Phase 1: need ${count}, have ${questions.length}`
    )
  }

  return fishYatesShuffle(questions).slice(0, count).map(q => ({
    ...q,
    options: fishYatesShuffle(q.options || [])
  }))
}

async function gradePhase1(attemptId) {
  const attempt = await prisma.examAttempt.findUnique({ where: { id: attemptId } })
  if (!attempt) throw new Error('Attempt not found')

  const questions = attempt.questions || []
  const answers = attempt.answers || {}

  if (questions.length === 0) {
    throw new Error(`Attempt ${attemptId} has no questions`)
  }

  // Fetch correct answers from QuestionBank (source of truth)
  const questionIds = questions.map(q => q.id).filter(Boolean)
  const dbQuestions = await prisma.questionBank.findMany({
    where: { id: { in: questionIds } },
    select: { id: true, answer: true }
  })

  const answerMap = {}
  dbQuestions.forEach(q => { answerMap[q.id] = q.answer })

  let correct = 0
  let graded = 0
  for (const q of questions) {
    if (!q.id) continue // Skip questions without IDs (shouldn't happen)
    graded++
    if (answers[q.id] === answerMap[q.id]) correct++
  }

  if (graded === 0) throw new Error('No gradeable questions found')

  const score = Math.round((correct / graded) * 100)
  const level = calculateLevel(score)

  return { score, level, correct, total: graded }
}

async function hasPassedPhase1(userId, domain) {
  const passed = await prisma.examAttempt.findFirst({
    where: {
      userId,
      domain: { equals: domain, mode: 'insensitive' },
      phase: 1,
      status: 'completed',
      totalScore: { gte: 50 }
    }
  })
  return !!passed
}

module.exports = { getPhase1Questions, gradePhase1, hasPassedPhase1 }
