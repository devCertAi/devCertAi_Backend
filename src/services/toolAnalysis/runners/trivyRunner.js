/**
 * trivyRunner.js
 * Checks package.json / requirements.txt / pom.xml / go.mod dependency
 * vulnerabilities — always runs (language-agnostic).
 */

const { runSandboxed } = require('../sandboxExec')

async function run(repoPath) {
  try {
    const { code, stdout, stderr } = await runSandboxed(
      'proeva-tools/trivy:latest',
      ['trivy', 'fs', '/repo', '--format', 'json', '--scanners', 'vuln'],
      repoPath,
      { timeoutMs: 30_000, writableTmp: false },
    )

    if (code !== 0 && !stdout) {
      return { tool: 'trivy', error: stderr?.slice(0, 500) || `trivy exited with code ${code}`, vulnerabilities: [] }
    }

    let parsed
    try {
      parsed = JSON.parse(stdout)
    } catch {
      return { tool: 'trivy', error: 'Failed to parse trivy JSON output', vulnerabilities: [] }
    }

    const vulnerabilities = []
    for (const result of parsed.Results || []) {
      for (const vuln of result.Vulnerabilities || []) {
        vulnerabilities.push({
          package: vuln.PkgName,
          version: vuln.InstalledVersion,
          severity: (vuln.Severity || 'unknown').toLowerCase(),
          cve: vuln.VulnerabilityID,
        })
      }
    }

    const order = { critical: 0, high: 1, medium: 2, low: 3, unknown: 4 }
    vulnerabilities.sort((a, b) => (order[a.severity] ?? 4) - (order[b.severity] ?? 4))

    return { tool: 'trivy', vulnerabilities: vulnerabilities.slice(0, 30) }
  } catch (err) {
    return { tool: 'trivy', error: err.message, vulnerabilities: [] }
  }
}

module.exports = { run }
