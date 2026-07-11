const prisma = require('../config/database')
const { fishYatesShuffle, calculateLevel } = require('../utils/scoreUtils')
const { levelForDifficulty, DIFFICULTY_CONFIG } = require('../config/examCategories')

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
 *
 * 4. getPhase1Questions now takes `category` (technology sub-category, e.g.
 *    "React", "Node.js") and `difficulty` (easy/medium/hard, mapped to the
 *    QuestionBank `level` field) so the candidate's Phase 1 selection screen
 *    actually changes which questions they get instead of always pulling
 *    from the whole domain at a random mix of levels.
 *
 * 5. Added a `mixed` difficulty: unlike easy/medium/hard (which anchor to a
 *    single QuestionBank `level`), `mixed` has no single anchor — it draws
 *    a genuine random blend of Beginner/Intermediate/Expert questions using
 *    the levelWeights already defined in DIFFICULTY_CONFIG (previously dead
 *    config that nothing read), then shuffles them together.
 */

async function getPhase1Questions(domain, count = 25, category = null, difficulty = null) {
  if (difficulty === 'mixed') {
    return getMixedPhase1Questions(domain, count, category)
  }

  const level = difficulty ? levelForDifficulty(difficulty) : null

  const baseWhere = {
    domain: { equals: domain, mode: 'insensitive' },
    phase: 1,
    isActive: true,
  }

  // Try the most specific match first: category + difficulty level.
  const exactWhere = {
    ...baseWhere,
    ...(category ? { category } : {}),
    ...(level ? { level } : {}),
  }

  const selectFields = { id: true, question: true, options: true, answer: true, level: true, type: true }

  let questions = await prisma.questionBank.findMany({ where: exactWhere, select: selectFields })

  // Fallback 1: not enough at the exact category+level — relax the level
  // (keep the category, since that's the more important choice to honor)
  // and top up with questions from other difficulty levels in that category.
  if (questions.length < count && category) {
    const byCategory = await prisma.questionBank.findMany({
      where: { ...baseWhere, category },
      select: selectFields,
    })
    questions = mergeUnique(questions, byCategory)
  }

  // Fallback 2: still short — drop the category filter too and pull from
  // the whole domain (still respecting level if one was requested).
  if (questions.length < count) {
    const byDomain = await prisma.questionBank.findMany({
      where: { ...baseWhere, ...(level ? { level } : {}) },
      select: selectFields,
    })
    questions = mergeUnique(questions, byDomain)
  }

  // Fallback 3: absolute last resort — anything active in this domain.
  if (questions.length < count) {
    const anyInDomain = await prisma.questionBank.findMany({ where: baseWhere, select: selectFields })
    questions = mergeUnique(questions, anyInDomain)
  }

  if (questions.length < count) {
    throw new Error(
      `Not enough questions in bank for ${domain}${category ? ` / ${category}` : ''} Phase 1: need ${count}, have ${questions.length}`
    )
  }

  return fishYatesShuffle(questions).slice(0, count).map(q => ({
    ...q,
    options: fishYatesShuffle(q.options || [])
  }))
}

/**
 * Draws a random, weighted blend of Beginner/Intermediate/Expert questions
 * for the `mixed` difficulty, then shuffles the result together so the
 * candidate sees the levels interleaved rather than grouped.
 *
 * Per-level targets come from DIFFICULTY_CONFIG.mixed.levelWeights (e.g.
 * ~1/3 each). If a level comes up short within the chosen category, we widen
 * to the whole domain for just that level before falling back further.
 */
async function getMixedPhase1Questions(domain, count = 25, category = null) {
  const weights = (DIFFICULTY_CONFIG.mixed && DIFFICULTY_CONFIG.mixed.levelWeights) || {
    Beginner: 0.34, Intermediate: 0.33, Expert: 0.33,
  }

  const baseWhere = {
    domain: { equals: domain, mode: 'insensitive' },
    phase: 1,
    isActive: true,
  }
  const selectFields = { id: true, question: true, options: true, answer: true, level: true, type: true }

  const levels = Object.keys(weights).filter((lvl) => weights[lvl] > 0)

  // Turn weights into whole-number targets that sum to exactly `count`
  // (round each, then dump any leftover/shortfall onto the last level).
  const targets = {}
  let allocated = 0
  levels.forEach((lvl, idx) => {
    if (idx === levels.length - 1) {
      targets[lvl] = count - allocated
    } else {
      const c = Math.round(weights[lvl] * count)
      targets[lvl] = c
      allocated += c
    }
  })

  let selected = []
  for (const lvl of levels) {
    const need = targets[lvl]
    if (need <= 0) continue

    let pool = await prisma.questionBank.findMany({
      where: { ...baseWhere, ...(category ? { category } : {}), level: lvl },
      select: selectFields,
    })
    if (pool.length < need && category) {
      const wider = await prisma.questionBank.findMany({
        where: { ...baseWhere, level: lvl },
        select: selectFields,
      })
      pool = mergeUnique(pool, wider)
    }
    selected = mergeUnique(selected, fishYatesShuffle(pool).slice(0, need))
  }

  // Overall short (one or more levels didn't have enough) — top up from the
  // category first, then the whole domain, same cascade as the non-mixed path.
  if (selected.length < count && category) {
    const byCategory = await prisma.questionBank.findMany({
      where: { ...baseWhere, category },
      select: selectFields,
    })
    selected = mergeUnique(selected, fishYatesShuffle(byCategory))
  }
  if (selected.length < count) {
    const anyInDomain = await prisma.questionBank.findMany({ where: baseWhere, select: selectFields })
    selected = mergeUnique(selected, fishYatesShuffle(anyInDomain))
  }

  if (selected.length < count) {
    throw new Error(
      `Not enough questions in bank for ${domain}${category ? ` / ${category}` : ''} Phase 1 (mixed): need ${count}, have ${selected.length}`
    )
  }

  return fishYatesShuffle(selected).slice(0, count).map((q) => ({
    ...q,
    options: fishYatesShuffle(q.options || []),
  }))
}

/** Merges b into a, keeping the earlier occurrence for any duplicate id. */
function mergeUnique(a, b) {
  const seen = new Set(a.map(q => q.id))
  const merged = [...a]
  for (const q of b) {
    if (!seen.has(q.id)) {
      seen.add(q.id)
      merged.push(q)
    }
  }
  return merged
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
  // Per-question breakdown so the candidate can review exactly which
  // questions they got wrong, what they answered, and what the correct
  // answer was (used to build the "detailed analysis" on the result page).
  const breakdown = []
  for (const q of questions) {
    if (!q.id) continue // Skip questions without IDs (shouldn't happen)
    graded++
    const givenAnswer = answers[q.id] ?? null
    const correctAnswer = answerMap[q.id] ?? null
    const isCorrect = givenAnswer !== null && givenAnswer === correctAnswer
    if (isCorrect) correct++
    breakdown.push({
      questionId: q.id,
      question: q.question,
      options: q.options || [],
      givenAnswer,
      correctAnswer,
      isCorrect,
    })
  }

  if (graded === 0) throw new Error('No gradeable questions found')

  const score = Math.round((correct / graded) * 100)
  const level = calculateLevel(score)

  return { score, level, correct, total: graded, breakdown }
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