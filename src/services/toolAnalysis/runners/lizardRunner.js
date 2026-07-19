/**
 * lizardRunner.js
 * Cyclomatic complexity — runs if lizard is installed in the tool image.
 */

const { runSandboxed } = require('../sandboxExec')

function parseLizardCsv(output) {
  // `lizard --csv` output is stable across versions:
  // nloc,ccn,token,param,length,location,file,function,long_name,start,end
  const lines = output.split('\n').filter((l) => l.trim() && !l.startsWith('='))
  const rows = []
  for (const line of lines) {
    const parts = line.split(',')
    if (parts.length < 8) continue
    const ccn = Number(parts[1])
    if (Number.isNaN(ccn)) continue
    rows.push({
      ccn,
      file: parts[6]?.trim(),
      function: parts[7]?.trim(),
    })
  }
  return rows
}

async function run(repoPath) {
  try {
    const { code, stdout, stderr } = await runSandboxed(
      'proeva-tools/lizard:latest',
      ['lizard', '/repo', '--csv'],
      repoPath,
      { timeoutMs: 20_000, writableTmp: false },
    )

    if (code !== 0 && !stdout) {
      return { tool: 'lizard', error: stderr?.slice(0, 500) || `lizard exited with code ${code}`, avgCyclomaticComplexity: null, highComplexityFunctions: [] }
    }

    const rows = parseLizardCsv(stdout)
    if (rows.length === 0) {
      return { tool: 'lizard', avgCyclomaticComplexity: null, highComplexityFunctions: [] }
    }

    const avgCyclomaticComplexity = Number(
      (rows.reduce((sum, r) => sum + r.ccn, 0) / rows.length).toFixed(1),
    )

    const highComplexityFunctions = rows
      .filter((r) => r.ccn >= 15)
      .sort((a, b) => b.ccn - a.ccn)
      .slice(0, 10)
      .map((r) => ({ file: (r.file || '').replace(/^\/?repo\//, ''), function: r.function, ccn: r.ccn }))

    return { tool: 'lizard', avgCyclomaticComplexity, highComplexityFunctions }
  } catch (err) {
    return { tool: 'lizard', error: err.message, avgCyclomaticComplexity: null, highComplexityFunctions: [] }
  }
}

module.exports = { run }
