/**
 * backfillQuestionStats.js
 *
 * One-off script to run right after adding the QuestionBankStats model +
 * migration to an existing database. adjustStat/recomputeBucket only update
 * stats incrementally from the moment they were wired into
 * addQuestion/updateQuestion/deleteQuestion/bulkImportQuestions — any
 * question that already existed in QuestionBank before that point was never
 * counted, so QuestionBankStats stays at 0 (or missing) for that bucket
 * forever, which is exactly why the exam config slider / question
 * availability table can show the wrong number of questions.
 *
 * This does a real GROUP BY over QuestionBank once and rewrites every
 * QuestionBankStats row to match reality. Safe to re-run any time.
 *
 * Usage:
 *   node scripts/backfillQuestionStats.js
 *
 * (Also reachable without shell access via
 *  POST /api/admin/questions/stats/recompute as an admin.)
 */

const prisma = require('../src/config/database')
const { recomputeAll } = require('../src/services/questionStatsService')

async function main() {
  console.log('Recomputing QuestionBankStats from QuestionBank...')
  const result = await recomputeAll()
  console.log(`Done. ${result.bucketsUpdated} bucket(s) updated, ${result.staleBucketsZeroed} stale bucket(s) zeroed.`)
}

main()
  .catch((err) => {
    console.error('Backfill failed:', err)
    process.exitCode = 1
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
