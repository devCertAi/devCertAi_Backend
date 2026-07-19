/**
 * gitleaksRunner.js
 * Secrets are language-agnostic — always runs.
 */

const fs = require('fs')
const os = require('os')
const path = require('path')
const { runSandboxed, runNative, isDockerAvailable } = require('../sandboxExec')

async function run(repoPath) {
  const reportDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitleaks-'))
  const reportPath = path.join(reportDir, 'report.json')

  try {
    const dockerReady = await isDockerAvailable()

    if (dockerReady) {
      // Mount a host scratch dir (not the anonymous docker volume the
      // generic sandbox helper uses) so we can read the report back out.
      const args = [
        'run', '--rm',
        '--network', 'none',
        '--memory', '512m',
        '--cpus', '1',
        '--pids-limit', '256',
        '--security-opt', 'no-new-privileges',
        '--cap-drop', 'ALL',
        '-v', `${repoPath}:/repo:ro`,
        '-v', `${reportDir}:/out`,
        'proeva-tools/gitleaks:latest',
        'detect', '--source', '/repo', '--report-format', 'json',
        '--report-path', '/out/report.json', '--no-git', '--exit-code', '0',
      ]
      await runNative('docker', args, { timeoutMs: 25_000 })
    } else {
      await runNative(
        'gitleaks',
        ['detect', '--source', repoPath, '--report-format', 'json', '--report-path', reportPath, '--no-git', '--exit-code', '0'],
        { timeoutMs: 20_000 },
      )
    }

    if (!fs.existsSync(reportPath)) {
      return { tool: 'gitleaks', found: [] } // no findings -> gitleaks may not write a file at all
    }

    const raw = fs.readFileSync(reportPath, 'utf-8')
    const parsed = raw.trim() ? JSON.parse(raw) : []

    const found = (Array.isArray(parsed) ? parsed : []).map((f) => ({
      file: (f.File || '').replace(/^\/?repo\//, ''),
      line: f.StartLine || 0,
      type: f.RuleID || f.Description || 'secret',
    }))

    return { tool: 'gitleaks', found: found.slice(0, 30) }
  } catch (err) {
    return { tool: 'gitleaks', error: err.message, found: [] }
  } finally {
    try { fs.rmSync(reportDir, { recursive: true, force: true }) } catch {}
  }
}

module.exports = { run }
