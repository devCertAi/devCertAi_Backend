const bcrypt = require('bcryptjs')
const prisma = require('../config/database')
const { ApiError } = require('../utils/ApiError')
const { ApiResponse } = require('../utils/ApiResponse')
const asyncHandler = require('../utils/asyncHandler')
const { uploadAvatar, uploadCV, signRawUrl, signRawUrlCandidates } = require('../services/storageService')
const queues = require('../queues')
const { defaultOpts } = queues
const { parseResumeFromBuffer, extractExperienceYears } = require('../services/resumeParser')
const { computeCompleteness } = require('../utils/profileCompleteness')
const multer = require('multer')
const axios = require('axios')
const { CLEAR_COOKIE_OPTS } = require('../utils/tokenUtils')

// Separate multer instances — avatar stays at 5 MB, CV bumped to 10 MB
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } })
const uploadCVMulter = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } })

// ─── updateProfile ────────────────────────────────────────────────────────────

const updateProfile = asyncHandler(async (req, res) => {
  const { name } = req.body
  const updateData = {}
  if (name) updateData.name = name

  if (req.file) {
    const result = await uploadAvatar(req.file.buffer)
    updateData.avatar = result.secure_url
  }

  const user = await prisma.user.update({
    where: { id: req.user.id },
    data: updateData,
    select: { id: true, name: true, email: true, username: true, avatar: true, isPremium: true }
  })

  return res.json(new ApiResponse(200, { user }, 'Profile updated'))
})

// ─── getPublicProfile ─────────────────────────────────────────────────────────

const getPublicProfile = asyncHandler(async (req, res) => {
  const requestUserId = req.user?.id ?? null

  const user = await prisma.user.findUnique({
    where: { username: req.params.username },
    select: {
      id: true, name: true, username: true, avatar: true, createdAt: true,
      _count: { select: { certificates: true, projects: true } },
      skills: { include: { skill: true } },
      profileDetail: {
        include: {
          education:      { orderBy: { startYear: 'desc' } },
          experience:     { orderBy: { startDate: 'desc' } },
          certifications: { orderBy: { issueDate: 'desc' } },
          trainings:      { orderBy: { startDate: 'desc'  } },
          projects:       { orderBy: { startDate: 'desc'  } },
          portfolios:     { orderBy: { createdAt: 'asc'   } }
        }
      }
    }
  })
  if (!user) throw new ApiError(404, 'User not found')

  const isOwner = requestUserId === user.id

  const certificates = await prisma.certificate.findMany({
    where: { userId: user.id, ...(isOwner ? {} : { isPublic: true }) },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true, type: true, domain: true, level: true, score: true,
      verificationId: true, createdAt: true, isPublic: true
    }
  })

  if (user.profileDetail?.cvUrl) {
    user.profileDetail = { ...user.profileDetail, cvUrl: signRawUrl(user.profileDetail.cvUrl) }
  }

  return res.json(new ApiResponse(200, { user, certificates, isOwner }))
})

// ─── changePassword ───────────────────────────────────────────────────────────

const changePassword = asyncHandler(async (req, res) => {
  const { oldPassword, newPassword } = req.body

  if (!oldPassword || !newPassword) throw new ApiError(400, 'Old and new passwords required')
  if (newPassword.length < 8) throw new ApiError(400, 'New password must be at least 8 characters')

  const user = await prisma.user.findUnique({ where: { id: req.user.id } })
  if (!user.password) throw new ApiError(400, 'Cannot change password for OAuth accounts')

  const isMatch = await bcrypt.compare(oldPassword, user.password)
  if (!isMatch) throw new ApiError(400, 'Current password is incorrect')

  const hashed = await bcrypt.hash(newPassword, 12)
  await prisma.user.update({ where: { id: req.user.id }, data: { password: hashed } })

  return res.json(new ApiResponse(200, {}, 'Password changed successfully'))
})

// ─── getDashboard ─────────────────────────────────────────────────────────────

