/**
 * domainDetector.js
 *
 * Deterministic, signal-file based domain classification — no AI call, no
 * network access. Runs first inside the orchestrator because the result
 * decides which language-specific linter (eslintRunner vs ruffRunner) to
 * run. Mirrors (and stays behind) the shared toolResults.domain contract:
 *   { category, confidence, detectionMethod, languageBreakdown }
 */

const fs = require('fs')
const path = require('path')
const { runNative } = require('./sandboxExec')

const CATEGORIES = [
  'backend-node', 'frontend', 'mobile-react-native', 'mobile-flutter',
  'mobile-ios', 'mobile-android', 'ml-ai', 'fullstack', 'backend-python',
  'backend-java', 'backend-go', 'unknown',
]

function exists(repoPath, rel) {
  try {
    return fs.existsSync(path.join(repoPath, rel))
  } catch {
    return false
  }
}

function existsAnywhere(repoPath, filename, maxDepth = 3) {
  // Cheap bounded walk — repos are already size-limited before we get here,
  // so this is fine without a full recursive glob library.
  const stack = [{ dir: repoPath, depth: 0 }]
  while (stack.length) {
    const { dir, depth } = stack.pop()
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === '.git' || entry.name.startsWith('.')) continue
      if (entry.name === filename) return true
      if (entry.isDirectory() && depth < maxDepth) {
        stack.push({ dir: path.join(dir, entry.name), depth: depth + 1 })
      }
    }
  }
  return false
}

function readJsonSafe(repoPath, rel) {
  try {
    return JSON.parse(fs.readFileSync(path.join(repoPath, rel), 'utf-8'))
  } catch {
    return null
  }
}

function readTextSafe(repoPath, rel) {
  try {
    return fs.readFileSync(path.join(repoPath, rel), 'utf-8')
  } catch {
    return null
  }
}

/** Bounded recursive search for any file ending in `ext`. */
function walkForExtension(repoPath, ext, maxDepth = 3) {
  const stack = [{ dir: repoPath, depth: 0 }]
  while (stack.length) {
    const { dir, depth } = stack.pop()
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === '.git' || entry.name.startsWith('.')) continue
      if (!entry.isDirectory() && entry.name.endsWith(ext)) return true
      if (entry.isDirectory() && depth < maxDepth) {
        stack.push({ dir: path.join(dir, entry.name), depth: depth + 1 })
      }
    }
  }
  return false
}

/** Try to get a per-language line-count breakdown via `tokei` if it's installed. */
async function getLanguageBreakdown(repoPath) {
  try {
    const { code, stdout } = await runNative('tokei', [repoPath, '--output', 'json'], { timeoutMs: 10_000 })
    if (code !== 0) return undefined
    const parsed = JSON.parse(stdout)
    const totalsByLang = {}
    let totalLines = 0
    for (const [lang, data] of Object.entries(parsed)) {
      if (!data || typeof data.code !== 'number') continue
      totalsByLang[lang] = data.code
      totalLines += data.code
    }
    if (totalLines === 0) return undefined
    const breakdown = {}
    for (const [lang, lines] of Object.entries(totalsByLang)) {
      breakdown[lang] = Math.round((lines / totalLines) * 100)
    }
    return breakdown
  } catch {
    return undefined // tokei not installed — field is simply omitted
  }
}

/**
 * Signal-file based detection, per the shared contract's rule table.
 * Returns { category, confidence, matchedSignals } (languageBreakdown is
 * attached separately since it needs an async tokei call).
 */
function detectCategory(repoPath) {
  const pkg = readJsonSafe(repoPath, 'package.json')
  const deps = pkg ? { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) } : {}
  const hasDep = (name) => Object.prototype.hasOwnProperty.call(deps, name)

  const requirementsTxt = readTextSafe(repoPath, 'requirements.txt') || ''
  const pyprojectToml = readTextSafe(repoPath, 'pyproject.toml') || ''
  const pythonManifest = `${requirementsTxt}\n${pyprojectToml}`.toLowerCase()

  const signals = []

  const isFlutter = exists(repoPath, 'pubspec.yaml')
  const isReactNative = hasDep('react-native') || (exists(repoPath, 'android') && exists(repoPath, 'ios') && hasDep('react'))
  const isIos = existsAnywhere(repoPath, 'Podfile') || walkForExtension(repoPath, '.xcodeproj')
  const isAndroid = exists(repoPath, 'build.gradle') && existsAnywhere(repoPath, 'AndroidManifest.xml')
  const isNodeBackend = hasDep('express') || hasDep('fastify') || hasDep('koa') || hasDep('@nestjs/core')
  const isPyBackend = /django|flask|fastapi/.test(pythonManifest)
  const hasIpynb = walkForExtension(repoPath, '.ipynb')
  const isMlAi = /tensorflow|torch|scikit-learn|sklearn/.test(pythonManifest) || hasIpynb
  const isJavaBackend = exists(repoPath, 'pom.xml') || (exists(repoPath, 'build.gradle') && !existsAnywhere(repoPath, 'AndroidManifest.xml'))
  const isGoBackend = exists(repoPath, 'go.mod')
  const hasFrontendDep = hasDep('react') || hasDep('vue') || hasDep('@angular/core') || hasDep('svelte')
  const hasServerDep = isNodeBackend

  if (isFlutter) signals.push({ category: 'mobile-flutter', weight: 3 })
  if (isReactNative) signals.push({ category: 'mobile-react-native', weight: 3 })
  if (isIos) signals.push({ category: 'mobile-ios', weight: 3 })
  if (isAndroid) signals.push({ category: 'mobile-android', weight: 3 })
  if (isNodeBackend) signals.push({ category: 'backend-node', weight: 2 })
  if (isPyBackend) signals.push({ category: 'backend-python', weight: 2 })
  if (isMlAi || hasIpynb) signals.push({ category: 'ml-ai', weight: 2 })
  if (isJavaBackend) signals.push({ category: 'backend-java', weight: 2 })
  if (isGoBackend) signals.push({ category: 'backend-go', weight: 2 })
  if (hasFrontendDep && !hasServerDep) signals.push({ category: 'frontend', weight: 2 })
  if (hasFrontendDep && hasServerDep) signals.push({ category: 'fullstack', weight: 3 })

  if (signals.length === 0) return { category: 'unknown', confidence: 0, matchedSignals: 0 }

  // Highest-weight signal wins; confidence scales with weight + signal count.
  signals.sort((a, b) => b.weight - a.weight)
  const top = signals[0]
  const confidence = Math.min(95, 55 + top.weight * 12 + (signals.length - 1) * 5)

  return { category: top.category, confidence, matchedSignals: signals.length }
}

async function detectDomain(repoPath) {
  const { category, confidence } = safeDetect(repoPath)
  const languageBreakdown = await getLanguageBreakdown(repoPath)

  return {
    category,
    confidence,
    detectionMethod: 'signal-file',
    ...(languageBreakdown ? { languageBreakdown } : {}),
  }
}

function safeDetect(repoPath) {
  try {
    return detectCategory(repoPath)
  } catch (err) {
    return { category: 'unknown', confidence: 0, matchedSignals: 0, error: err.message }
  }
}

module.exports = { detectDomain, CATEGORIES }
