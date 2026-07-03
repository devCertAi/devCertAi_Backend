const queues = require('../queues')
const pipelineService = require('../services/pipelineService')
 
const CONCURRENCY = parseInt(process.env.APPLICATION_WORKER_CONCURRENCY || '5', 10)

queues.queuesReadyPromise.then(() => {
queues.applicationQueue.process(CONCURRENCY, async (job) => {
  const { applicationId, jobPostingId, action } = job.data
  console.log(`[ApplicationWorker] action=${action} application=${applicationId || '-'} posting=${jobPostingId || '-'}`)

 
  try {
    switch (action) {
      case 'stage1_screen':
        await pipelineService.runStage1Screening(applicationId)
        break

      case 'stage2_ai_match':
        await pipelineService.runStage2AIMatch(applicationId)
        break

      case 'rank_posting':
        await pipelineService.triggerRanking(jobPostingId)
        break

      default:
        console.warn(`[ApplicationWorker] Unknown action: ${action}`)
    }
  } catch (err) {
    console.error(`[ApplicationWorker] action=${action} application=${applicationId || '-'} posting=${jobPostingId || '-'} FAILED:`, err.message, err.stack)
   
    throw err
  }
})
console.log(`✅ Application pipeline worker started (concurrency=${CONCURRENCY})`)
})