const queues = require('../queues')
const { defaultOpts } = queues
const { createCertificate } = require('../services/certificateService')
const prisma = require('../config/database')
const notificationService = require('../services/notificationService')
const { calculateLevel } = require('../utils/scoreUtils')

queues.queuesReadyPromise.then(() => {
queues.certificateGenQueue.process(async (job) => {
  const { type, projectId, examAttemptId, userId, domain: jobDomain, phase1AttemptId, phase2AttemptId } = job.data
  console.log(`[CertWorker] Generating ${type} certificate for user ${userId}`)

  const user = await prisma.user.findUnique({ where: { id: userId }, select: { name: true, id: true, email: true } })
  if (!user) throw new Error('User not found')

  let domain, level, score, projectTitle, difficulty, metadata

  if (type === 'project_eval' && projectId) {
    const project = await prisma.project.findUnique({ where: { id: projectId } })
    if (!project) throw new Error('Project not found')
 
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
    // `difficulty` is the tier the candidate CHOSE at start (easy/medium/hard);
    // older attempts created before this column existed fall back to `level`,
    // which held the chosen difficulty pre-grading in that schema version.
    difficulty = attempt.difficulty || null

    const existing = await prisma.certificate.findUnique({ where: { examAttemptId } })
    if (existing) {
      console.log(`[CertWorker] Certificate already exists for attempt ${examAttemptId}`)
      return
    }
  } else if (type === 'combo_cert' && phase1AttemptId && phase2AttemptId) {
     
    const existing = await prisma.certificate.findFirst({
      where: { userId, type: 'combo_cert', domain: jobDomain }
    })
    if (existing) {
      console.log(`[CertWorker] Combo certificate already exists for user ${userId} domain ${jobDomain}`)
      return
    }

    const [p1, p2] = await Promise.all([
      prisma.examAttempt.findUnique({ where: { id: phase1AttemptId } }),
      prisma.examAttempt.findUnique({ where: { id: phase2AttemptId } })
    ])
    if (!p1 || !p2) throw new Error('Combo cert: one or both phase attempts not found')

    domain = jobDomain
    score = Math.round(((p1.totalScore || 0) + (p2.totalScore || 0)) / 2)
    level = calculateLevel(score)
    metadata = {
      phase1AttemptId,
      phase2AttemptId,
      phase1Score: p1.totalScore,
      phase2Score: p2.totalScore
    }
  }

  const cert = await createCertificate({
    userId,
    type,
    domain,
    level,
    score,
    difficulty,
    metadata,
    projectId: projectId || null,
    examAttemptId: examAttemptId || null,
    projectTitle: projectTitle || null,
    userName: user.name
  })

 
  if (type === 'project_eval' && projectId) {
    try {
      const { getIO } = require('../socket')
      const io = getIO()
      if (io) {
        io.to(`user:${userId}`).emit('project:updated', {
          projectId,
          status: 'completed',
          score,
          level,
          certificateReady: true
        })
      }
    } catch (_) {}
  }

  const message = type === 'combo_cert'
    ? `You passed both Phase 1 & Phase 2 in ${domain} — your combined ${level} certificate is ready`
    : `Your ${level} ${domain} certificate is ready to download`

  await notificationService.create(userId, {
    type: 'certificate_ready',
    title: '🎓 Certificate Ready',
    message,
    data: { certificateId: cert.id, verificationId: cert.verificationId, downloadUrl: cert.certificateUrl }
  })

  await queues.emailQueue.add({ type: 'certificate_ready', userId, certificateId: cert.id }, defaultOpts)

  console.log(`[CertWorker] Certificate ${cert.id} generated`)
})
console.log('✅ Certificate generation worker started')
})