const prisma = require('../config/database')
const { ApiError } = require('../utils/ApiError')
const { ApiResponse } = require('../utils/ApiResponse')
const asyncHandler = require('../utils/asyncHandler')
const pipelineService = require('../services/pipelineService')
const { signRawUrl } = require('../services/storageService')
const multer = require('multer')
const fs = require('fs')
const path = require('path')
const os = require('os')

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } })

const APPLICATION_SELECT = {
  id: true, stage: true, status: true, finalScore: true, rank: true,
  ruleScore: true, aiMatchScore: true, projectScore: true, examScore: true,
  rejectionReason: true, selectionNarrative: true, missingSkills: true,
  assignmentDeadlineAt: true, examWindowExpiresAt: true, examAttemptId: true,
  projectId: true, createdAt: true, updatedAt: true,
  jobPosting: { select: { id: true, title: true, companyName: true, applyLinkSlug: true, examEnabled: true, assignmentBrief: true, examDurationMin: true } }
}

// GET /applications — "My Applications" tracker (student dashboard)
const getMyApplications = asyncHandler(async (req, res) => {
  const { page = 1, limit = 20, status } = req.query
  const skip = (parseInt(page) - 1) * parseInt(limit)

  const where = { userId: req.user.id }
  if (status) where.status = status

  const [applications, total] = await Promise.all([
    prisma.application.findMany({
      where, orderBy: { createdAt: 'desc' }, skip, take: parseInt(limit), select: APPLICATION_SELECT
    }),
    prisma.application.count({ where })
  ])

  return res.json(new ApiResponse(200, {
    applications,
    pagination: { total, page: parseInt(page), limit: parseInt(limit), pages: Math.ceil(total / parseInt(limit)) }
  }))
})

// GET /applications/:id — detail + feedback report for the candidate
const getApplication = asyncHandler(async (req, res) => {
  const application = await prisma.application.findFirst({
    where: { id: req.params.id, userId: req.user.id },
    include: { jobPosting: { select: { id: true, title: true, companyName: true, examEnabled: true, assignmentBrief: true, examDurationMin: true } } }
  })
  if (!application) throw new ApiError(404, 'Application not found')
  if (application.resumeUrl) application.resumeUrl = signRawUrl(application.resumeUrl)

  let project = null
  if (application.projectId) {
    project = await prisma.project.findFirst({
      where: { id: application.projectId, userId: req.user.id },
      select: { id: true, title: true, status: true, score: true, level: true, evaluationReport: true, githubUrl: true, liveUrl: true }
    })
  }

  return res.json(new ApiResponse(200, { application, project }))
})

// POST /applications/:id/submit-assignment
const submitAssignment = asyncHandler(async (req, res) => {
  const { githubUrl, liveUrl, title, description, domain } = req.body

  let zipFileUrl = null
  if (req.file) {
    const tmpPath = path.join(os.tmpdir(), `devcert-assignment-${Date.now()}.zip`)
    fs.writeFileSync(tmpPath, req.file.buffer)
    zipFileUrl = tmpPath
  }

  if (!githubUrl && !liveUrl && !zipFileUrl) {
    throw new ApiError(400, 'Provide a githubUrl, liveUrl, or zip file for your assignment submission')
  }

  const project = await pipelineService.submitAssignment(req.params.id, req.user.id, {
    githubUrl, liveUrl, zipFileUrl, title, description, domain
  })

  return res.status(201).json(new ApiResponse(201, {
    projectId: project.id,
    message: 'Assignment submitted. AI evaluation started — you will be notified when complete.'
  }))
})

// POST /applications/:id/exam/start — transitions the pipeline ExamAttempt
// from "pending" to "in_progress" and returns the questions (answers stripped).
// Once started, the candidate uses the EXISTING exam endpoints
// (/exam/attempt/:id, /exam/attempt/:id/answer, /exam/attempt/:id/submit, etc.)
const startPipelineExam = asyncHandler(async (req, res) => {
  const application = await prisma.application.findFirst({
    where: { id: req.params.id, userId: req.user.id }
  })
  if (!application) throw new ApiError(404, 'Application not found')
  if (application.stage !== 'exam_sent') throw new ApiError(400, `No assessment available in stage "${application.stage}"`)
  if (!application.examAttemptId) throw new ApiError(404, 'Assessment not found for this application')

  if (application.examWindowExpiresAt && application.examWindowExpiresAt < new Date()) {
    throw new ApiError(400, 'The window to start this assessment has expired')
  }

  const attempt = await prisma.examAttempt.findUnique({ where: { id: application.examAttemptId } })
  if (!attempt) throw new ApiError(404, 'Assessment not found')

  if (attempt.status === 'pending') {
    await prisma.examAttempt.update({
      where: { id: attempt.id },
      data: { status: 'in_progress', startedAt: new Date() }
    })
  } else if (attempt.status !== 'in_progress') {
    throw new ApiError(400, `Assessment already ${attempt.status}`)
  }

  const safeQuestions = (attempt.questions || []).map(({ answer, ...safe }) => safe)

  return res.json(new ApiResponse(200, {
    attemptId: attempt.id,
    questions: safeQuestions,
    timeLimitSec: attempt.timeLimitSec
  }))
})

module.exports = { getMyApplications, getApplication, submitAssignment, startPipelineExam, upload }