const getDashboard = asyncHandler(async (req, res) => {
  const userId = req.user.id

  const [projectCount, certCount, examCount, recentProjects, recentActivity, skills, pendingApplications] = await Promise.all([
    prisma.project.count({ where: { userId } }),
    prisma.certificate.count({ where: { userId } }),
    prisma.examAttempt.count({ where: { userId, source: { not: 'demo' } } }),
    prisma.project.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: 5,
      select: { id: true, title: true, domain: true, score: true, level: true, status: true, createdAt: true }
    }),
    prisma.notification.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: 10
    }),
    prisma.userSkill.findMany({ where: { userId }, include: { skill: true } }),
    prisma.application.findMany({
      where: { userId, status: 'in_progress', stage: { in: ['assignment_sent', 'exam_sent'] } },
      orderBy: { updatedAt: 'desc' },
      select: {
        id: true, stage: true, assignmentDeadlineAt: true, examWindowExpiresAt: true,
        jobPosting: { select: { title: true, companyName: true } }
      }
    })
  ])

  const avgScore = await prisma.project.aggregate({
    where: { userId, status: 'completed', score: { not: null } },
    _avg: { score: true }
  })

  return res.json(new ApiResponse(200, {
    stats: { projectCount, certCount, examCount, avgScore: Math.round(avgScore._avg.score || 0) },
    recentProjects,
    recentActivity,
    skills: skills.map(s => ({ id: s.skill.id, name: s.skill.name, level: s.level })),
    pendingApplications
  }))
})

// ─── updateSkills ─────────────────────────────────────────────────────────────

const updateSkills = asyncHandler(async (req, res) => {
  const { skills } = req.body
  const userId = req.user.id

  const result = await prisma.$transaction(async (tx) => {
    const skillRecords = []
    for (const s of skills) {
      const name = s.name.trim()
      let skill = await tx.skill.findFirst({ where: { name: { equals: name, mode: 'insensitive' } } })
      if (!skill) skill = await tx.skill.create({ data: { name } })
      skillRecords.push({ skill, level: s.level })
    }

    const keepIds = skillRecords.map(r => r.skill.id)
    await tx.userSkill.deleteMany({ where: { userId, skillId: { notIn: keepIds.length ? keepIds : ['__none__'] } } })

    for (const { skill, level } of skillRecords) {
      await tx.userSkill.upsert({
        where: { userId_skillId: { userId, skillId: skill.id } },
        update: { level: level ?? null },
        create: { userId, skillId: skill.id, level: level ?? null }
      })
    }

    return tx.userSkill.findMany({ where: { userId }, include: { skill: true } })
  })

  await queues.matchQueue.add({ type: 'user_match', userId }, defaultOpts)

  return res.json(new ApiResponse(200, {
    skills: result.map(s => ({ id: s.skill.id, name: s.skill.name, level: s.level }))
  }, 'Skills updated'))
})

// NOTE: becomeRecruiter was removed — it mutated `User.role` to 'recruiter'
// in place with no Company/Recruiter record backing it, bypassing the real
// recruiter signup flow entirely. Recruiters are created exclusively via
// recruiterAuthController.js now (separate `Recruiter` table, OTP-verified).

// ─── deleteAccount ────────────────────────────────────────────────────────────

const deleteAccount = asyncHandler(async (req, res) => {
  const { password } = req.body
  if (!password) throw new ApiError(400, 'Password is required to delete your account')

  const user = await prisma.user.findUnique({ where: { id: req.user.id } })

  if (user.password) {
    const valid = await bcrypt.compare(password, user.password)
    if (!valid) throw new ApiError(400, 'Incorrect password')
  }

  await prisma.user.delete({ where: { id: req.user.id } })
  res.clearCookie('refreshToken', CLEAR_COOKIE_OPTS)
  return res.json(new ApiResponse(200, {}, 'Account deleted'))
})

// ─── getProfileDetail ─────────────────────────────────────────────────────────

