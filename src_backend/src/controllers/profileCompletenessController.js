/**
 * profileCompletenessController.js
 *
 * Endpoints:
 *   GET  /users/profile-completeness   → dashboard widget data
 *   GET  /apply/:slug/preflight        → check completeness + return pre-filled data before apply
 */

const prisma = require('../config/database')
const { signRawUrl } = require('../services/storageService')
const { ApiError } = require('../utils/ApiError')
const { ApiResponse } = require('../utils/ApiResponse')
const asyncHandler = require('../utils/asyncHandler')
const { computeCompleteness } = require('../utils/profileCompleteness')

// ─── GET /users/profile-completeness ─────────────────────────────────────────
const getProfileCompleteness = asyncHandler(async (req, res) => {
  const userId = req.user.id

  const [user, detail, userSkills] = await Promise.all([
    prisma.user.findUnique({ where: { id: userId }, select: { id: true, name: true, avatar: true } }),
    prisma.profileDetail.findUnique({
      where: { userId },
      include: {
        education:      { orderBy: { startYear: 'desc' } },
        experience:     { orderBy: { startDate: 'desc' } },
        certifications: { orderBy: { issueDate: 'desc' } },
      },
    }),
    prisma.userSkill.findMany({ where: { userId }, include: { skill: true } }),
  ])

  const skills = userSkills.map(us => us.skill)
  const report = computeCompleteness(user, detail, skills)

  return res.json(new ApiResponse(200, { ...report, detail }))
})

// ─── GET /apply/:slug/preflight ───────────────────────────────────────────────
// Called by ApplyPage before showing the apply button.
// Returns:
//   - posting summary
//   - profile completeness
//   - pre-filled application data (so frontend can show "your data will be used")
const getApplyPreflight = asyncHandler(async (req, res) => {
  const { slug } = req.params

  // Posting must be active
  const posting = await prisma.jobPosting.findUnique({
    where: { applyLinkSlug: slug },
    select: {
      id: true, title: true, companyName: true, description: true,
      minExperience: true, examEnabled: true, assignmentBrief: true,
      applyLinkSlug: true, status: true,
      requiredSkills: { select: { required: true, skill: { select: { name: true } } } },
    },
  })
  if (!posting || posting.status !== 'active') throw new ApiError(404, 'This job posting is not available')

  // Already applied?
  const existing = await prisma.application.findUnique({
    where: { jobPostingId_userId: { jobPostingId: posting.id, userId: req.user.id } },
    select: { id: true, stage: true, status: true },
  })

  // Load profile
  const [user, detail, userSkills] = await Promise.all([
    prisma.user.findUnique({ where: { id: req.user.id }, select: { id: true, name: true, email: true, avatar: true } }),
    prisma.profileDetail.findUnique({
      where: { userId: req.user.id },
      include: {
        education:      { orderBy: { startYear: 'desc' } },
        experience:     { orderBy: { startDate: 'desc' } },
        certifications: { orderBy: { issueDate: 'desc' } },
      },
    }),
    prisma.userSkill.findMany({ where: { userId: req.user.id }, include: { skill: true } }),
  ])

  const skills = userSkills.map(us => us.skill)
  const completeness = computeCompleteness(user, detail, skills)

  // Shape the posting's required skills for display
  const requiredSkills = posting.requiredSkills.map(rs => ({
    name: rs.skill.name,
    required: rs.required,
  }))

  // Pre-fill snapshot — what will be submitted on their behalf
  const prefill = {
    name:       user.name,
    email:      user.email,
    phone:      detail?.phone || null,
    headline:   detail?.headline || null,
    location:   detail?.location || null,
    summary:    detail?.summary || null,
    cvUrl:      signRawUrl(detail?.cvUrl || null),
    cvParsedAt: detail?.cvParsedAt || null,
    githubUrl:  detail?.githubUrl || null,
    linkedinUrl: detail?.linkedinUrl || null,
    portfolioUrl: detail?.portfolioUrl || null,
    skills:     skills.map(s => s.name),
    education:  detail?.education || [],
    experience: detail?.experience || [],
  }

  return res.json(new ApiResponse(200, {
    posting: { ...posting, requiredSkills },
    alreadyApplied: !!existing,
    existingApplication: existing || null,
    completeness,
    prefill,
  }))
})

module.exports = { getProfileCompleteness, getApplyPreflight }
