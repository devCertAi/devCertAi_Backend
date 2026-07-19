/**
 * jscpdRunner.js
 * Code duplication detection — always runs, language agnostic.
 */

const fs = require('fs')
const os = require('os')
const path = require('path')
const { runSandboxed, runNative, isDockerAvailable } = require('../sandboxExec')

async function run(repoPath) {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jscpd-'))

  try {
    const dockerReady = await isDockerAvailable()

    if (dockerReady) {
      const args = [
        'run', '--rm',
        '--network', 'none',
        '--memory', '512m',
        '--cpus', '1',
        '--pids-limit', '256',
        '--security-opt', 'no-new-privileges',
        '--cap-drop', 'ALL',
        '-v', `${repoPath}:/repo:ro`,
        '-v', `${outDir}:/out`,
        'proeva-tools/jscpd:latest',
        'npx', '--yes', 'jscpd', '/repo', '--format', 'json', '--output', '/out',
        '--reporters', 'json', '--silent',
      ]
      await runNative('docker', args, { timeoutMs: 30_000 })
    } else {
      await runNative(
        'npx',
        ['--yes', 'jscpd', repoPath, '--format', 'json', '--output', outDir, '--reporters', 'json', '--silent'],
        { timeoutMs: 25_000 },
      )
    }

    const reportPath = path.join(outDir, 'jscpd-report.json')
    if (!fs.existsSync(reportPath)) {
      return { tool: 'jscpd', duplicationPercent: 0, clones: [] }
    }

    const parsed = JSON.parse(fs.readFileSync(reportPath, 'utf-8'))
    const duplicationPercent = parsed.statistics?.total?.percentage ?? 0
    const clones = (parsed.duplicates || []).slice(0, 30).map((d) => ({
      files: [d.firstFile?.name, d.secondFile?.name].filter(Boolean),
      lines: d.lines || 0,
    }))

    return { tool: 'jscpd', duplicationPercent, clones }
  } catch (err) {
    return { tool: 'jscpd', error: err.message, duplicationPercent: 0, clones: [] }
  } finally {
    try { fs.rmSync(outDir, { recursive: true, force: true }) } catch {}
  }
}

module.exports = { run }
