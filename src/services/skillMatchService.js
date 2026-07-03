const prisma = require('../config/database')

/**
 * Stage 1 rule-based screening — pure JS, no AI, runs for EVERY application.
 * Computes a 0-100 ruleScore from skill overlap + experience comparison.
 * This alone should eliminate 50-80% of obviously unqualified candidates.
 *
 * @param {object} params
 * @param {string[]} params.candidateSkills - lowercased union of UserSkill names + ParsedResume.parsedSkills
 * @param {{ name: string, required: boolean }[]} params.requiredSkills - JobPostingSkill rows (skill.name + required flag)
 * @param {number} params.minExperience - job.minExperience (years)
 * @param {number|null} params.experienceYears - candidate's parsed experience years
 */
function computeRuleScore({ candidateSkills, requiredSkills, minExperience, experienceYears }) {
  const candidateSet = new Set(candidateSkills.map(s => s.toLowerCase().trim()))

  const mustHave = requiredSkills.filter(s => s.required)
  const niceToHave = requiredSkills.filter(s => !s.required)

  const matchedSkills = []
  const missingSkills = []

  for (const skill of mustHave) {
    if (candidateSet.has(skill.name.toLowerCase().trim())) matchedSkills.push(skill.name)
    else missingSkills.push(skill.name)
  }

  let niceToHaveMatched = 0
  for (const skill of niceToHave) {
    if (candidateSet.has(skill.name.toLowerCase().trim())) {
      matchedSkills.push(skill.name)
      niceToHaveMatched++
    }
  }

  // Skill component (0-80): % of must-have skills matched, scaled to 80,
  // plus a small bonus (up to 10) for nice-to-have matches.
  const mustHavePct = mustHave.length > 0 ? matchedSkills.filter(m => mustHave.some(s => s.name === m)).length / mustHave.length : 1
  const skillScore = Math.round(mustHavePct * 80)
  const niceToHaveBonus = niceToHave.length > 0 ? Math.round((niceToHaveMatched / niceToHave.length) * 10) : 0

  // Experience component (0-20): full marks if candidate meets/exceeds minExperience.
  let experienceScore
  if (minExperience <= 0) {
    experienceScore = 20
  } else if (experienceYears == null) {
    // Unknown experience — give partial credit so candidates aren't unfairly
    // tanked just because their resume didn't parse a number.
    experienceScore = 10
  } else if (experienceYears >= minExperience) {
    experienceScore = 20
  } else {
    experienceScore = Math.round((experienceYears / minExperience) * 20)
  }

  const ruleScore = Math.max(0, Math.min(100, skillScore + niceToHaveBonus + experienceScore))

  return { ruleScore, matchedSkills, missingSkills }
}

/**
 * Builds the candidate's skill list for rule scoring: union of their
 * profile UserSkill names + any skills extracted from their resume.
 */
async function getCandidateSkillNames(userId) {
  const [userSkills, parsedResume] = await Promise.all([
    prisma.userSkill.findMany({ where: { userId }, include: { skill: true } }),
    prisma.parsedResume.findUnique({ where: { userId } })
  ])

  const names = new Set()
  for (const us of userSkills) names.add(us.skill.name.toLowerCase().trim())
  for (const s of (parsedResume?.parsedSkills || [])) names.add(s.toLowerCase().trim())

  return { skillNames: [...names], experienceYears: parsedResume?.experienceYears ?? null }
}

/**
 * §7 — Skill-based auto-match & invite when a posting goes active.
 * Pure SQL: find users whose UserSkill[] overlap with the posting's required
 * skills at >= `overlapThresholdPct` (default 60%), who haven't already
 * applied, and who have notifyOnMatch enabled. Capped at `cap` best matches.
 */
async function findMatchingUsersForPosting(jobPostingId, { cap = 200, overlapThresholdPct = 0.6 } = {}) {
  const posting = await prisma.jobPosting.findUnique({
    where: { id: jobPostingId },
    include: { requiredSkills: { include: { skill: true }, where: { required: true } }, applications: { select: { userId: true } } }
  })
  if (!posting) return []

  const requiredSkillIds = posting.requiredSkills.map(rs => rs.skillId)
  if (requiredSkillIds.length === 0) return []

  const appliedUserIds = new Set(posting.applications.map(a => a.userId))

  // Pull all users that have AT LEAST ONE of the required skills, with the
  // count of overlapping skills, via a raw aggregation on UserSkill.
  const candidates = await prisma.userSkill.groupBy({
    by: ['userId'],
    where: { skillId: { in: requiredSkillIds } },
    _count: { skillId: true }
  })

  const threshold = Math.ceil(requiredSkillIds.length * overlapThresholdPct)

  const matched = candidates
    .filter(c => c._count.skillId >= threshold)
    .filter(c => !appliedUserIds.has(c.userId))
    .sort((a, b) => b._count.skillId - a._count.skillId)
    .slice(0, cap)

  if (matched.length === 0) return []

  const userIds = matched.map(m => m.userId)
  const users = await prisma.user.findMany({
    where: { id: { in: userIds }, notifyOnMatch: true },
    select: { id: true, email: true, name: true }
  })

  const overlapByUser = new Map(matched.map(m => [m.userId, m._count.skillId]))

  return users.map(u => ({
    ...u,
    matchPct: Math.round((overlapByUser.get(u.id) / requiredSkillIds.length) * 100)
  }))
}

/**
 * Incremental match check — run whenever a student updates their skills.
 * Checks active postings created in the last 30 days for matches and
 * returns the matching postings for THIS user only (not the whole posting's
 * user base again).
 */
async function findMatchingPostingsForUser(userId, { overlapThresholdPct = 0.6, limit = 10 } = {}) {
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)

  const { skillNames } = await getCandidateSkillNames(userId)
  if (skillNames.length === 0) return []

  const userSkillIds = (await prisma.userSkill.findMany({
    where: { userId },
    select: { skillId: true }
  })).map(us => us.skillId)

  if (userSkillIds.length === 0) return []

  const existingApplications = await prisma.application.findMany({
    where: { userId },
    select: { jobPostingId: true }
  })
  const appliedPostingIds = new Set(existingApplications.map(a => a.jobPostingId))

  const postings = await prisma.jobPosting.findMany({
    where: {
      status: 'active',
      createdAt: { gte: thirtyDaysAgo },
      id: { notIn: [...appliedPostingIds] }
    },
    include: { requiredSkills: { where: { required: true } } }
  })

  const matches = []
  for (const posting of postings) {
    const requiredIds = posting.requiredSkills.map(rs => rs.skillId)
    if (requiredIds.length === 0) continue
    const overlap = requiredIds.filter(id => userSkillIds.includes(id)).length
    const pct = overlap / requiredIds.length
    if (pct >= overlapThresholdPct) {
      matches.push({ posting, matchPct: Math.round(pct * 100) })
    }
  }

  return matches.sort((a, b) => b.matchPct - a.matchPct).slice(0, limit)
}

module.exports = {
  computeRuleScore,
  getCandidateSkillNames,
  findMatchingUsersForPosting,
  findMatchingPostingsForUser
}
