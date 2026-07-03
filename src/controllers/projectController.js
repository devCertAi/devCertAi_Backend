const prisma = require('../config/database')
const { ApiError } = require('../utils/ApiError')
const { ApiResponse } = require('../utils/ApiResponse')
const asyncHandler = require('../utils/asyncHandler')
const queues = require('../queues')
const { defaultOpts } = queues
const { validateGithubRepo } = require('../ai/githubAnalyzer')
const { uploadZip } = require('../services/storageService')
const multer = require('multer')
const axios = require('axios')
const fs = require('fs')
const path = require('path')
const os = require('os')
const { deleteFile } = require('../services/storageService')
const creditService = require('../services/creditService')

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } })

// POST /submit
const submitProject = asyncHandler(async (req, res) => {
  const { title, description, githubUrl, liveUrl, domain } = req.body
  const userId = req.user.id

  let zipFileUrl = null

  // Validate GitHub URL
  // FIX: wrap in try/catch so transient GitHub API errors (rate-limits, network)
  // don't block a legitimate submission. Only hard validation failures (private
  // repo, not enough commits) are still rejected.
  if (githubUrl) {
    try {
      const validation = await validateGithubRepo(githubUrl)
      if (validation.valid) {
        if (!validation.isPublic) throw new ApiError(400, 'Repository must be public')
        if (!validation.hasEnoughCommits) throw new ApiError(400, `Repository must have at least 5 commits (found ${validation.commitCount})`)
      }
      // If validation.valid === false it means GitHub API is unreachable —
      // allow submission and let the AI worker handle the fetch failure gracefully.
    } catch (err) {
      if (err instanceof ApiError) throw err
      // Non-ApiError (network error, rate limit): let submission proceed
    }
  }

  // Validate live URL
  if (liveUrl && !githubUrl && !req.file) {
    try {
      const response = await axios.head(liveUrl, { timeout: 5000 })
      if (response.status >= 400) throw new ApiError(400, 'Live URL is not accessible')
    } catch (err) {
      if (err instanceof ApiError) throw err
      throw new ApiError(400, 'Could not reach the live URL. Make sure it returns a valid response.')
    }
  }

  // Credit gate — runs after validation so a rejected submission never costs
  // the user a credit. Premium users bypass this entirely (unlimited).
  if (!req.user.isPremium) {
    await creditService.consumeCredit(userId, 'project', { title, domain })
  }

  // Handle ZIP upload
  if (req.file) {
  const tmpPath = path.join(os.tmpdir(), `devcert-${Date.now()}.zip`)
  fs.writeFileSync(tmpPath, req.file.buffer)
  zipFileUrl = tmpPath
}

  const project = await prisma.project.create({
    data: { userId, title, description, githubUrl, liveUrl, zipFileUrl, domain, status: 'pending' }
  })

  await queues.projectEvalQueue.add({ projectId: project.id }, defaultOpts)

  return res.status(201).json(new ApiResponse(201, {
    projectId: project.id,
    message: 'Project submitted. AI evaluation started — you\'ll be notified when complete.'
  }))
})



// GET / — user's projects paginated
const getUserProjects = asyncHandler(async (req, res) => {
  const { page = 1, limit = 10, domain, status } = req.query
  const skip = (parseInt(page) - 1) * parseInt(limit)

  const where = { userId: req.user.id }
  if (domain) where.domain = domain
  if (status) where.status = status

  const [projects, total] = await Promise.all([
    prisma.project.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip,
      take: parseInt(limit),
      select: {
        id: true, title: true, domain: true, score: true, level: true,
        status: true, createdAt: true, githubUrl: true, liveUrl: true,
        certificate: { select: { id: true, verificationId: true } }
      }
    }),
    prisma.project.count({ where })
  ])

  return res.json(new ApiResponse(200, {
    projects,
    pagination: { total, page: parseInt(page), limit: parseInt(limit), pages: Math.ceil(total / parseInt(limit)) }
  }))
})


