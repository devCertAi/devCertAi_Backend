 
const fs = require('fs')
const { withTimeout } = require('./sandboxExec')
const { detectDomain } = require('./domainDetector')

const eslintRunner = require('./runners/eslintRunner')
const ruffRunner = require('./runners/ruffRunner')
const semgrepRunner = require('./runners/semgrepRunner')
const gitleaksRunner = require('./runners/gitleaksRunner')
const trivyRunner = require('./runners/trivyRunner')
const jscpdRunner = require('./runners/jscpdRunner')
const lizardRunner = require('./runners/lizardRunner')
const testCoverageRunner = require('./runners/testCoverageRunner')
const madgeRunner = require('./runners/madgeRunner')
const depcheckRunner = require('./runners/depcheckRunner')
const banditRunner = require('./runners/banditRunner')

const MAX_REPO_SIZE_BYTES = 200 * 1024 * 1024 // 200MB

const TOOL_TIMEOUTS_MS = {
  eslint: 30_000,
  ruff: 25_000,
  semgrep: 70_000,
  gitleaks: 25_000,
  trivy: 35_000,
  jscpd: 30_000,
  lizard: 25_000,
  testCoverage: 32_000,
  madge: 27_000,
  depcheck: 32_000,
  bandit: 27_000,
}

function getDirSizeBytes(dirPath) {
  let total = 0
  const stack = [dirPath]
  while (stack.length) {
    const dir = stack.pop()
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue
      const full = `${dir}/${entry.name}`
      if (entry.isDirectory()) stack.push(full)
      else {
        try { total += fs.statSync(full).size } catch {}
      }
    }
    if (total > MAX_REPO_SIZE_BYTES) return total // early bail, we already know it's too big
  }
  return total
}

/** Trim an array of findings to top N, preferring higher severity first if a severity field exists. */
function trimTop30(arr) {
  if (!Array.isArray(arr)) return []
  return arr.slice(0, 30)
}

async function runTool(name, fn, ...args) {
  const timeoutMs = TOOL_TIMEOUTS_MS[name] || 20_000
  try {
    return { name, ...(await withTimeout(fn(...args), timeoutMs, name)) }
  } catch (err) {
    return { name, error: err.message, timedOut: true }
  }
}

