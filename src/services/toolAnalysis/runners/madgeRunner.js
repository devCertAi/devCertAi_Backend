/**
 * madgeRunner.js
 * Circular-dependency and orphan-module detection for JS/TS projects.
 * Free (MIT), zero external network needed at scan time — `madge` walks the
 * import graph statically. Runs only for JS/TS-based domains, same gate as
 * eslintRunner.
 *
 * Circular imports are one of the most common "hidden" architecture defects
 * in take-home projects (barrel-file cycles, service<->service imports,
 * store<->component cycles) and are essentially invisible to a human
 * skimming file contents, which is exactly why an AI reviewer misses them
 * without this tool.
 */

const { runNative, isDockerAvailable } = require('../sandboxExec')
const { JS_TS_DOMAINS } = require('./eslintRunner')

async function run(repoPath, { domain } = {}) {
  if (domain && !JS_TS_DOMAINS.has(domain)) {
    return { tool: 'madge', skipped: true, reason: `domain ${domain} is not JS/TS` }
  }

  try {
    const dockerReady = await isDockerAvailable()
    const baseArgs = ['madge', '--circular', '--json', '--extensions', 'js,jsx,ts,tsx', '.']

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
        'proeva-tools/madge:latest',
        'npx', '--yes', ...baseArgs,
      ]
      const res = await runNative('docker', args, { timeoutMs: 25_000 })
      stdout = res.stdout
    } else {
      const res = await runNative('npx', ['--yes', ...baseArgs], { timeoutMs: 20_000, cwd: repoPath })
      stdout = res.stdout
    }

    let cycles
    try {
      cycles = JSON.parse(stdout)
    } catch {
      // madge prints a plain "No circular dependency found" line (not JSON)
      // when there's nothing to report — treat as a clean scan, not a failure.
      if (/no circular/i.test(stdout || '')) return { tool: 'madge', circularDependencies: [] }
      return { tool: 'madge', error: 'Failed to parse madge output', circularDependencies: [] }
    }

    const circularDependencies = (Array.isArray(cycles) ? cycles : [])
      .slice(0, 30)
      .map((chain) => ({ chain: Array.isArray(chain) ? chain : [], length: Array.isArray(chain) ? chain.length : 0 }))

    return { tool: 'madge', circularDependencies }
  } catch (err) {
    return { tool: 'madge', error: err.message, circularDependencies: [] }
  }
}

module.exports = { run }
