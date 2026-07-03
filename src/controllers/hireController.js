/**
 * hireController.js — Recruiter pipeline manual action endpoints
 *
 * PATCH  /recruiter/applications/:id/hire           — mark as hired/selected
 * PATCH  /recruiter/applications/:id/reject         — manually reject with reason
 * POST   /recruiter/applications/:id/advance        — manually advance to next stage
 * POST   /recruiter/applications/:id/send-reminder  — send stage reminder to student
 * POST   /recruiter/applications/:id/send-assignment — (re)send assignment email
 * POST   /recruiter/applications/:id/send-test       — (re)send exam link
 * GET    /recruiter/postings/:id/ranked             — final ranked list
 * GET    /recruiter/manual-pending                  — postings with pending manual actions
 */

const prisma = require('../config/database')
const { ApiError } = require('../utils/ApiError')
const { ApiResponse } = require('../utils/ApiResponse')
const asyncHandler = require('../utils/asyncHandler')
const queues = require('../queues')
const { defaultOpts } = queues
const pipelineService = require('../services/pipelineService')

// ─── Helper ───────────────────────────────────────────────────────────────────

async function assertOwnership(applicationId, recruiterId) {
  const application = await prisma.application.findUnique({
    where: { id: applicationId },
    include: {
      jobPosting: { select: { id: true, recruiterId: true, title: true, companyName: true, manualMode: true } }
    }
  })
  if (!application) throw new ApiError(404, 'Application not found')
  if (application.jobPosting.recruiterId !== recruiterId) throw new ApiError(403, 'Not authorized')
  return application
}

// ─── PATCH /recruiter/applications/:id/hire ───────────────────────────────────

const hireCandidate = asyncHandler(async (req, res) => {
  const application = await assertOwnership(req.params.id, req.user.id)
  if (application.status === 'selected') {
    return res.json(new ApiResponse(200, { message: 'Candidate already marked as hired' }))
  }

  const updated = await prisma.application.update({
    where: { id: application.id },
    data: {
      status: 'selected',
      stage: 'ranked',
      selectionNarrative: req.body.note || `Selected by recruiter on ${new Date().toDateString()}.`
    }
  })

  await prisma.applicationStageEvent.create({
    data: { applicationId: application.id, stage: 'selected' }
  }).catch(() => {})

  await queues.emailQueue.add({
    type: 'application_status',
    applicationId: application.id,
    emailType: 'candidate_selected'
  }, defaultOpts)

  await pipelineService.notifyStudent(application.userId, {
    type: 'application_selected',
    title: '🎉 You\'ve been selected!',
    message: `Congratulations! You have been selected for "${application.jobPosting.title}".`,
    data: { applicationId: application.id, jobPostingId: application.jobPosting.id }
  })

  return res.json(new ApiResponse(200, { application: updated, message: 'Candidate marked as hired' }))
})

// ─── PATCH /recruiter/applications/:id/reject ─────────────────────────────────

const rejectCandidate = asyncHandler(async (req, res) => {
  const application = await assertOwnership(req.params.id, req.user.id)
  if (application.status === 'rejected') {
    return res.json(new ApiResponse(200, { message: 'Candidate already rejected' }))
  }

  try {
    await pipelineService.manualRejectCandidate(req.params.id, req.user.id, {
      reason: req.body.reason
    })
  } catch (err) {
    // Fallback to direct update if pipelineService throws
    await prisma.application.update({
      where: { id: application.id },
      data: {
        status: 'rejected',
        rejectionReason: req.body.reason || 'Does not meet requirements for this role at this time.'
      }
    })
  }

  const updated = await prisma.application.findUnique({ where: { id: application.id } })
  return res.json(new ApiResponse(200, { application: updated, message: 'Candidate rejected' }))
})

// ─── POST /recruiter/applications/:id/advance ────────────────────────────────
// Manual pipeline: recruiter triggers next stage

const advanceApplication = asyncHandler(async (req, res) => {
  const application = await assertOwnership(req.params.id, req.user.id)

  if (!application.jobPosting.manualMode) {
    throw new ApiError(400, 'This posting is not in manual mode. Use auto-pipeline.')
  }

  if (['selected', 'rejected'].includes(application.status)) {
    throw new ApiError(400, 'Application is already finalized')
  }

  await pipelineService.manualAdvanceStage(req.params.id, req.user.id, {
    targetStage: req.body.targetStage,
    note: req.body.note
  })

  const updated = await prisma.application.findUnique({
    where: { id: req.params.id },
    include: { jobPosting: { select: { title: true, manualMode: true } } }
  })

  return res.json(new ApiResponse(200, {
    application: updated,
    message: `Application advanced from "${application.stage}" to next stage`
  }))
})

