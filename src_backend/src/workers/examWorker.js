/**
 * examWorker.js — Bull queue consumer for exam grading.
 * Grading logic lives in examGradingService.js (no circular deps).
 */
const queues = require('../queues')
const { gradeAttempt } = require('../services/examGradingService')

// Wait for the real Bull queue (or confirmed stub) before attaching .process —
// registering against the initial stub silently no-ops forever.
queues.queuesReadyPromise.then(() => {
  queues.examGradingQueue.process(async (job) => {
    await gradeAttempt(job.data.attemptId)
  })
  console.log('✅ Exam grading worker started')
})