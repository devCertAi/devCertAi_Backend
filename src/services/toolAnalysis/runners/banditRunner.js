/**
 * banditRunner.js
 * Python-specific security scanner — complements semgrep (which uses
 * generic multi-language rules) with Bandit's AST-level Python checks:
 * hardcoded passwords/keys, `eval`/`exec`/`pickle` usage, weak hashes
 * (md5/sha1 for security use), shell=True injection risk, insecure
 * SSL/TLS config, assert-based auth checks stripped in optimized builds.
 * Free (Apache-2.0). Runs only for Python-based domains.
 */

const path = require('path')
const { runSandboxed } = require('../sandboxExec')
const { PY_DOMAINS } = require('./ruffRunner')

const SEVERITY_MAP = { HIGH: 'high', MEDIUM: 'medium', LOW: 'low' }

async function run(repoPath, { domain } = {}) {
  if (domain && !PY_DOMAINS.has(domain)) {
    return { tool: 'bandit', skipped: true, reason: `domain ${domain} is not Python-based` }
  }

  try {
    const { code, stdout, stderr } = await runSandboxed(
      'proeva-tools/bandit:latest',
      ['bandit', '-r', '.', '-f', 'json', '-q'],
      repoPath,
      { timeoutMs: 25_000, writableTmp: false },
    )

    // Bandit exits 1 when it finds issues — expected, not a failure.
    if (code !== 0 && code !== 1) {
      return { tool: 'bandit', error: stderr?.slice(0, 500) || `bandit exited with code ${code}`, findings: [] }
    }

    let parsed
    try {
      parsed = JSON.parse(stdout)
    } catch {
      return { tool: 'bandit', error: 'Failed to parse bandit JSON output', findings: [] }
    }

    const findings = (parsed.results || []).map((r) => ({
      file: path.relative('/repo', r.filename || ''),
      line: r.line_number || 0,
      ruleId: r.test_id || 'unknown',
      severity: SEVERITY_MAP[r.issue_severity] || 'medium',
      message: r.issue_text || '',
    }))

    const order = { high: 0, medium: 1, low: 2 }
    findings.sort((a, b) => order[a.severity] - order[b.severity])

    return { tool: 'bandit', findings: findings.slice(0, 30) }
  } catch (err) {
    return { tool: 'bandit', error: err.message, findings: [] }
  }
}

module.exports = { run }