// ─── POST /recruiter/applications/:id/send-reminder ──────────────────────────
// Send a reminder to the student to complete their current pending action

const sendStageReminder = asyncHandler(async (req, res) => {
  const application = await assertOwnership(req.params.id, req.user.id)

  const REMINDABLE_STAGES = ['assignment_sent', 'exam_sent', 'exam_phase2_sent']
  if (!REMINDABLE_STAGES.includes(application.stage)) {
    throw new ApiError(400, `Cannot send reminder for stage "${application.stage}"`)
  }

  // Determine email type
  const emailTypeMap = {
    assignment_sent: 'assignment_reminder',
    exam_sent: 'exam_reminder',
    exam_phase2_sent: 'exam_phase2_reminder'
  }

  await queues.emailQueue.add({
    type: 'application_status',
    applicationId: application.id,
    emailType: emailTypeMap[application.stage],
    isReminder: true,
    recruiterNote: req.body.note
  }, defaultOpts)

  // Increment reminder count
  const field = application.stage === 'assignment_sent' ? 'assignmentRemindersSent' : 'examRemindersSent'
  await prisma.application.update({
    where: { id: application.id },
    data: { [field]: { increment: 1 } }
  })

  return res.json(new ApiResponse(200, { message: `Reminder sent to ${application.userId}` }))
})

// ─── POST /recruiter/applications/:id/send-assignment ────────────────────────

const sendAssignment = asyncHandler(async (req, res) => {
  const application = await assertOwnership(req.params.id, req.user.id)

  if (!['screened', 'assignment_sent'].includes(application.stage)) {
    throw new ApiError(400, 'Application must be at screened or assignment_sent stage')
  }

  await pipelineService.moveToAssignmentSent(req.params.id)

  return res.json(new ApiResponse(200, { message: 'Assignment sent' }))
})

// ─── POST /recruiter/applications/:id/send-test ───────────────────────────────

const sendTestLink = asyncHandler(async (req, res) => {
  const application = await assertOwnership(req.params.id, req.user.id)

  const ALLOWED_STAGES = ['screened', 'project_evaluated', 'exam_sent']
  if (!ALLOWED_STAGES.includes(application.stage)) {
    throw new ApiError(400, `Cannot send exam from stage "${application.stage}"`)
  }

  await pipelineService.moveToExamPhase1Sent(req.params.id)

  return res.json(new ApiResponse(200, { message: 'Exam link sent' }))
})

// ─── GET /recruiter/postings/:id/ranked ──────────────────────────────────────

const getRankedList = asyncHandler(async (req, res) => {
  const posting = await prisma.jobPosting.findFirst({
    where: { id: req.params.id, recruiterId: req.user.id }
  })
  if (!posting) throw new ApiError(404, 'Posting not found')

  const applications = await prisma.application.findMany({
    where: { jobPostingId: req.params.id, stage: 'ranked' },
    orderBy: [{ status: 'asc' }, { rank: 'asc' }],
    include: {
      user: { select: { id: true, name: true, username: true, email: true, avatar: true } }
    }
  })

  return res.json(new ApiResponse(200, {
    posting: { id: posting.id, title: posting.title, rankingSummary: posting.rankingSummary },
    applications
  }))
})

// ─── GET /recruiter/manual-pending ───────────────────────────────────────────
// Returns applications waiting for recruiter manual action

const getManualPending = asyncHandler(async (req, res) => {
  const postings = await prisma.jobPosting.findMany({
    where: { recruiterId: req.user.id, manualMode: true, status: 'active' },
    select: { id: true }
  })

  if (postings.length === 0) {
    return res.json(new ApiResponse(200, { applications: [] }))
  }

  const postingIds = postings.map(p => p.id)

  // Find in-progress applications not yet at final stage
  const applications = await prisma.application.findMany({
    where: {
      jobPostingId: { in: postingIds },
      status: 'in_progress',
      stage: {
        in: ['screened', 'project_evaluated', 'exam_completed', 'exam_phase2_completed']
      }
    },
    orderBy: { updatedAt: 'asc' },
    include: {
      user: { select: { id: true, name: true, email: true, avatar: true } },
      jobPosting: { select: { id: true, title: true, manualMode: true } }
    }
  })

  return res.json(new ApiResponse(200, {
    applications,
    total: applications.length
  }))
})

module.exports = {
  hireCandidate,
  rejectCandidate,
  advanceApplication,
  sendStageReminder,
  sendAssignment,
  sendTestLink,
  getRankedList,
  getManualPending
}