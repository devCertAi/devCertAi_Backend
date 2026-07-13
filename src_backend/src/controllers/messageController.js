const prisma = require('../config/database')
const { ApiError } = require('../utils/ApiError')
const { ApiResponse } = require('../utils/ApiResponse')
const asyncHandler = require('../utils/asyncHandler')
const notificationService = require('../services/notificationService')
const queues = require('../queues')
const { defaultOpts } = queues

// POST /applications/:id/messages — recruiter sends a message to a candidate
const sendMessage = asyncHandler(async (req, res) => {
  const { body } = req.body
  if (!body || !body.trim()) throw new ApiError(400, 'Message body is required')

  const application = await prisma.application.findUnique({
    where: { id: req.params.id },
    include: {
      jobPosting: { include: { company: true } },
      user: { select: { id: true, name: true, email: true } }
    }
  })
  if (!application) throw new ApiError(404, 'Application not found')

  // Ownership check — must be the recruiter who owns this posting
  if (application.jobPosting.recruiterId !== req.user.id) {
    throw new ApiError(403, 'You do not have permission to message this applicant')
  }

  const message = await prisma.applicationMessage.create({
    data: {
      applicationId: application.id,
      senderId: req.user.id,
      body: body.trim()
    }
  })

  const companyName = application.jobPosting.company?.name || application.jobPosting.companyName

  // In-app notification to candidate
  await notificationService.create(application.userId, {
    type: 'recruiter_message',
    title: `Message from ${companyName}`,
    message: body.slice(0, 140),
    data: { applicationId: application.id }
  })

  // Email notification
  await queues.emailQueue.add({
    type: 'recruiter_message',
    applicationId: application.id,
    messageBody: body.trim()
  }, defaultOpts)

  return res.status(201).json(new ApiResponse(201, { message }, 'Message sent'))
})

// GET /applications/:id/messages — recruiter or candidate reads the thread
const getMessages = asyncHandler(async (req, res) => {
  const application = await prisma.application.findUnique({
    where: { id: req.params.id },
    include: { jobPosting: { select: { recruiterId: true } } }
  })
  if (!application) throw new ApiError(404, 'Application not found')

  const isCandidate = application.userId === req.user.id
  const isRecruiter = application.jobPosting.recruiterId === req.user.id

  if (!isCandidate && !isRecruiter) {
    throw new ApiError(403, 'Access denied')
  }

  const messages = await prisma.applicationMessage.findMany({
    where: { applicationId: application.id },
    orderBy: { createdAt: 'asc' }
  })

  // Mark unread messages as read if the candidate is fetching
  if (isCandidate) {
    const unreadIds = messages
      .filter(m => !m.readAt && m.senderId !== req.user.id)
      .map(m => m.id)

    if (unreadIds.length > 0) {
      await prisma.applicationMessage.updateMany({
        where: { id: { in: unreadIds } },
        data: { readAt: new Date() }
      })
    }
  }

  return res.json(new ApiResponse(200, { messages }))
})

module.exports = { sendMessage, getMessages }
