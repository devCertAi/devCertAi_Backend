/**
 * sizeEstimator.js — Shared project-size -> credit-tier classification.
 *
 * Used by both:
 *  - POST /projects/estimate-size (shows the tier/cost to the user BEFORE submit)
 *  - submitProject (re-derives the same tier server-side at submit time, so
 *    the actual charge never trusts whatever the client displayed)
 *
 * Classification is based on the amount of "important" source code found
 * (file count + total bytes of code files), not the raw repo/zip size —
 * assets, lockfiles, and node_modules-style bulk shouldn't inflate the tier.
 */

const IMPORTANT_EXTENSIONS = ['.js', '.ts', '.jsx', '.tsx', '.py', '.java', '.go', '.rs', '.cpp', '.c', '.cs', '.php', '.rb', '.swift', '.kt']
const SKIP_DIRS = ['node_modules', '.git', 'dist', 'build', '.next', 'coverage', '__pycache__', 'vendor']

// Same cap the AI analyzers use (githubAnalyzer/zipAnalyzer MAX_TOTAL_CONTENT)
// — however much code exists, only this many characters actually get sent to
// the model, so the token estimate should reflect that ceiling.
const AI_CONTENT_CHAR_CAP = 15000
// Rough fixed overhead for the prompt scaffolding, tech-stack summary, and
// report-generation output tokens that aren't proportional to input size.
const FIXED_OVERHEAD_TOKENS = 800

const TIERS = [
  {
    tier: 'small',
    label: 'Small',
    description: 'Up to ~30 code files',
    maxCodeFiles: 30,
    maxCodeBytes: 150_000,
    creditsCost: 1,
  },
  {
    tier: 'medium',
    label: 'Medium',
    description: '30–100 code files',
    maxCodeFiles: 100,
    maxCodeBytes: 600_000,
    creditsCost: 2,
  },
  {
    tier: 'large',
    label: 'Large',
    description: 'Over 100 code files',
    maxCodeFiles: Infinity,
    maxCodeBytes: Infinity,
    creditsCost: 3,
  },
]

/**
 * @param {{ codeFileCount: number, codeBytes: number }} stats
 * @returns {{ tier: string, label: string, description: string, creditsCost: number }}
 */
function classifyBySize({ codeFileCount = 0, codeBytes = 0 } = {}) {
  for (const t of TIERS) {
    if (codeFileCount <= t.maxCodeFiles && codeBytes <= t.maxCodeBytes) {
      return { tier: t.tier, label: t.label, description: t.description, creditsCost: t.creditsCost }
    }
  }
  const last = TIERS[TIERS.length - 1]
  return { tier: last.tier, label: last.label, description: last.description, creditsCost: last.creditsCost }
}

function estimateTokensFromBytes(codeBytes = 0) {
  const sentChars = Math.min(codeBytes, AI_CONTENT_CHAR_CAP)
  return Math.round(sentChars / 4) + FIXED_OVERHEAD_TOKENS
}

// Fixed classification used when we genuinely can't inspect source (a live
// URL submitted with no GitHub/ZIP alongside it) — flat minimum tier rather
// than a guess.
const LIVE_URL_ONLY_TIER = {
  tier: 'small',
  label: 'Small',
  description: 'Flat rate — source code isn\u2019t visible for a live URL alone',
  creditsCost: 1,
}
const LIVE_URL_ONLY_TOKENS = FIXED_OVERHEAD_TOKENS + 400

module.exports = {
  IMPORTANT_EXTENSIONS,
  SKIP_DIRS,
  TIERS,
  classifyBySize,
  estimateTokensFromBytes,
  LIVE_URL_ONLY_TIER,
  LIVE_URL_ONLY_TOKENS,
}
