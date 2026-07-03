const queues = require('../queues')
const { defaultOpts } = queues
const { createCertificate } = require('../services/certificateService')
const prisma = require('../config/database')
const notificationService = require('../services/notificationService')

queues.queuesReadyPromise.then(() => {
queues.certificateGenQueue.process(async (job) => {
  const { type, projectId, examAttemptId, userId } = job.data
  console.log(`[CertWorker] Generating ${type} certificate for user ${userId}`)

  const user = await prisma.user.findUnique({ where: { id: userId }, select: { name: true, id: true, email: true } })
  if (!user) throw new Error('User not found')

  let domain, level, score, projectTitle

  if (type === 'project_eval' && projectId) {
    const project = await prisma.project.findUnique({ where: { id: projectId } })
    if (!project) throw new Error('Project not found')
    // FIX: use the domain the user selected at submission time.
    // The AI pipeline may overwrite project.domain via its domain classifier
    // (pipeline.py patches domain when confidence >= 70). We want the certificate
    // to reflect the domain the user intentionally chose, not an AI re-label.
    // The user-submitted domain is preserved in evaluationReport.domainReport
    // only as metadata; project.domain may have been mutated by the worker.
    // To restore the original intent: use the domain stored at project creation
    // (before any AI patching). Since the worker does NOT update project.domain
    // itself — only pythonPipelineClient returns a potentially different domain —
    // the safest fix is to read evaluationReport.domainReport and fall back to
    // project.domain if not present.
    const evalReport = project.evaluationReport || {}
    const dr = evalReport.domainReport || {}
    // Be tolerant of different key naming/casing/confidence shapes the
    // Python pipeline might return for the detected domain.
    const aiDetectedDomain =
      dr.detectedDomain || dr.detected_domain ||
      dr.predictedDomain || dr.predicted_domain ||
      dr.domain || dr.label || dr.category || null

    console.log(`[CertWorker] domainReport for project ${projectId}:`, JSON.stringify(dr))
    console.log(`[CertWorker] aiDetectedDomain="${aiDetectedDomain}" userDomain="${project.domain}"`)

    domain = aiDetectedDomain || project.domain
    level = project.level
    score = project.score
    projectTitle = project.title

    // Check if cert already exists
    const existing = await prisma.certificate.findUnique({ where: { projectId } })
    if (existing) {
      console.log(`[CertWorker] Certificate already exists for project ${projectId}`)
      return
    }
  } else if (type === 'skill_cert' && examAttemptId) {
    const attempt = await prisma.examAttempt.findUnique({ where: { id: examAttemptId } })
    if (!attempt) throw new Error('Exam attempt not found')
    domain = attempt.domain
    level = attempt.level
    score = attempt.totalScore

    const existing = await prisma.certificate.findUnique({ where: { examAttemptId } })
    if (existing) {
      console.log(`[CertWorker] Certificate already exists for attempt ${examAttemptId}`)
      return
    }
  }

  const cert = await createCertificate({
    userId,
    type,
    domain,
    level,
    score,
    projectId: projectId || null,
    examAttemptId: examAttemptId || null,
    projectTitle: projectTitle || null,
    userName: user.name
  })

  await notificationService.create(userId, {
    type: 'certificate_ready',
    title: '🎓 Certificate Ready',
    message: `Your ${level} ${domain} certificate is ready to download`,
    data: { certificateId: cert.id, verificationId: cert.verificationId, downloadUrl: cert.certificateUrl }
  })

  await queues.emailQueue.add({ type: 'certificate_ready', userId, certificateId: cert.id }, defaultOpts)

  console.log(`[CertWorker] Certificate ${cert.id} generated`)
})
console.log('✅ Certificate generation worker started')
})