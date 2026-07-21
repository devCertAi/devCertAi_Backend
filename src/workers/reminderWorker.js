/**
 * workers/reminderWorker.js — Pipeline reminder worker (node-cron, no Bull)
 *
 * WHY node-cron instead of Bull repeatable jobs:
 *  - Bull repeatable jobs call Redis `zadd` on every server boot to register
 *    the repeat schedule. On Upstash free tier this burns quota and can
 *    crash the server when the limit is hit.
 *  - node-cron runs entirely in-process using setTimeout — zero Redis calls.
 *  - The actual work (DB queries + email) is pure Prisma, so it works
 *    perfectly even when Redis is completely unavailable.
 *
 * Schedule: every 30 minutes (same as before).
 */

const cron = require('node-cron')
const prisma = require('../config/database')
const queues = require('../queues')
const { defaultOpts } = queues
const { processDeadlineApplications } = require('../services/pipelineService')

// ── helpers ──────────────────────────────────────────────────────────────────

async function sendAssignmentReminders(now) {
  const candidates = await prisma.application.findMany({
    where: {
      stage: 'assignment_sent',
      status: 'in_progress',
      assignmentDeadlineAt: { gt: now },
      assignmentRemindersSent: { lt: 2 },
    },
    select: { id: true, assignmentDeadlineAt: true, assignmentRemindersSent: true },
  })

  for (const app of candidates) {
    const hoursLeft = (app.assignmentDeadlineAt.getTime() - now.getTime()) / (60 * 60 * 1000)

    let shouldSend = false
    if (app.assignmentRemindersSent === 0 && hoursLeft <= 24) shouldSend = true
    else if (app.assignmentRemindersSent === 1 && hoursLeft <= 2) shouldSend = true

    if (!shouldSend) continue

    // emailQueue.add is a no-op stub when Redis is down — it logs and returns
    await queues.emailQueue.add(
      { type: 'application_status', applicationId: app.id, emailType: 'assignment_reminder', hoursLeft: Math.max(0, Math.round(hoursLeft)) },
      defaultOpts
    )

    await prisma.application.update({
      where: { id: app.id },
      data: { assignmentRemindersSent: { increment: 1 } },
    })
  }
}

async function sendExamReminders(now) {
  const candidates = await prisma.application.findMany({
    where: {
      stage: 'exam_sent',
      status: 'in_progress',
      examWindowExpiresAt: { gt: now },
      examRemindersSent: { lt: 2 },
    },
    select: { id: true, examWindowExpiresAt: true, examRemindersSent: true },
  })

  for (const app of candidates) {
    const hoursLeft = (app.examWindowExpiresAt.getTime() - now.getTime()) / (60 * 60 * 1000)

    let shouldSend = false
    if (app.examRemindersSent === 0 && hoursLeft <= 24) shouldSend = true
    else if (app.examRemindersSent === 1 && hoursLeft <= 2) shouldSend = true

    if (!shouldSend) continue

    await queues.emailQueue.add(
      { type: 'application_status', applicationId: app.id, emailType: 'exam_reminder', hoursLeft: Math.max(0, Math.round(hoursLeft)) },
      defaultOpts
    )

    await prisma.application.update({
      where: { id: app.id },
      data: { examRemindersSent: { increment: 1 } },
    })
  }
}

async function autoRejectExpired(now) {
  const expired = await prisma.application.findMany({
    where: {
      status: 'in_progress',
      OR: [
        { stage: 'assignment_sent', assignmentDeadlineAt: { lte: now } },
        { stage: 'exam_sent',       examWindowExpiresAt: { lte: now } },
      ],
    },
    select: { id: true, stage: true },
  })

  for (const app of expired) {
    const reason =
      app.stage === 'assignment_sent'
        ? 'Assignment deadline missed'
        : 'Exam window expired without starting/completing the assessment'

    await prisma.application.update({
      where: { id: app.id },
      data: { status: 'rejected', rejectionReason: reason },
    })

    await queues.emailQueue.add(
      { type: 'application_status', applicationId: app.id, emailType: 'final_rejected' },
      defaultOpts
    )
  }
}

// ── retry stuck pipeline applications ───────────────────────────────────────

async function retryStuckPipelineApplications() {
  // Applications stuck at 'screened' with a pipelineError — retry by
  // re-enqueuing stage1 which will re-trigger advanceAfterScreening.
  const stuck = await prisma.application.findMany({
    where: {
      stage: 'screened',
      status: 'in_progress',
      pipelineError: { not: null },
      examAttemptId: null,
    },
    select: { id: true, pipelineError: true },
    take: 10,
  })

  for (const app of stuck) {
    console.log(`[reminderWorker] Retrying stuck application ${app.id} (was: ${app.pipelineError})`)
    // Clear the error before retrying
    await prisma.application.update({
      where: { id: app.id },
      data: { pipelineError: null },
    })
    // Clear cached question bank on the posting so ensureQuestionBank re-queries
    const full = await prisma.application.findUnique({
      where: { id: app.id },
      select: { jobPostingId: true },
    })
    if (full) {
      await prisma.jobPosting.update({
        where: { id: full.jobPostingId },
        data: { questionBank: [] },
      })
    }
    await queues.applicationQueue.add(
      { applicationId: app.id, action: 'stage1_screen' },
      defaultOpts
    )
  }
}

// ── main task ────────────────────────────────────────────────────────────────

async function runPipelineReminders() {
  const now = new Date()
  try {
    await processDeadlineApplications()
    await retryStuckPipelineApplications()
    await sendAssignmentReminders(now)
    await sendExamReminders(now)
    await autoRejectExpired(now)
  } catch (err) {
    // Never crash the process — log and wait for next tick
    console.error('[reminderWorker] Error during run:', err.message)
  }
}

// Every 30 minutes — '*/30 * * * *'
// Zero Redis calls. Works with or without Redis.
cron.schedule('*/30 * * * *', runPipelineReminders)

console.log('✅ Pipeline reminder worker started (node-cron, Redis-free)')