const getProfileDetail = asyncHandler(async (req, res) => {
  const detail = await prisma.profileDetail.findUnique({
    where: { userId: req.user.id },
    include: {
      education:      { orderBy: { startYear: 'desc' } },
      experience:     { orderBy: { startDate: 'desc' } },
      certifications: { orderBy: { issueDate: 'desc' } }
    }
  })
  return res.json(new ApiResponse(200, {
    detail: detail ? { ...detail, cvUrl: signRawUrl(detail.cvUrl) } : null
  }))
})

// ─── updateProfileDetail ──────────────────────────────────────────────────────

const updateProfileDetail = asyncHandler(async (req, res) => {
  const userId = req.user.id
  const {
    headline, summary, phone, location, gender, dob,
    linkedinUrl, githubUrl, portfolioUrl,
    extraCurricular, accomplishments,
    education = [], experience = [], certifications = [],
    trainings = [], projects = [], portfolios = []
  } = req.body

  const parseDate = (raw) => {
    if (!raw) return null
    const d = new Date(raw)
    return isNaN(d.getTime()) ? null : d
  }

  const detail = await prisma.$transaction(async (tx) => {
    const root = await tx.profileDetail.upsert({
      where:  { userId },
      create: {
        userId, headline, summary, phone, location, gender,
        dob: parseDate(dob), linkedinUrl, githubUrl, portfolioUrl,
        extraCurricular: extraCurricular || null,
        accomplishments: accomplishments || null
      },
      update: {
        headline, summary, phone, location, gender,
        dob: parseDate(dob), linkedinUrl, githubUrl, portfolioUrl,
        extraCurricular: extraCurricular || null,
        accomplishments: accomplishments || null
      }
    })

    await tx.education.deleteMany({ where: { profileId: root.id } })
    if (education.length) {
      await tx.education.createMany({
        data: education.map(e => ({
          profileId:    root.id,
          institution:  e.institution,
          degree:       e.degree       || null,
          fieldOfStudy: e.fieldOfStudy || null,
          startYear:    e.startYear    ? parseInt(e.startYear) : null,
          endYear:      e.endYear      ? parseInt(e.endYear)   : null,
          grade:        e.grade        || null,
          description:  e.description  || null
        }))
      })
    }

    await tx.experience.deleteMany({ where: { profileId: root.id } })
    if (experience.length) {
      await tx.experience.createMany({
        data: experience.map(e => ({
          profileId:      root.id,
          company:        e.company,
          title:          e.title,
          employmentType: e.employmentType || null,
          location:       e.location       || null,
          startDate:      parseDate(e.startDate),
          endDate:        e.isCurrent ? null : parseDate(e.endDate),
          isCurrent:      e.isCurrent      || false,
          description:    e.description    || null
        }))
      })
    }

    await tx.profileCertification.deleteMany({ where: { profileId: root.id } })
    if (certifications.length) {
      await tx.profileCertification.createMany({
        data: certifications.map(c => ({
          profileId:     root.id,
          name:          c.name,
          issuer:        c.issuer        || null,
          issueDate:     parseDate(c.issueDate),
          expiryDate:    parseDate(c.expiryDate),
          credentialUrl: c.credentialUrl || null
        }))
      })
    }

    await tx.profileTraining.deleteMany({ where: { profileId: root.id } })
    if (trainings.length) {
      await tx.profileTraining.createMany({
        data: trainings.map(t => ({
          profileId:    root.id,
          program:      t.program,
          organization: t.organization || null,
          location:     t.isOnline ? null : (t.location || null),
          isOnline:     t.isOnline     || false,
          startDate:    parseDate(t.startDate),
          endDate:      t.isOngoing ? null : parseDate(t.endDate),
          isOngoing:    t.isOngoing    || false,
          description:  t.description  || null
        }))
      })
    }

    await tx.profileProject.deleteMany({ where: { profileId: root.id } })
    if (projects.length) {
      await tx.profileProject.createMany({
        data: projects.map(p => ({
          profileId:   root.id,
          title:       p.title,
          startDate:   parseDate(p.startDate),
          endDate:     p.isOngoing ? null : parseDate(p.endDate),
          isOngoing:   p.isOngoing   || false,
          projectUrl:  p.projectUrl  || null,
          description: p.description || null
        }))
      })
    }

    await tx.profilePortfolio.deleteMany({ where: { profileId: root.id } })
    if (portfolios.length) {
      await tx.profilePortfolio.createMany({
        data: portfolios.map(p => ({
          profileId: root.id,
          title:     p.title,
          url:       p.url
        }))
      })
    }

    return tx.profileDetail.findUnique({
      where: { id: root.id },
      include: {
        education:      { orderBy: { startYear: 'desc' } },
        experience:     { orderBy: { startDate: 'desc' } },
        certifications: { orderBy: { issueDate: 'desc' } },
        trainings:      { orderBy: { startDate: 'desc'  } },
        projects:       { orderBy: { startDate: 'desc'  } },
        portfolios:     { orderBy: { createdAt: 'asc'   } }
      }
    })
  }, { timeout: 15000 })

  return res.json(new ApiResponse(200, { detail }, 'Profile updated'))
})

