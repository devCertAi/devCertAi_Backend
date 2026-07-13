const prisma = require('../config/database')
const { DOMAINS, normalizeDomain, normalizeCategory } = require('../config/examCategories')

/**
 * questionStatsService
 *
 * The exam config slider ("how many questions do you want?") used to have a
 * hardcoded 10-50 range for every domain/category/difficulty, with no idea
 * whether that many questions actually existed — candidates could drag the
 * slider to 50, click Start, and only then get a 400 from
 * examService.getPhase1Questions ("need 50, have 12").
 *
 * The fix isn't to COUNT the QuestionBank table on every request that shows
 * the slider (that's a full scan per candidate, per domain card, repeated
 * constantly) — it's to keep a small pre-aggregated table
 * (QuestionBankStats: one row per domain+category+phase+level) that's cheap
 * to read, and update it only when a question is actually added/edited/
 * removed by an admin. Reads are O(rows in one domain) — a handful of rows,
 * not the whole bank. Writes only happen on admin mutations, which are rare.
 *
 * NOTE: this requires a `QuestionBankStats` model in schema.prisma:
 *
 *   model QuestionBankStats {
 *     id        String   @id @default(cuid())
 *     domain    String
 *     category  String
 *     phase     Int
 *     level     String
 *     count     Int      @default(0)
 *     updatedAt DateTime @updatedAt
 *
 *     @@unique([domain, category, phase, level])
 *     @@index([domain, phase])
 *   }
 *
 * Add that block to schema.prisma, then run:
 *   npx prisma migrate dev --name add_question_bank_stats
 * and backfill existing counts with scripts/backfillQuestionStats.js.
 */

// Beginner/Intermediate/Expert -> easy/medium/hard, same mapping as
// config/examCategories.js LEVEL_FOR_DIFFICULTY (kept in sync manually since
// this is the reverse direction and importing it back would be circular).
const LEVEL_TO_DIFFICULTY = {
  Beginner: 'easy',
  Intermediate: 'medium',
  Expert: 'hard',
}

/**
 * Adjusts one bucket's count by `delta` (+1 on question add/reactivate,
 * -1 on question remove/deactivate). Never lets a bucket go negative —
 * that would only happen if stats had already drifted, and clamping is
 * safer than surfacing a nonsense negative count on the slider.
 */
async function adjustStat(domain, category, phase, level, delta) {
  if (!domain || !category || !level || !delta) return

  const existing = await prisma.questionBankStats.findUnique({
    where: { domain_category_phase_level: { domain, category, phase, level } },
  })

  if (existing) {
    const newCount = Math.max(0, existing.count + delta)
    if (newCount === existing.count) return
    await prisma.questionBankStats.update({
      where: { id: existing.id },
      data: { count: newCount },
    })
  } else if (delta > 0) {
    await prisma.questionBankStats.create({
      data: { domain, category, phase, level, count: delta },
    })
  }
  // delta < 0 and no existing row: nothing to decrement, ignore.
}

/**
 * Recomputes one bucket from an exact COUNT — used after bulk import, where
 * skipDuplicates means we can't tell exactly how many rows actually landed
 * from result.count alone. This is a real COUNT query, but scoped to a single
 * (domain, category, phase, level) bucket — not the whole table — and only
 * runs for admin bulk-import actions, not on candidate-facing requests.
 */
async function recomputeBucket(domain, category, phase, level) {
  if (!domain || !category || !level) return
  const count = await prisma.questionBank.count({
    where: { domain, category, phase, level, isActive: true },
  })
  await prisma.questionBankStats.upsert({
    where: { domain_category_phase_level: { domain, category, phase, level } },
    update: { count },
    create: { domain, category, phase, level, count },
  })
}

/**
 * Rebuilds the ENTIRE QuestionBankStats table from the actual QuestionBank
 * data — the fix for stats being wrong/stale. adjustStat/recomputeBucket only
 * ever touch stats incrementally, from the moment they were wired into
 * addQuestion/updateQuestion/deleteQuestion/bulkImportQuestions. Any question
 * that already existed in QuestionBank BEFORE that point (e.g. seeded data,
 * or questions added before this feature existed) was never counted, so its
 * bucket sits at 0 (or missing) in QuestionBankStats forever — that's exactly
 * the "shows the wrong number of questions" symptom.
 *
 * This does one real GROUP BY over QuestionBank (not per-request — only run
 * this from an admin action or the one-off backfill script), then:
 *   1. upserts every (domain, category, phase, level) bucket that actually
 *      has active questions to its real count
 *   2. zeroes out any existing stats row that no longer has a matching
 *      active question (e.g. every question in that bucket got deleted or
 *      reassigned elsewhere) — so old counts don't linger as ghosts.
 */
/**
 * Fixes the underlying QuestionBank rows themselves, not just the stats
 * table — permanent repair for any question that was written with a
 * mis-cased/whitespace-mismatched domain or category (e.g. "frontend"
 * instead of "Frontend", "Mobile " instead of "Mobile", "Programming"
 * instead of "Programming Languages") before normalizeDomain/normalizeCategory
 * existed. Without this, recomputeAll would keep re-deriving stats from
 * already-broken source data and the "no questions available" symptom would
 * come right back after every recompute.
 *
 * Safe to re-run — a no-op once every row is already canonical. Groups by
 * distinct (domain, category) pairs first (cheap — a handful of combos, not
 * one query per question) and only issues an updateMany for pairs that
 * actually need fixing.
 */
