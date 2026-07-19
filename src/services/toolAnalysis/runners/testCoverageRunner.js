/**
 * testCoverageRunner.js
 * Detects a test script (package.json / pytest) and tries to run it with a
 * hard 30s timeout. If it fails, times out, or nothing is detected, this
 * ALWAYS resolves to { hasTests: false } rather than throwing — a flaky or
 * slow test suite must never block the rest of the analysis pipeline.
 */

const fs = require('fs')
const path = require('path')
const { runSandboxed } = require('../sandboxExec')

const HARD_TIMEOUT_MS = 30_000

function readJsonSafe(repoPath, rel) {
  try {
    return JSON.parse(fs.readFileSync(path.join(repoPath, rel), 'utf-8'))
  } catch {
    return null
  }
}

function detectRunner(repoPath) {
  const pkg = readJsonSafe(repoPath, 'package.json')
  if (pkg?.scripts?.test && !/no test specified/i.test(pkg.scripts.test)) {
    return { kind: 'npm', hasCoverageScript: !!pkg.scripts['test:coverage'] || !!pkg.scripts.coverage }
  }
  if (fs.existsSync(path.join(repoPath, 'pytest.ini')) ||
      fs.existsSync(path.join(repoPath, 'setup.cfg')) ||
      (readJsonSafe(repoPath, 'pyproject.toml') !== null) ||
      hasPyTestFiles(repoPath)) {
    return { kind: 'pytest' }
  }
  return null
}

function hasPyTestFiles(repoPath) {
  try {
    return fs.readdirSync(repoPath).some((f) => f.startsWith('test_') || f === 'tests')
  } catch {
    return false
  }
}

function extractCoveragePercent(output) {
  // Matches common coverage summary formats:
  //   "All files      |   82.35 |" (istanbul/nyc)
  //   "TOTAL ... 82%" (pytest-cov)
  const nyc = output.match(/All files\s*\|\s*([\d.]+)/)
  if (nyc) return Number(nyc[1])
  const pytestCov = output.match(/TOTAL.*?(\d+)%/s)
  if (pytestCov) return Number(pytestCov[1])
  return null
}

async function run(repoPath) {
  try {
    const runner = detectRunner(repoPath)
    if (!runner) return { hasTests: false, coveragePercent: null }

    const command = runner.kind === 'npm'
      ? ['npm', 'test', '--', '--ci']
      : ['pytest', '--cov', '-q']

    const { stdout, stderr } = await runSandboxed(
      runner.kind === 'npm' ? 'proeva-tools/node-test:latest' : 'proeva-tools/python-test:latest',
      command,
      repoPath,
      { timeoutMs: HARD_TIMEOUT_MS, network: 'none' },
    )

    const coveragePercent = extractCoveragePercent(`${stdout}\n${stderr}`)
    return { hasTests: true, coveragePercent }
  } catch {
    // Timeout, missing runtime, non-zero exit, anything — never block the pipeline.
    return { hasTests: false, coveragePercent: null }
  }
}

module.exports = { run }
