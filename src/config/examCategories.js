/**
 * examCategories.js
 *
 * Single source of truth for:
 *  - which technology categories exist under each domain
 *    (e.g. Frontend -> HTML & CSS / React / Angular / General Frontend)
 *  - difficulty presets (easy / medium / hard) and how they affect
 *    question-level mix + per-question time
 *  - the dynamic time-limit formula used by examController.startExam
 *
 * Place this file at src/config/examCategories.js (same folder as database.js)
 * so the existing `require('../config/examCategories')` paths used by
 * examController.js / examService.js / examValidators.js resolve correctly.
 */

// Domain -> list of selectable technology categories.
// "General <Domain>" is always included so a candidate who doesn't want to
// commit to one specific stack can still take a broad exam.
const EXAM_CATEGORIES = {
  Frontend: ['HTML & CSS', 'React', 'Angular', 'General Frontend'],
  Backend: ['Node.js', 'Next.js', 'Java Spring Boot', 'Go', 'General Backend', 'Security'],
  // "General Full Stack" added so Full Stack matches every other domain in
  // always offering a broad, stack-agnostic option alongside the specific
  // technology categories.
  'Full Stack': ['HTML & CSS', 'React', 'Angular', 'Node.js', 'Next.js', 'Java Spring Boot', 'Go', 'General Backend', 'Security', 'General Full Stack'],
  // Kotlin added alongside Flutter — Android's primary modern language,
  // distinct from the cross-platform Flutter/React Native categories.
  Mobile: ['Android', 'iOS', 'React Native', 'Flutter', 'Kotlin', 'General Mobile'],
  'Data Science': ['Python & Pandas', 'Machine Learning', 'Deep Learning', 'Statistics', 'General Data Science'],
  DevOps: ['CI/CD', 'Docker & Kubernetes', 'Cloud (AWS/Azure/GCP)', 'Monitoring & Security', 'General DevOps'],
  'Programming Languages': ['Java', 'C/C++', 'Python', 'JavaScript', 'General Programming'],
}

const DOMAINS = Object.keys(EXAM_CATEGORIES)

// All valid category values across every domain — used for zod enum validation.
const ALL_CATEGORIES = [...new Set(Object.values(EXAM_CATEGORIES).flat())]

// Difficulty presets:
//  - secPerQuestion drives the dynamic time limit
//  - levelWeights controls the mix of Beginner/Intermediate/Expert questions
//    pulled from the question bank for that attempt
const DIFFICULTY_CONFIG = {
  easy: {
    label: 'Easy',
    secPerQuestion: 45,
    levelWeights: { Beginner: 0.7, Intermediate: 0.3, Expert: 0 },
  },
  medium: {
    label: 'Medium',
    secPerQuestion: 72,
    levelWeights: { Beginner: 0.3, Intermediate: 0.5, Expert: 0.2 },
  },
  hard: {
    label: 'Hard',
    secPerQuestion: 100,
    levelWeights: { Beginner: 0, Intermediate: 0.3, Expert: 0.7 },
  },
  mixed: {
    label: 'Mixed',
    // Halfway between easy and hard so the time budget stays fair regardless
    // of how the random draw shakes out for a given attempt.
    secPerQuestion: 72,
    levelWeights: { Beginner: 0.34, Intermediate: 0.33, Expert: 0.33 },
  },
}

const DIFFICULTIES = Object.keys(DIFFICULTY_CONFIG)

const MIN_QUESTIONS = 10
const MAX_QUESTIONS = 50
const DEFAULT_QUESTIONS = 25

// Fixed buffer added on top of per-question time — covers reading
// instructions, the proctoring consent screen, etc.
const BASE_BUFFER_SEC = 120

// ── Phase 2 (project-based, written/code answers) ──────────────────────────
// Candidate picks how many AI-generated questions (3-10) and a difficulty
// that controls how deep/probing the questions are AND how much time per
// question they get to type a real answer (much longer than an MCQ pick).
const PHASE2_MIN_QUESTIONS = 3
const PHASE2_MAX_QUESTIONS = 10
const PHASE2_DEFAULT_QUESTIONS = 6

// Seconds per question, by difficulty — written/code answers take far
// longer than picking an MCQ option.
const PHASE2_DIFFICULTY_CONFIG = {
  easy: { label: 'Easy', secPerQuestion: 240, description: 'Conceptual questions about what the code does.' },
  medium: { label: 'Medium', secPerQuestion: 360, description: 'Questions about why decisions were made, plus small code changes.' },
  hard: { label: 'Hard', secPerQuestion: 480, description: 'Deep questions on edge cases, trade-offs, and code you must write.' },
  mixed: { label: 'Mixed', secPerQuestion: 360, description: 'A random blend of conceptual, reasoning, and deep trade-off questions.' },
}

const PHASE2_BASE_BUFFER_SEC = 300 // time to read the brief + upload confirmation

function computePhase2TimeLimit(difficulty, questionCount) {
  const cfg = PHASE2_DIFFICULTY_CONFIG[difficulty] || PHASE2_DIFFICULTY_CONFIG.medium
  const count = Math.max(PHASE2_MIN_QUESTIONS, Math.min(PHASE2_MAX_QUESTIONS, Number(questionCount) || PHASE2_DEFAULT_QUESTIONS))
  return PHASE2_BASE_BUFFER_SEC + cfg.secPerQuestion * count
}