// ─── uploadAndParseCV ─────────────────────────────────────────────────────────

const uploadAndParseCV = asyncHandler(async (req, res) => {
  if (!req.file) throw new ApiError(400, 'No file uploaded')

  const userId = req.user.id
  const { buffer, originalname } = req.file

  const uploaded = await uploadCV(buffer, originalname)
  const cvUrl = uploaded.secure_url

  const { rawText, parsed } = await parseResumeFromBuffer(buffer)

  const parsedSkills = parsed.skills.map(s => s.name)
  const experienceYears = extractExperienceYears(rawText)
  await prisma.parsedResume.upsert({
    where:  { userId },
    update: { rawText, parsedSkills, experienceYears },
    create: { userId, rawText, parsedSkills, experienceYears }
  })

  await prisma.profileDetail.upsert({
    where:  { userId },
    create: { userId, cvUrl, cvParsedAt: new Date() },
    update: {         cvUrl, cvParsedAt: new Date() }
  })

  return res.json(new ApiResponse(200, { cvUrl: signRawUrl(cvUrl), parsed }, 'CV uploaded and parsed'))
})

// ─── viewCV (proxy) ───────────────────────────────────────────────────────────
// Streams the CV PDF through OUR OWN domain instead of sending the browser
// straight to a res.cloudinary.com URL. Two problems this fixes at once:
//   1. The address bar / new tab stays on our own domain (no "redirect to
//      another website").
//   2. We control the response headers, so the browser's built-in PDF viewer
//      always gets a real `application/pdf` body with an `inline` disposition
//      — instead of whatever Cloudinary's raw/upload delivery happens to send
//      (which is what was producing "Failed to load PDF document" once the
//      restricted-media-types signature was stale or mismatched).
// We always re-sign the stored URL fresh, right before fetching it, so this
// never depends on a previously-generated link having not expired yet.
async function streamCV(cvUrl, res) {
  if (!cvUrl) throw new ApiError(404, 'No CV uploaded')

  // Fail fast with a clear message instead of a mysterious 502 further down
  // if the Cloudinary credentials aren't even configured in this environment.
  if (!process.env.CLOUDINARY_CLOUD_NAME || !process.env.CLOUDINARY_API_KEY || !process.env.CLOUDINARY_API_SECRET) {
    console.error('[CV proxy] Cloudinary credentials are not configured (CLOUDINARY_CLOUD_NAME/API_KEY/API_SECRET)')
    throw new ApiError(500, 'CV storage is not configured on this server')
  }

  // Try the plain stored URL first (covers accounts where "Restricted media
  // types" for raw/PDF delivery isn't actually enabled — in which case
  // signing is unnecessary and, if done wrong, can itself cause a 401).
  // Fall back to the signed candidates only if the plain URL is rejected.
  const attempts = [cvUrl, ...signRawUrlCandidates(cvUrl).filter(u => u !== cvUrl)]

  let upstream = null
  let lastErr = null
  for (const candidateUrl of attempts) {
    try {
      upstream = await axios.get(candidateUrl, { responseType: 'arraybuffer', timeout: 15000 })
      console.log('[CV proxy] succeeded with:', candidateUrl === cvUrl ? 'plain stored URL' : 'signed URL', candidateUrl)
      break
    } catch (err) {
      lastErr = err
      const status = err.response?.status
      const cldReason = err.response?.headers?.['x-cld-error']
      console.error('[CV proxy] candidate failed:', { url: candidateUrl, status, cldReason, message: err.message })
    }
  }

  if (!upstream) {
    const status = lastErr?.response?.status
    const cldReason = lastErr?.response?.headers?.['x-cld-error']
    console.error('[CV proxy] all candidates failed:', { status, cldReason, message: lastErr?.message })

    if (status === 401) {
      throw new ApiError(502, 'CV storage rejected the request (signature mismatch) — check Cloudinary credentials')
    }
    if (status === 404) {
      throw new ApiError(404, 'CV file could not be found in storage')
    }
    throw new ApiError(502, 'Could not retrieve the CV from storage right now')
  }

  res.setHeader('Content-Type', 'application/pdf')
  res.setHeader('Content-Disposition', 'inline; filename="cv.pdf"')
  res.setHeader('Cache-Control', 'private, max-age=0, no-cache')
  return res.send(Buffer.from(upstream.data))
}