async function repairLegacyCasing() {
  const distinctPairs = await prisma.questionBank.groupBy({ by: ['domain', 'category'] })

  let domainFixed = 0
  let categoryFixed = 0
  const unrecognized = []

  for (const { domain, category } of distinctPairs) {
    const normalizedDomain = normalizeDomain(domain)
    if (!normalizedDomain) {
      unrecognized.push({ domain, category })
      continue // don't touch rows we can't confidently map to a known domain
    }
    const normalizedCategory = normalizeCategory(normalizedDomain, category)
    if (!normalizedCategory) {
      unrecognized.push({ domain, category })
      continue
    }

    if (domain !== normalizedDomain || category !== normalizedCategory) {
      const { count } = await prisma.questionBank.updateMany({
        where: { domain, category },
        data: { domain: normalizedDomain, category: normalizedCategory },
      })
      if (domain !== normalizedDomain) domainFixed += count
      else categoryFixed += count
    }
  }

  return { domainFixed, categoryFixed, unrecognized }
}

async function recomputeAll() {
  // Heal any legacy mis-cased rows first so the group-by below (and every
  // future read) operates on clean, canonical domain/category values.
  const repair = await repairLegacyCasing()

  const grouped = await prisma.questionBank.groupBy({
    by: ['domain', 'category', 'phase', 'level'],
    where: { isActive: true },
    _count: { _all: true },
  })

  const seen = new Set()
  for (const g of grouped) {
    const { domain, category, phase, level } = g
    if (!domain || !category || !level) continue
    seen.add(`${domain}|${category}|${phase}|${level}`)
    await prisma.questionBankStats.upsert({
      where: { domain_category_phase_level: { domain, category, phase, level } },
      update: { count: g._count._all },
      create: { domain, category, phase, level, count: g._count._all },
    })
  }

  // Any bucket that currently has a stats row but wasn't in the group-by
  // result (no active questions left) needs to be reset to 0, not left at
  // its last known value.
  const existingRows = await prisma.questionBankStats.findMany({
    select: { id: true, domain: true, category: true, phase: true, level: true, count: true },
  })
  for (const row of existingRows) {
    const key = `${row.domain}|${row.category}|${row.phase}|${row.level}`
    if (!seen.has(key) && row.count !== 0) {
      await prisma.questionBankStats.update({ where: { id: row.id }, data: { count: 0 } })
    }
  }

  return {
    bucketsUpdated: seen.size,
    staleBucketsZeroed: existingRows.filter(r => !seen.has(`${r.domain}|${r.category}|${r.phase}|${r.level}`) && r.count !== 0).length,
    legacyCasingRepaired: {
      domainFixed: repair.domainFixed,
      categoryFixed: repair.categoryFixed,
      unrecognized: repair.unrecognized,
    },
  }
}

/**
 * Returns { [domain]: { [category]: { easy, medium, hard, total } } } for the
 * given domains, in a single query against the small stats table.
 *
 * BUG FIX: this previously filtered with an EXACT `domain: { in: domains }`
 * match (Prisma's `mode: 'insensitive'` isn't supported together with `in`),
 * so any stats row whose domain/category was stored with different casing or
 * stray whitespace (e.g. "frontend" instead of "Frontend", from a bulk
 * import or an old admin write before normalizeDomain existed — see
 * examCategories.js) was silently invisible here even though the underlying
 * questions were real. That's exactly what produced "No sections have
 * questions available for Frontend/Mobile/Programming Languages yet" while
 * other domains worked fine. Since this table is intentionally tiny (a
 * handful of rows per domain, per the design note above), we fetch by phase
 * only and normalize every row's domain/category in JS before bucketing, so
 * a legacy mis-cased row still lands in the correct canonical bucket instead
 * of being dropped.
 */
async function getCategoryCountsForDomains(domains, phase = 1) {
  const wanted = new Set(domains)
  const rows = await prisma.questionBankStats.findMany({ where: { phase } })

  const result = {}
  for (const row of rows) {
    const domain = normalizeDomain(row.domain)
    if (!domain || !wanted.has(domain)) continue // not one of the requested/known domains at all

    const category = normalizeCategory(domain, row.category) || row.category.trim()

    if (!result[domain]) result[domain] = {}
    if (!result[domain][category]) {
      result[domain][category] = { easy: 0, medium: 0, hard: 0, total: 0 }
    }
    const diffKey = LEVEL_TO_DIFFICULTY[row.level]
    if (diffKey) result[domain][category][diffKey] += row.count
    result[domain][category].total += row.count
  }
  return result
}

module.exports = {
  adjustStat,
  recomputeBucket,
  recomputeAll,
  repairLegacyCasing,
  getCategoryCountsForDomains,
  LEVEL_TO_DIFFICULTY,
}
