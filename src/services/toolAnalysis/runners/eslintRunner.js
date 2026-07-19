/**
 * eslintRunner.js
 * Runs only when the detected domain is JS/TS based. Writes a temporary
 * minimal eslint config if the repo doesn't ship one, then cleans it up.
 */

const fs = require('fs')
const path = require('path')
const { runSandboxed } = require('../sandboxExec')

const JS_TS_DOMAINS = new Set([
  'frontend', 'backend-node', 'fullstack', 'mobile-react-native',
])

const TEMP_CONFIG_NAME = '.eslintrc.proeva-temp.json'
const TEMP_CONFIG = {
  root: true,
  env: { browser: true, node: true, es2021: true },
  parserOptions: { ecmaVersion: 'latest', sourceType: 'module', ecmaFeatures: { jsx: true } },
  extends: ['eslint:recommended'],
  rules: {},
}

function hasExistingConfig(repoPath) {
  return [
    '.eslintrc', '.eslintrc.js', '.eslintrc.cjs', '.eslintrc.json',
    '.eslintrc.yml', '.eslintrc.yaml', 'eslint.config.js', 'eslint.config.mjs',
  ].some((f) => fs.existsSync(path.join(repoPath, f)))
}

function severityFromEslint(sev) {
  // ESLint: 1 = warning, 2 = error
  return sev === 2 ? 'error' : 'warning'
}

async function run(repoPath, { domain } = {}) {
  if (domain && !JS_TS_DOMAINS.has(domain)) {
    return { tool: 'eslint', skipped: true, reason: `domain ${domain} is not JS/TS` }
  }

  let wroteTempConfig = false
  const tempConfigPath = path.join(repoPath, TEMP_CONFIG_NAME)

  try {
    if (!hasExistingConfig(repoPath)) {
      fs.writeFileSync(tempConfigPath, JSON.stringify(TEMP_CONFIG, null, 2))
      wroteTempConfig = true
    }

    const configArg = wroteTempConfig ? ['-c', `/repo/${TEMP_CONFIG_NAME}`] : []
    const { code, stdout, stderr } = await runSandboxed(
      'proeva-tools/eslint:latest',
      ['npx', '--yes', 'eslint', '.', '--format', 'json', '--ext', '.js,.jsx,.ts,.tsx', ...configArg],
      repoPath,
      { timeoutMs: 25_000 },
    )

    if (code !== 0 && !stdout) {
      return { tool: 'eslint', error: stderr?.slice(0, 500) || 'eslint exited non-zero with no output', errorCount: 0, warningCount: 0, issues: [] }
    }

    let results
    try {
      results = JSON.parse(stdout)
    } catch {
      return { tool: 'eslint', error: 'Failed to parse eslint JSON output', errorCount: 0, warningCount: 0, issues: [] }
    }

    let errorCount = 0
    let warningCount = 0
    const issues = []

    for (const file of results) {
      const relFile = path.relative('/repo', file.filePath || file.filePath)
      for (const msg of file.messages || []) {
        const severity = severityFromEslint(msg.severity)
        if (severity === 'error') errorCount++
        else warningCount++
        issues.push({
          file: relFile || file.filePath,
          line: msg.line || 0,
          rule: msg.ruleId || 'unknown',
          message: msg.message,
          severity,
        })
      }
    }

    // Trim to top 30 by severity (errors first) to avoid bloating the AI payload.
    issues.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'error' ? -1 : 1))

    return { tool: 'eslint', errorCount, warningCount, issues: issues.slice(0, 30) }
  } catch (err) {
    return { tool: 'eslint', error: err.message, errorCount: 0, warningCount: 0, issues: [] }
  } finally {
    if (wroteTempConfig) {
      try { fs.unlinkSync(tempConfigPath) } catch {}
    }
  }
}

module.exports = { run, JS_TS_DOMAINS }
