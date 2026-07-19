/**
 * ruffRunner.js
 * Runs only when the detected domain is backend-python or ml-ai.
 */

const path = require('path')
const { runSandboxed } = require('../sandboxExec')

const PY_DOMAINS = new Set(['backend-python', 'ml-ai'])

async function run(repoPath, { domain } = {}) {
  if (domain && !PY_DOMAINS.has(domain)) {
    return { tool: 'ruff', skipped: true, reason: `domain ${domain} is not Python-based` }
  }

  try {
    const { code, stdout, stderr } = await runSandboxed(
      'proeva-tools/ruff:latest',
      ['ruff', 'check', '.', '--output-format', 'json'],
      repoPath,
      { timeoutMs: 20_000, writableTmp: false },
    )

    // ruff exits 1 when it finds issues — that's expected, not a failure.
    if (code !== 0 && code !== 1) {
      return { tool: 'ruff', error: stderr?.slice(0, 500) || `ruff exited with code ${code}`, errorCount: 0, warningCount: 0, issues: [] }
    }

    let results
    try {
      results = JSON.parse(stdout)
    } catch {
      return { tool: 'ruff', error: 'Failed to parse ruff JSON output', errorCount: 0, warningCount: 0, issues: [] }
    }

    let errorCount = 0
    const issues = []
    for (const item of results) {
      errorCount++
      issues.push({
        file: path.relative('/repo', item.filename || ''),
        line: item.location?.row || 0,
        rule: item.code || 'unknown',
        message: item.message,
        severity: 'error',
      })
    }

    return { tool: 'ruff', errorCount, warningCount: 0, issues: issues.slice(0, 30) }
  } catch (err) {
    return { tool: 'ruff', error: err.message, errorCount: 0, warningCount: 0, issues: [] }
  }
}

module.exports = { run, PY_DOMAINS }
