/**
 * depcheckRunner.js
 * Unused-dependency / missing-dependency detection for JS/TS (node) projects.
 * Free (MIT). Catches two things reviewers routinely miss by eye:
 *   - "using": packages imported in code but never declared in package.json
 *     (works locally by luck, breaks a clean `npm ci` install)
 *   - unused dependencies bloating install size / a phantom-dependency risk
 * Skipped entirely if the repo has no package.json.
 */

const fs = require('fs')
const path = require('path')
const { runNative, isDockerAvailable } = require('../sandboxExec')
const { JS_TS_DOMAINS } = require('./eslintRunner')

async function run(repoPath, { domain } = {}) {
  if (domain && !JS_TS_DOMAINS.has(domain)) {
    return { tool: 'depcheck', skipped: true, reason: `domain ${domain} is not JS/TS` }
  }
  if (!fs.existsSync(path.join(repoPath, 'package.json'))) {
    return { tool: 'depcheck', skipped: true, reason: 'no package.json found' }
  }

  try {
    const dockerReady = await isDockerAvailable()
    const baseArgs = ['depcheck', '.', '--json']

    let stdout
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
        '-w', '/repo',
        'proeva-tools/depcheck:latest',
        'npx', '--yes', ...baseArgs,
      ]
      const res = await runNative('docker', args, { timeoutMs: 30_000 })
      stdout = res.stdout
    } else {
      const res = await runNative('npx', ['--yes', ...baseArgs], { timeoutMs: 25_000, cwd: repoPath })
      stdout = res.stdout
    }

    let parsed
    try {
      parsed = JSON.parse(stdout)
    } catch {
      return { tool: 'depcheck', error: 'Failed to parse depcheck output', unused: [], missing: [] }
    }

    const unused = [
      ...(Array.isArray(parsed.dependencies) ? parsed.dependencies : []),
      ...(Array.isArray(parsed.devDependencies) ? parsed.devDependencies : []),
    ].slice(0, 30)

    const missing = Object.entries(parsed.missing || {})
      .slice(0, 30)
      .map(([pkg, usedIn]) => ({ package: pkg, usedIn: Array.isArray(usedIn) ? usedIn.slice(0, 5) : [] }))

    return { tool: 'depcheck', unused, missing }
  } catch (err) {
    return { tool: 'depcheck', error: err.message, unused: [], missing: [] }
  }
}

module.exports = { run }
