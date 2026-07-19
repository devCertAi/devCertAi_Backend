/**
 * repoStaging.js
 *
 * The static-analysis tools in ./runners need real files on disk — but
 * the existing zipAnalyzer/githubAnalyzer only ever read file contents
 * into memory (zip buffer / GitHub Contents API), nothing is written to
 * disk. This module stages a repo into a temp directory just for the
 * toolAnalysis pass, and always cleans up afterwards.
 *
 * Usage:
 *   const staged = await stageRepo(project)
 *   if (staged) {
 *     try { const toolResults = await analyzeRepo(staged.path) }
 *     finally { await staged.cleanup() }
 *   }
 */

const fs = require('fs')
const os = require('os')
const path = require('path')
const axios = require('axios')
const AdmZip = require('adm-zip')
const { runNative } = require('./sandboxExec')

async function stageFromZip(zipUrl) {
  let buffer
  if (zipUrl.startsWith('/') || zipUrl.match(/^[A-Z]:\\/i)) {
    buffer = fs.readFileSync(zipUrl)
  } else {
    const response = await axios.get(zipUrl, { responseType: 'arraybuffer', timeout: 30000 })
    buffer = Buffer.from(response.data)
  }

  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'proeva-repo-'))
  const zip = new AdmZip(buffer)
  zip.extractAllTo(dest, true)
  return dest
}

async function stageFromGithub(githubUrl) {
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'proeva-repo-'))
  try {
    await runNative('git', ['clone', '--depth', '1', '--quiet', githubUrl, dest], { timeoutMs: 30_000 })
    return dest
  } catch (err) {
    try { fs.rmSync(dest, { recursive: true, force: true }) } catch {}
    throw err
  }
}

/**
 * Stages a project's source into a temp directory for tool analysis.
 * Returns null (no error thrown) when there's nothing to stage (liveUrl-only
 * submissions) — callers should treat null as "skip tool analysis".
 */
async function stageRepo(project) {
  let stagedPath = null

  try {
    if (project.zipFileUrl) {
      stagedPath = await stageFromZip(project.zipFileUrl)
    } else if (project.githubUrl) {
      stagedPath = await stageFromGithub(project.githubUrl)
    } else {
      return null // liveUrl-only — no source code available to scan
    }
  } catch (err) {
    console.error('[toolAnalysis] Failed to stage repo for static analysis:', err.message)
    return null
  }

  return {
    path: stagedPath,
    cleanup: async () => {
      try { fs.rmSync(stagedPath, { recursive: true, force: true }) } catch {}
    },
  }
}

module.exports = { stageRepo }
