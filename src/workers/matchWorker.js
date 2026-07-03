const queues = require('../queues')
const { defaultOpts } = queues
const prisma = require('../config/database')
const notificationService = require('../services/notificationService')
const { findMatchingUsersForPosting, findMatchingPostingsForUser } = require('../services/skillMatchService')

queues.queuesReadyPromise.then(() => {
queues.matchQueue.process(async (job) => {
  const { type, jobPostingId, userId } = job.data

  if (type === 'posting_match') {
    return handlePostingMatch(jobPostingId)
  }
  if (type === 'user_match') {
    return handleUserMatch(userId)
  }
  console.warn(`[MatchWorker] Unknown match job type: ${type}`)
})
})

// §7 — when a posting goes active, notify the best-matching users (capped),
// zero AI calls, pure SQL.
async function handlePostingMatch(jobPostingId) {
  const jobPosting = await prisma.jobPosting.findUnique({ where: { id: jobPostingId } })
  if (!jobPosting) return

  const matches = await findMatchingUsersForPosting(jobPostingId, { cap: jobPosting.matchNotificationCap })
  console.log(`[MatchWorker] Posting ${jobPostingId}: ${matches.length} matching users (cap ${jobPosting.matchNotificationCap})`)

  for (const user of matches) {
    await notificationService.create(user.id, {
      type: 'job_match',
      title: `New job match: ${jobPosting.title}`,
      message: `${jobPosting.companyName} is hiring for "${jobPosting.title}" — your skills match ${user.matchPct}% of the requirements.`,
      data: { jobPostingId, slug: jobPosting.applyLinkSlug, matchPct: user.matchPct }
    })

    await queues.emailQueue.add({
      type: 'job_match',
      userId: user.id,
      jobPostingId,
      matchPct: user.matchPct
    }, defaultOpts)
  }
}

// §7 — incremental match check when a student updates their skills. Notifies
// the student only (not the whole posting's user base again).
async function handleUserMatch(userId) {
  const matches = await findMatchingPostingsForUser(userId, { limit: 5 })
  if (matches.length === 0) return

  await notificationService.create(userId, {
    type: 'job_match_digest',
    title: `${matches.length} new job${matches.length > 1 ? 's' : ''} match your skills`,
    message: matches.map(m => `${m.posting.title} at ${m.posting.companyName} (${m.matchPct}% match)`).join(', '),
    data: { postings: matches.map(m => ({ jobPostingId: m.posting.id, slug: m.posting.applyLinkSlug, matchPct: m.matchPct })) }
  })
}

console.log('✅ Skill-match worker started')