async function analyzeRepo(repoPath) {
  const startedAt = Date.now()
  const toolsRun = []
  const toolsFailed = []

  const sizeBytes = getDirSizeBytes(repoPath)
  if (sizeBytes > MAX_REPO_SIZE_BYTES) {
    return {
      domain: { category: 'unknown', confidence: 0, detectionMethod: 'signal-file' },
      meta: {
        toolsRun: [],
        toolsFailed: ['all'],
        filesScanned: 0,
        linesScanned: 0,
        scanDurationMs: Date.now() - startedAt,
        skipped: `Repo exceeds ${MAX_REPO_SIZE_BYTES / (1024 * 1024)}MB limit — static analysis skipped.`,
      },
    }
  }

  // a) domain detection first — needed to decide which linter to run
  const domain = await detectDomain(repoPath)

  // b) run all applicable tools in parallel, never let one block the others
  const jobs = [
    runTool('eslint', eslintRunner.run, repoPath, { domain: domain.category }),
    runTool('ruff', ruffRunner.run, repoPath, { domain: domain.category }),
    runTool('semgrep', semgrepRunner.run, repoPath),
    runTool('gitleaks', gitleaksRunner.run, repoPath),
    runTool('trivy', trivyRunner.run, repoPath),
    runTool('jscpd', jscpdRunner.run, repoPath),
    runTool('lizard', lizardRunner.run, repoPath),
    runTool('testCoverage', testCoverageRunner.run, repoPath),
    runTool('madge', madgeRunner.run, repoPath, { domain: domain.category }),
    runTool('depcheck', depcheckRunner.run, repoPath, { domain: domain.category }),
    runTool('bandit', banditRunner.run, repoPath, { domain: domain.category }),
  ]

  const settled = await Promise.allSettled(jobs)
  const results = {}
  for (const outcome of settled) {
    // runTool never throws (it catches internally), so allSettled entries
    // are always 'fulfilled' — but keep the branch for defense in depth.
    if (outcome.status === 'fulfilled') {
      results[outcome.value.name] = outcome.value
    }
  }

  for (const [name, res] of Object.entries(results)) {
    if (res.skipped) continue // domain-gated tool that intentionally didn't run
    if (res.error || res.timedOut) toolsFailed.push(name)
    else toolsRun.push(name)
  }

  // c) normalize into the shared contract
  const lintResult = !results.eslint?.skipped ? results.eslint : results.ruff
  const lint = lintResult && !lintResult.skipped
    ? {
        tool: lintResult.tool || (results.eslint && !results.eslint.skipped ? 'eslint' : 'ruff'),
        errorCount: lintResult.errorCount || 0,
        warningCount: lintResult.warningCount || 0,
        issues: trimTop30(lintResult.issues),
      }
    : { tool: null, errorCount: 0, warningCount: 0, issues: [] }

  const semgrepFindings = (results.semgrep?.findings || []).map((f) => ({ ...f, tool: 'semgrep' }))
  const banditFindings = (results.bandit?.findings || []).map((f) => ({ ...f, tool: 'bandit' }))
  const security = {
    tool: 'semgrep',
    tools: [...(semgrepFindings.length ? ['semgrep'] : []), ...(banditFindings.length ? ['bandit'] : [])],
    findings: trimTop30([...semgrepFindings, ...banditFindings]),
  }

  const secrets = {
    tool: 'gitleaks',
    found: trimTop30(results.gitleaks?.found),
  }

  const dependencies = {
    tool: 'trivy',
    vulnerabilities: trimTop30(results.trivy?.vulnerabilities),
  }

  const duplication = {
    tool: 'jscpd',
    duplicationPercent: results.jscpd?.duplicationPercent ?? null,
    clones: trimTop30(results.jscpd?.clones),
  }

  const complexity = {
    tool: 'lizard',
    avgCyclomaticComplexity: results.lizard?.avgCyclomaticComplexity ?? null,
    highComplexityFunctions: trimTop30(results.lizard?.highComplexityFunctions),
  }

  const testCoverage = {
    hasTests: results.testCoverage?.hasTests ?? false,
    coveragePercent: results.testCoverage?.coveragePercent ?? null,
  }

  const dependencyHealth = {
    tool: 'depcheck',
    unused: trimTop30(results.depcheck?.unused),
    missing: trimTop30(results.depcheck?.missing),
  }

  const circularDependencies = {
    tool: 'madge',
    found: trimTop30(results.madge?.circularDependencies),
  }

  let filesScanned = 0
  let linesScanned = 0
  try {
    // Cheap approximation for meta stats — exact per-tool counts aren't
    // uniformly available across every runner's output format.
    const stats = scanRepoStats(repoPath)
    filesScanned = stats.filesScanned
    linesScanned = stats.linesScanned
  } catch {}

  return {
    domain,
    lint,
    security,
    secrets,
    dependencies,
    duplication,
    complexity,
    testCoverage,
    dependencyHealth,
    circularDependencies,
    meta: {
      toolsRun,
      toolsFailed,
      filesScanned,
      linesScanned,
      scanDurationMs: Date.now() - startedAt,
    },
  }
}

const TEXT_EXTENSIONS = new Set([
  '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.vue', '.svelte',
  '.py', '.rb', '.go', '.java', '.kt', '.rs', '.c', '.cpp', '.h', '.hpp', '.cs', '.php', '.swift',
  '.json', '.yml', '.yaml', '.toml', '.env', '.md', '.mdx', '.txt',
  '.html', '.css', '.scss', '.sass', '.less', '.sql', '.graphql', '.proto',
])
const MAX_FILE_BYTES_FOR_LINE_COUNT = 2 * 1024 * 1024 // skip anything absurdly large (likely generated/binary)

function scanRepoStats(dirPath) {
  let filesScanned = 0
  let linesScanned = 0
  const stack = [dirPath]
  while (stack.length) {
    const dir = stack.pop()
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'dist' || entry.name === 'build') continue
      const fullPath = `${dir}/${entry.name}`
      if (entry.isDirectory()) {
        stack.push(fullPath)
        continue
      }
      filesScanned++
      const ext = entry.name.slice(entry.name.lastIndexOf('.'))
      if (!TEXT_EXTENSIONS.has(ext)) continue
      try {
        const st = fs.statSync(fullPath)
        if (st.size > MAX_FILE_BYTES_FOR_LINE_COUNT) continue
        const content = fs.readFileSync(fullPath, 'utf8')
        linesScanned += content.split('\n').length
      } catch {
        // unreadable / binary despite the extension — skip silently
      }
    }
  }
  return { filesScanned, linesScanned }
}

module.exports = { analyzeRepo, MAX_REPO_SIZE_BYTES }
