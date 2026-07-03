const queues = require('../queues')
const { defaultOpts } = queues
// const { evaluateProject } = require('../ai/evaluationEngine')
const { evaluateProject } = require('../ai/pythonPipelineClient')

const prisma = require('../config/database')
const notificationService = require('../services/notificationService')

queues.queuesReadyPromise.then(() => {
queues.projectEvalQueue.process(async (job) => {
  const { projectId } = job.data
  console.log(`[ProjectWorker] Processing project ${projectId}`)

  const project = await prisma.project.findUnique({
    where: { id: projectId },
    include: { user: { select: { id: true, name: true } } }
  })
  if (!project) throw new Error(`Project ${projectId} not found`)

  await prisma.project.update({ where: { id: projectId }, data: { status: 'evaluating' } })

  try {
    const report = await evaluateProject(project)

    const plagiarismScore =
      report.plagiarismRisk === 'high' ? 0.8
      : report.plagiarismRisk === 'medium' ? 0.4 : 0.1

    // FIX: do NOT update project.domain here. The pipeline may have changed
    // domain via its classifier, but we want the certificate and project listing
    // to show the domain the user selected at submission. Only score/level/report
    // come from AI.
    const updatedProject = await prisma.project.update({
      where: { id: projectId },
      data: {
        status: 'completed',
        score: report.overallScore,
        level: report.level,
        evaluationReport: report,
        plagiarismScore
      }
    })

    // FIX: emit real-time socket event so the frontend progress bar and
    // project detail page update immediately without a manual page refresh.
    try {
      const { getIO } = require('../socket')
      const io = getIO()
      if (io) {
        io.to(`user:${project.userId}`).emit('project:updated', {
          projectId,
          status: 'completed',
          score: report.overallScore,
          level: report.level
        })
      }
    } catch (_) {}

    // Queue certificate if score >= 40
    if (report.overallScore >= 40) {
      await queues.certificateGenQueue.add({
        type: 'project_eval',
        projectId,
        userId: project.userId
      }, defaultOpts)
    }

    // Notify user
    await notificationService.create(project.userId, {
      type: 'evaluation_complete',
      title: 'Project evaluation complete',
      message: `"${project.title}" scored ${report.overallScore}/100 (${report.level})`,
      data: { projectId, score: report.overallScore, level: report.level }
    })

    // Queue confirmation email
    await queues.emailQueue.add({
      type: 'evaluation_complete',
      userId: project.userId,
      projectId
    }, defaultOpts)

    // ------------------------------------------------------------------
    // Recruiter pipeline hook (additive) — if this project was submitted
    // as a pipeline assignment (Application.projectId === projectId),
    // advance that Application to the next stage (project_evaluated ->
    // exam_sent / ranked). No-op for normal (non-pipeline) projects.
    // ------------------------------------------------------------------
    try {
      const pipelineService = require('../services/pipelineService')
      await pipelineService.onProjectEvaluated(projectId)
    } catch (err) {
      console.error(`[ProjectWorker] Pipeline hook failed for project ${projectId}:`, err.message)
    }

    console.log(`[ProjectWorker] Completed project ${projectId}: ${report.overallScore}/100`)
  } catch (err) {
    await prisma.project.update({ where: { id: projectId }, data: { status: 'failed' } })
    console.error(`[ProjectWorker] Failed project ${projectId}:`, err.message)
    throw err
  }
})
console.log('✅ Project evaluation worker started')
})
