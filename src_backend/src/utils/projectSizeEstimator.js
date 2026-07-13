/**
 * projectSizeEstimator.js — Project size detector for token-based credit pricing
 *
 * WHY: The evaluation pipeline (devcert-pipeline) runs ~8 separate AI agent
 * calls per project (bug detector, architecture analyst, fast scorer,
 * plagiarism scanner, best-practices checker, improvement advisor, domain
 * classifier, report synthesizer) — see agents/agents.py. Each of those
 * calls is fed the SAME code context (file tree + sampled file contents),
 * so total AI token spend for a submission scales with how much of the
 * codebase gets pulled into that context, multiplied by the number of
 * agent passes. A 3-file toy app and a 300-file monorepo cost very
 * different amounts to evaluate — this maps that cost onto 3 simple credit
 * tiers so pricing stays predictable for users while still tracking real
 * spend.
 *
 * HOW IT WORKS:
 * 1. Look at the *whole* project (all matching code files, not just the
 *    ~15 files / 15,000 chars actually sampled into the AI prompt) to
 *    decide the tier — this reflects the real scope of the codebase being
 *    certified, not just what got truncated into a single prompt.
 * 2. Separately, compute an approximate token count for transparency —
 *    this uses the same content cap the analyzers actually apply
 *    (MAX_TOTAL_CONTENT), multiplied across the pipeline's AI passes.
 *
 * Tier thresholds and credit costs are intentionally simple constants so
 * they're easy to tune later without touching call sites.
 */

const AGENT_PASSES = 8            // number of AI calls in the eval pipeline (agents.py)
const CHARS_PER_TOKEN = 4         // rough English/code average
const MAX_SAMPLED_CONTENT = 15000 // mirrors githubAnalyzer/zipAnalyzer MAX_TOTAL_CONTENT
const AVG_PATH_CHARS = 45         // rough average length of a file-tree path entry

const TIERS = {
  small: {
    key: 'small',
    label: 'Small',
    description: 'A focused project — a handful of files or a small app.',
    credits: 1,
    maxCodeFiles: 15,
    maxCodeBytes: 150 * 1024, // 150 KB
  },
  medium: {
    key: 'medium',
    label: 'Medium',
    description: 'A fully-featured app with multiple modules.',
    credits: 2,
    maxCodeFiles: 60,
    maxCodeBytes: 600 * 1024, // 600 KB
  },
  large: {
    key: 'large',
    label: 'Large',
    description: 'A large or multi-service codebase — deepest analysis.',
    credits: 3,
    maxCodeFiles: Infinity,
    maxCodeBytes: Infinity,
  },
}

const TIER_ORDER = [TIERS.small, TIERS.medium, TIERS.large]

/**
 * Pick a tier from raw project stats. A project only qualifies for a tier
 * if it's within BOTH that tier's file-count and byte-size ceilings —
 * otherwise it rolls up to the next tier. This means a project with very
 * many small files (e.g. a huge monorepo of tiny configs) is still priced
 * as Medium/Large, not Small, since agent passes scale with file count too.
 */
function pickTier({ codeFileCount = 0, totalCodeBytes = 0 } = {}) {
  for (const tier of TIER_ORDER) {
    if (codeFileCount <= tier.maxCodeFiles && totalCodeBytes <= tier.maxCodeBytes) {
      return tier
    }
  }
  return TIERS.large
}

/**
 * Approximate total AI token spend across the whole evaluation pipeline,
 * for display purposes. Content actually sent to each agent call is capped
 * at MAX_SAMPLED_CONTENT chars (same cap the analyzers enforce), so this
 * grows with project size up to that cap and then flattens — the credit
 * TIER (above) is what should drive pricing, this number is just so users
 * can see roughly what an evaluation costs in tokens.
 */
function estimateTokens({ totalCodeBytes = 0, totalFiles = 0 } = {}) {
  const sampledContentChars = Math.min(totalCodeBytes, MAX_SAMPLED_CONTENT)
  const fileTreeChars = Math.min(totalFiles, 100) * AVG_PATH_CHARS
  const perCallTokens = Math.ceil((sampledContentChars + fileTreeChars) / CHARS_PER_TOKEN)
  return perCallTokens * AGENT_PASSES
}

/**
 * Build the full estimate object returned by both the pre-submit
 * /estimate-size endpoint and submitProject itself.
 */
function buildEstimate(stats) {
  const tier = pickTier(stats)
  const estimatedTokens = estimateTokens(stats)

  return {
    tier: tier.key,
    label: tier.label,
    description: tier.description,
    creditsCost: tier.credits,
    estimatedTokens,
    stats: {
      totalFiles: stats.totalFiles || 0,
      codeFileCount: stats.codeFileCount || 0,
      totalCodeBytes: stats.totalCodeBytes || 0,
    },
  }
}

// Fixed, minimal estimate for live-URL-only submissions — there's no source
// code to analyze, so this is always the cheapest tier.
function liveUrlOnlyEstimate() {
  return buildEstimate({ totalFiles: 0, codeFileCount: 0, totalCodeBytes: 0 })
}

/**
 * Main entry point. Exactly one of githubUrl / zipBuffer / liveUrl should
 * be provided (mirrors the submission methods in Submit.tsx). Never trust
 * a tier/cost sent by the client — this always re-derives it server-side
 * from the actual source.
 */
async function estimateProjectSize({ githubUrl, zipBuffer, liveUrl } = {}) {
  if (githubUrl) {
    const { getRepoSizeStats } = require('../ai/githubAnalyzer')
    const stats = await getRepoSizeStats(githubUrl)
    return buildEstimate(stats)
  }

  if (zipBuffer) {
    const { getZipSizeStats } = require('../ai/zipAnalyzer')
    const stats = getZipSizeStats(zipBuffer)
    return buildEstimate(stats)
  }

  if (liveUrl) {
    return liveUrlOnlyEstimate()
  }

  throw new Error('estimateProjectSize requires a githubUrl, zipBuffer, or liveUrl')
}

module.exports = {
  estimateProjectSize,
  pickTier,
  estimateTokens,
  TIERS,
}