// Own CV — GET /users/me/cv
const viewOwnCV = asyncHandler(async (req, res) => {
  const detail = await prisma.profileDetail.findUnique({
    where: { userId: req.user.id },
    select: { cvUrl: true }
  })
  await streamCV(detail?.cvUrl, res)
})

// Any visible profile's CV — GET /users/:username/cv
const viewUserCV = asyncHandler(async (req, res) => {
  const user = await prisma.user.findUnique({
    where: { username: req.params.username },
    select: { profileDetail: { select: { cvUrl: true } } }
  })
  if (!user) throw new ApiError(404, 'User not found')
  await streamCV(user.profileDetail?.cvUrl, res)
})

// ─── deleteCV ─────────────────────────────────────────────────────────────────
// (The Profile page's "remove CV" button already called DELETE /users/cv, but
// no matching route/controller existed yet — added here alongside the CV
// proxy work since it's the same feature.)
const deleteCV = asyncHandler(async (req, res) => {
  await prisma.profileDetail.updateMany({
    where: { userId: req.user.id },
    data: { cvUrl: null, cvParsedAt: null }
  })
  return res.json(new ApiResponse(200, {}, 'CV removed'))
})

// ─── getProfileCompleteness ───────────────────────────────────────────────────

const getProfileCompleteness = asyncHandler(async (req, res) => {
  const userId = req.user.id

  const [user, detail, userSkills] = await Promise.all([
    prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, name: true, avatar: true }
    }),
    prisma.profileDetail.findUnique({
      where: { userId },
      include: {
        education:      { orderBy: { startYear: 'desc' } },
        experience:     { orderBy: { startDate: 'desc' } },
        certifications: { orderBy: { issueDate: 'desc' } }
      }
    }),
    prisma.userSkill.findMany({ where: { userId }, include: { skill: true } })
  ])

  const skills = userSkills.map(us => us.skill)
  const report = computeCompleteness(user, detail, skills)

  return res.json(new ApiResponse(200, { ...report, detail }))
})

module.exports = {
  getPublicProfile, updateProfile, changePassword,
  getDashboard, updateSkills, deleteAccount,
  getProfileDetail, updateProfileDetail,
  uploadAndParseCV,
  viewOwnCV,
  viewUserCV,
  deleteCV,
  getProfileCompleteness,
  upload,
  uploadCVMulter
}