const { analyzeRepo } = require('./orchestrator')
const { stageRepo } = require('./repoStaging')
const { detectDomain } = require('./domainDetector')

/**
 * High-level convenience wrapper: stages the project's source (zip/github)
 * into a temp dir, runs the full static-analysis suite, and always cleans
 * up the staged copy — regardless of success or failure.
 *
 * Returns an empty-but-valid toolResults shape (all tools show as not run)
 * when there's nothing to analyze (e.g. liveUrl-only submissions) or when
 * staging fails, so callers never need to special-case "no toolResults".
 */
async function analyzeProject(project) {
  const staged = await stageRepo(project)
  if (!staged) {
    return {
      domain: { category: 'unknown', confidence: 0, detectionMethod: 'signal-file' },
      meta: { toolsRun: [], toolsFailed: [], filesScanned: 0, linesScanned: 0, scanDurationMs: 0 },
    }
  }

  try {
    return await analyzeRepo(staged.path)
  } finally {
    await staged.cleanup()
  }
}

module.exports = { analyzeRepo, analyzeProject, stageRepo, detectDomain }