// Single dominant QuestionBank `level` used to anchor the initial question
// query in examService.getPhase1Questions before it falls back to a wider
// mix. This is intentionally a single value (not the levelWeights spread
// above) — it's just the "center of mass" of each difficulty preset so the
// first DB query is already close to right.
// 'mixed' is intentionally absent here — it has no single anchor level.
// examService.getPhase1Questions branches on difficulty === 'mixed' and uses
// the levelWeights above to draw from all three levels instead.
const LEVEL_FOR_DIFFICULTY = {
  easy: 'Beginner',
  medium: 'Intermediate',
  hard: 'Expert',
}

/**
 * Dynamic exam duration.
 * More questions -> more time. Harder difficulty -> more time per question.
 */
function computeTimeLimit(difficulty, questionCount) {
  const cfg = DIFFICULTY_CONFIG[difficulty] || DIFFICULTY_CONFIG.medium
  const count = Math.max(MIN_QUESTIONS, Math.min(MAX_QUESTIONS, Number(questionCount) || DEFAULT_QUESTIONS))
  return BASE_BUFFER_SEC + cfg.secPerQuestion * count
}

function isValidCategoryForDomain(domain, category) {
  if (!category) return false
  return (EXAM_CATEGORIES[domain] || []).includes(category)
}

// ── Domain / category normalization ────────────────────────────────────────
// ROOT CAUSE FIX for "Phase 1 shows no questions available for Frontend /
// Mobile / Programming Languages even though questions exist":
//
// adminController.addQuestion / bulkImportQuestions previously wrote
// `domain`/`category` straight from req.body with NO validation against the
// canonical EXAM_CATEGORIES list. Any admin typo or casing slip when adding
// questions (e.g. "frontend", "Frontend ", "Mobile Dev", "programming
// languages") got stored verbatim in QuestionBank + QuestionBankStats.
//
// examService.getPhase1Questions queries QuestionBank with
// `mode: 'insensitive'`, so starting an exam still worked once a category was
// already selected. But questionStatsService.getCategoryCountsForDomains
// (which drives the category picker candidates see BEFORE starting) queried
// QuestionBankStats with an EXACT, case-sensitive `domain: { in: DOMAINS }`
// match against the canonical capitalized names — so any bucket stored under
// a slightly different casing/spelling never showed up, the category list
// came back empty, and the UI rendered "No sections have questions available
// for {domain} yet" even though the questions were sitting right there in
// the DB under a mismatched key.
//
// normalizeDomain / normalizeCategory below are the single source of truth
// used at WRITE time (adminController) so this class of bug can't recur, and
// getCategoryCountsForDomains + recomputeAll (questionStatsService) also use
// them defensively to fold any already-mis-cased legacy rows back onto the
// correct canonical bucket.

/**
 * Case/whitespace-insensitive lookup of a domain against the canonical list.
 * Returns the canonical spelling, or null if it doesn't match any known domain.
 */
function normalizeDomain(domain) {
  if (!domain || typeof domain !== 'string') return null
  const trimmed = domain.trim()
  const exact = DOMAINS.find((d) => d === trimmed)
  if (exact) return exact
  const lower = trimmed.toLowerCase()
  const match = DOMAINS.find((d) => d.toLowerCase() === lower)
  return match || null
}

/**
 * Case/whitespace-insensitive lookup of a category within an already-
 * normalized domain. Returns the canonical spelling, or null if it doesn't
 * belong to that domain.
 */
function normalizeCategory(domain, category) {
  if (!category || typeof category !== 'string') return null
  const trimmed = category.trim()
  const list = EXAM_CATEGORIES[domain] || []
  const exact = list.find((c) => c === trimmed)
  if (exact) return exact
  const lower = trimmed.toLowerCase()
  const match = list.find((c) => c.toLowerCase() === lower)
  return match || null
}

// Maps a difficulty preset (easy/medium/hard) to the primary QuestionBank
// `level` (Beginner/Intermediate/Expert) used to seed the question query.
// Used by examService.getPhase1Questions.
function levelForDifficulty(difficulty) {
  return LEVEL_FOR_DIFFICULTY[difficulty] || null
}

module.exports = {
  EXAM_CATEGORIES,
  DOMAINS,
  ALL_CATEGORIES,
  DIFFICULTY_CONFIG,
  DIFFICULTIES,
  MIN_QUESTIONS,
  MAX_QUESTIONS,
  DEFAULT_QUESTIONS,
  BASE_BUFFER_SEC,
  computeTimeLimit,
  isValidCategoryForDomain,
  normalizeDomain,
  normalizeCategory,
  levelForDifficulty,
  // Phase 2 (project-based) config — was defined above but never exported,
  // so the controller/validators/frontend had no way to reach it and Phase 2
  // was stuck on a hardcoded 6 questions with no difficulty control.
  PHASE2_DIFFICULTY_CONFIG,
  PHASE2_MIN_QUESTIONS,
  PHASE2_MAX_QUESTIONS,
  PHASE2_DEFAULT_QUESTIONS,
  PHASE2_BASE_BUFFER_SEC,
  computePhase2TimeLimit,
}