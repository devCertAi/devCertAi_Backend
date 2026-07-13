const queues = require('../queues')
const { defaultOpts } = queues
// const { evaluateProject } = require('../ai/evaluationEngine')
const { evaluateProject } = require('../ai/pythonPipelineClient')

const prisma = require('../config/database')
const notificationService = require('../services/notificationService')
const creditService = require('../services/creditService')

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
    // Bull retries failed jobs (defaultOpts.attempts = 3, exponential
    // backoff). Only treat this as a FINAL failure — and only then refund
    // the credit / notify / email the user — once the last attempt has
    // been exhausted. Otherwise every one of the 2 earlier failures would
    // also refund + notify, and the project would flash "failed" in the UI
    // moments before a retry quietly succeeds. In-process fallback jobs
    // (no Redis) have no `opts`/`attemptsMade`, so they default to a single,
    // final attempt.
    const maxAttempts = job.opts?.attempts || 1
    const attemptsMade = (job.attemptsMade || 0) + 1
    const isFinalAttempt = attemptsMade >= maxAttempts

    console.error(`[ProjectWorker] Attempt ${attemptsMade}/${maxAttempts} failed for project ${projectId}:`, err.message)

    if (!isFinalAttempt) {
      // Leave status as 'evaluating' — a false "failed" state shouldn't
      // flash on screen right before a retry runs. Let Bull retry.
      throw err
    }

    await prisma.project.update({ where: { id: projectId }, data: { status: 'failed' } })

    // FIX: a failed evaluation is a pipeline/infra problem, not something
    // the user should pay for — refund the credit that was charged at
    // submission time (see submitProject -> job.data.creditDebit). Free
    // re-evaluations (POST /:id/re-evaluate) never charge a credit in the
    // first place, so job.data.creditDebit will simply be undefined then
    // and this is skipped.
    if (job.data.creditDebit) {
      try {
        await creditService.refundCredit(
          project.userId,
          'project',
          { projectId, reason: 'evaluation_failed' },
          job.data.creditDebit
        )
      } catch (refundErr) {
        console.error(`[ProjectWorker] Credit refund failed for project ${projectId}:`, refundErr.message)
      }
    }

    // FIX: failures used to be completely silent — no notification, no
    // email, nothing telling the user their evaluation didn't go through
    // (or that they got their credit back). Mirror the success path.
    try {
      await notificationService.create(project.userId, {
        type: 'evaluation_failed',
        title: 'Project evaluation failed',
        message: job.data.creditDebit
          ? `We couldn't evaluate "${project.title}". Your credit has been refunded — you can re-evaluate from the project page.`
          : `We couldn't evaluate "${project.title}" again. You can retry re-evaluating from the project page.`,
        data: { projectId }
      })
    } catch (notifyErr) {
      console.error(`[ProjectWorker] Failure notification failed for project ${projectId}:`, notifyErr.message)
    }

    try {
      await queues.emailQueue.add({ type: 'evaluation_failed', userId: project.userId, projectId }, defaultOpts)
    } catch (_) {}

    // Real-time UI update — mirrors the success path's socket emit so the
    // project detail/list pages flip to "failed" (and show the
    // Re-evaluate button) immediately instead of needing a manual refresh.
    try {
      const { getIO } = require('../socket')
      const io = getIO()
      if (io) {
        io.to(`user:${project.userId}`).emit('project:updated', {
          projectId,
          status: 'failed'
        })
      }
    } catch (_) {}

    throw err
  }
})
console.log('✅ Project evaluation worker started')
})
