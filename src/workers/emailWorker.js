const queues = require('../queues')
const emailService = require('../services/emailService')
const prisma = require('../config/database')

queues.queuesReadyPromise.then(() => {
queues.emailQueue.process(async (job) => {
  const { type, userId, projectId, attemptId, certificateId } = job.data
  console.log(`[EmailWorker] Processing ${type} email for user ${userId || '-'}`)

  switch (type) {
    case 'evaluation_complete': {
      const user = await prisma.user.findUnique({ where: { id: userId } })
      if (!user) return
      const project = await prisma.project.findUnique({ where: { id: projectId } })
      if (!project || !project.evaluationReport) return
      await emailService.sendEvaluationCompleteEmail(user, project, project.evaluationReport)
      break
    }

    case 'exam_result': {
      const user = await prisma.user.findUnique({ where: { id: userId } })
      if (!user) return
      const attempt = await prisma.examAttempt.findUnique({ where: { id: attemptId } })
      if (!attempt) return
      await emailService.sendExamResultEmail(user, attempt)
      break
    }

    case 'certificate_ready': {
      const user = await prisma.user.findUnique({ where: { id: userId } })
      if (!user) return
      const cert = await prisma.certificate.findUnique({ where: { id: certificateId } })
      // Only send email if certificate was actually issued (score >= 40 for projects)
      if (!cert) {
        console.log(`[EmailWorker] certificate_ready: cert ${certificateId} not found, skipping email`)
        return
      }
      // Guard: don't send if score is below passing threshold
      if (cert.score < 40) {
        console.log(`[EmailWorker] certificate_ready: cert ${certificateId} score ${cert.score} < 40, skipping email`)
        return
      }
      await emailService.sendCertificateReadyEmail(user, cert)
      break
    }

    case 'payment_confirmed': {
      const user = await prisma.user.findUnique({ where: { id: userId } })
      if (!user) return
      const { paymentId } = job.data
      const payment = await prisma.payment.findUnique({ where: { id: paymentId } })
      if (!payment) return
      await emailService.sendPaymentConfirmedEmail(user, payment)
      break
    }

    // ------------------------------------------------------------------
    // Recruiter hiring pipeline — pipelineService/reminderWorker enqueue
    // { type: 'application_status', applicationId, emailType, ... } and
    // never call nodemailer directly.
    // ------------------------------------------------------------------
    case 'application_status': {
      await handleApplicationStatusEmail(job.data)
      break
    }

    // §7 — skill-based auto-match invite
    case 'job_match': {
      const { jobPostingId, matchPct } = job.data
      const user = await prisma.user.findUnique({ where: { id: userId } })
      const jobPosting = await prisma.jobPosting.findUnique({ where: { id: jobPostingId } })
      if (!user || !jobPosting) return
      await emailService.sendJobMatchEmail(user, jobPosting, matchPct)
      break
    }

    // §6 — recruiter daily digest
    case 'recruiter_digest': {
      await handleRecruiterDigestEmail(job.data)
      break
    }

    // Part B — company verification outcome
    case 'company_status': {
      await handleCompanyStatusEmail(job.data)
      break
    }

    // Part F — recruiter message to candidate
    case 'recruiter_message': {
      await handleRecruiterMessageEmail(job.data)
      break
    }

    default:
      console.warn(`[EmailWorker] Unknown email type: ${type}`)
  }
})
})

async function handleApplicationStatusEmail({ applicationId, emailType, hoursLeft }) {
  const application = await prisma.application.findUnique({
    where: { id: applicationId },
    include: { user: true, jobPosting: true }
  })
  if (!application) return

  const { user, jobPosting } = application

  switch (emailType) {
    case 'application_received':
      await emailService.sendApplicationReceivedEmail(user, jobPosting)
      break

    case 'screening_rejected':
      await emailService.sendScreeningRejectionEmail(user, jobPosting, application.rejectionReason)
      break

    case 'shortlisted':
      await emailService.sendShortlistedEmail(user, jobPosting)
      break

    case 'assignment_sent':
      await emailService.sendAssignmentEmail(user, jobPosting, application.assignmentDeadlineAt)
      break

    case 'assignment_reminder':
      await emailService.sendAssignmentReminderEmail(user, jobPosting, hoursLeft)
      break

    case 'exam_unlocked': {
      const examLink = `${process.env.FRONTEND_URL}/applications/${application.id}/exam`
      await emailService.sendExamUnlockedEmail(user, jobPosting, examLink, application.examWindowExpiresAt)
      break
    }

    case 'exam_reminder':
      await emailService.sendExamReminderEmail(user, jobPosting, hoursLeft)
      break

    case 'selected':
      await emailService.sendSelectionEmail(user, jobPosting, application.rank, application.selectionNarrative)
      break

    case 'final_rejected':
      await emailService.sendRejectionEmail(user, jobPosting, application.rejectionReason)
      break

    default:
      console.warn(`[EmailWorker] Unknown application_status emailType: ${emailType}`)
  }
}

async function handleRecruiterDigestEmail({ jobPostingId }) {
  const jobPosting = await prisma.jobPosting.findUnique({
    where: { id: jobPostingId },
    include: { recruiter: true }
  })
  if (!jobPosting) return

  const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000)

  const [newApplicants, shortlisted, pendingReview, selected, rejected] = await Promise.all([
    prisma.application.count({ where: { jobPostingId, createdAt: { gte: oneDayAgo } } }),
    prisma.application.count({ where: { jobPostingId, stage: 'screened', status: 'in_progress' } }),
    prisma.application.count({ where: { jobPostingId, status: 'in_progress' } }),
    prisma.application.count({ where: { jobPostingId, status: 'selected' } }),
    prisma.application.count({ where: { jobPostingId, status: 'rejected' } })
  ])

  await emailService.sendRecruiterDigestEmail(jobPosting.recruiter, jobPosting, {
    newApplicants,
    shortlisted,
    pendingReview,
    selected,
    rejected,
    rejectedSummary: jobPosting.rankingSummary?.rejectedSummary || null
  })
}

async function handleCompanyStatusEmail({ companyId, emailType }) {
  const company = await prisma.company.findUnique({
    where: { id: companyId },
    include: { recruiter: true }
  })
  if (!company) return
  if (emailType === 'company_verified') {
    await emailService.sendCompanyVerifiedEmail(company.recruiter, company)
  } else if (emailType === 'company_rejected') {
    await emailService.sendCompanyRejectedEmail(company.recruiter, company)
  }
}

async function handleRecruiterMessageEmail({ applicationId, messageBody }) {
  const application = await prisma.application.findUnique({
    where: { id: applicationId },
    include: {
      user: true,
      jobPosting: { include: { company: true } }
    }
  })
  if (!application) return
  const companyName = application.jobPosting.company?.name || application.jobPosting.companyName
  const companyObj = { name: companyName }
  await emailService.sendRecruiterMessageEmail(application.user, companyObj, messageBody, applicationId)
}

console.log('✅ Email worker started')
