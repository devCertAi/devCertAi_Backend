const queues = require('../queues')
const pipelineService = require('../services/pipelineService')

// Horizontally scalable — concurrency configurable so 1000+ applications per
// posting can be processed in parallel without blocking the event loop.
const CONCURRENCY = parseInt(process.env.APPLICATION_WORKER_CONCURRENCY || '5', 10)

queues.queuesReadyPromise.then(() => {
queues.applicationQueue.process(CONCURRENCY, async (job) => {
  const { applicationId, jobPostingId, action } = job.data
  console.log(`[ApplicationWorker] action=${action} application=${applicationId || '-'} posting=${jobPostingId || '-'}`)

  switch (action) {
    case 'stage1_screen':
      await pipelineService.runStage1Screening(applicationId)
      break

    case 'stage2_ai_match':``
      await pipelineService.runStage2AIMatch(applicationId)
      break

    case 'rank_posting':
      await pipelineService.triggerRanking(jobPostingId)
      break

    default:
      console.warn(`[ApplicationWorker] Unknown action: ${action}`)
  }
})
console.log(`✅ Application pipeline worker started (concurrency=${CONCURRENCY})`)
})