// GET /:id
const getProject = asyncHandler(async (req, res) => {
 const project = await prisma.project.findFirst({
  where: { id: req.params.id, userId: req.user.id },
  include: { certificate: true, user: { select: { username: true } } }
})
  if (!project) throw new ApiError(404, 'Project not found')

  // For non-premium users, hide the deep-analysis-only content.
  // FIX: the previous version of this trim used flat keys (report.strengths,
  // report.categories) that don't exist on the actual report shape produced by
  // the Python evaluation pipeline (it's nested: bugReport, architectureReport,
  // plagiarismReport, fastScores, bestPracticesReport, improvementsReport, plus
  // top-level topStrength/topWeakness/categoryScores/nextSteps/...). The old
  // trim was effectively wiping the entire report for free users instead of
  // gating just the premium-only sections. This preserves everything the
  // Overview/Bugs/Certificate tabs need and only strips/truncates the
  // "Deep analysis" tab content, tagging what was removed in `_locked` so the
  // frontend can render an explicit lock-icon upsell instead of a blank section.
  if (!req.user.isPremium && project.evaluationReport) {
    let r = project.evaluationReport
    if (typeof r === 'string') {
      try { r = JSON.parse(r) } catch { r = {} }
    }

    const locked = ['nextSteps', 'suggestedChanges', 'projectedScore']
    const fullBugCount = r.bugReport?.bugs?.length || 0
    const fullImprovementCount = r.improvementsReport?.improvements?.length || 0
    if (fullBugCount > 2) locked.push('bugReport.bugs')
    if (fullImprovementCount > 1) locked.push('improvementsReport.improvements')

    project.evaluationReport = {
      ...r,
      nextSteps: undefined,
      suggestedChanges: undefined,
      projectedScore: undefined,
      bugReport: r.bugReport ? { ...r.bugReport, bugs: (r.bugReport.bugs || []).slice(0, 2), _fullCount: fullBugCount } : r.bugReport,
      improvementsReport: r.improvementsReport ? { ...r.improvementsReport, improvements: (r.improvementsReport.improvements || []).slice(0, 1), _fullCount: fullImprovementCount } : r.improvementsReport,
      _locked: locked
    }
  }

  return res.json(new ApiResponse(200, { project }))
})

// GET /:id/report — full report (premium only)
const getProjectReport = asyncHandler(async (req, res) => {
  const project = await prisma.project.findFirst({
    where: { id: req.params.id, userId: req.user.id }
  })
  if (!project) throw new ApiError(404, 'Project not found')
  if (!project.evaluationReport) throw new ApiError(404, 'Evaluation report not yet available')

  return res.json(new ApiResponse(200, { report: project.evaluationReport }))
})

// POST /:id/re-evaluate
const reEvaluate = asyncHandler(async (req, res) => {
  const project = await prisma.project.findFirst({
    where: { id: req.params.id, userId: req.user.id }
  })
  if (!project) throw new ApiError(404, 'Project not found')

  const maxRetries = req.user.isPremium ? 10 : 3
  if (project.reEvalCount >= maxRetries) {
    throw new ApiError(400, `Maximum re-evaluation limit (${maxRetries}) reached`)
  }
  if (project.status === 'evaluating') throw new ApiError(400, 'Evaluation already in progress')

  await prisma.project.update({
    where: { id: project.id },
    data: { status: 'pending', reEvalCount: { increment: 1 } }
  })

  await queues.projectEvalQueue.add({ projectId: project.id }, defaultOpts)

  return res.json(new ApiResponse(200, { message: 'Re-evaluation started' }))
})

// DELETE /:id
const deleteProject = asyncHandler(async (req, res) => {
  const project = await prisma.project.findUnique({
    where: { id: req.params.id }
  })

  if (!project) throw new ApiError(404, 'Project not found')
  if (project.userId !== req.user.id) throw new ApiError(403, 'Not authorized')

  // Delete from Cloudinary if file exists
  if (project.cloudinaryId) {
    await deleteFile(project.cloudinaryId)
  }

  await prisma.project.delete({ where: { id: req.params.id } })

  return res.json(new ApiResponse(200, {}, 'Project deleted'))
})

// GET /validate-github — validate repo before submitting
const validateGithub = asyncHandler(async (req, res) => {
  const { url } = req.query
  if (!url) throw new ApiError(400, 'URL is required')

  const validation = await validateGithubRepo(url)
  return res.json(new ApiResponse(200, validation))
})

module.exports = { submitProject, getUserProjects, getProject, getProjectReport, reEvaluate, deleteProject: asyncHandler(async (req, res) => {
    const project = await prisma.project.findUnique({
      where: { id: req.params.id }
    })

    if (!project) throw new ApiError(404, 'Project not found')
    if (project.userId !== req.user.id) throw new ApiError(403, 'Not authorized')

    // Delete from Cloudinary if file exists
    if (project.cloudinaryId) {
      await deleteFile(project.cloudinaryId)
    }

    await prisma.project.delete({ where: { id: req.params.id } })

    return res.json(new ApiResponse(200, {}, 'Project deleted'))
  }), validateGithub, upload }