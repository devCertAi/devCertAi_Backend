/**
 * semgrepRunner.js
 * Multi-language security scan — runs regardless of domain.
 */

const path = require('path')
const { runSandboxed } = require('../sandboxExec')

const SEVERITY_MAP = { ERROR: 'high', WARNING: 'medium', INFO: 'low' }

async function run(repoPath) {
  try {
    const { code, stdout, stderr } = await runSandboxed(
      'proeva-tools/semgrep:latest',
      ['semgrep', '--config=auto', '/repo', '--json', '--timeout', '60'],
      repoPath,
      { timeoutMs: 65_000, writableTmp: false },
    )

    // Semgrep exits 1 when findings exist — not a failure.
    if (code !== 0 && code !== 1) {
      return { tool: 'semgrep', error: stderr?.slice(0, 500) || `semgrep exited with code ${code}`, findings: [] }
    }

    let parsed
    try {
      parsed = JSON.parse(stdout)
    } catch {
      return { tool: 'semgrep', error: 'Failed to parse semgrep JSON output', findings: [] }
    }

    const findings = (parsed.results || []).map((r) => ({
      file: path.relative('/repo', r.path || ''),
      line: r.start?.line || 0,
      ruleId: r.check_id || 'unknown',
      severity: SEVERITY_MAP[r.extra?.severity] || 'medium',
      message: r.extra?.message || '',
    }))

    // Trim to top 30 by severity (high > medium > low).
    const order = { high: 0, medium: 1, low: 2 }
    findings.sort((a, b) => order[a.severity] - order[b.severity])

    return { tool: 'semgrep', findings: findings.slice(0, 30) }
  } catch (err) {
    return { tool: 'semgrep', error: err.message, findings: [] }
  }
}

module.exports = { run }
