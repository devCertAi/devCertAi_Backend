const axios = require('axios')
const { callAIForJSON } = require('./aiProvider')
const PROMPTS = require('./promptTemplates')

const GITHUB_TOKEN = process.env.GITHUB_TOKEN
const MAX_FILE_SIZE = 50000 // 50KB per file
const MAX_TOTAL_CONTENT = 15000 // chars sent to AI — default/Small tier cap
const IMPORTANT_EXTENSIONS = ['.js', '.ts', '.jsx', '.tsx', '.py', '.java', '.go', '.rs', '.cpp', '.c', '.cs', '.php', '.rb', '.swift', '.kt']
const SKIP_DIRS = ['node_modules', '.git', 'dist', 'build', '.next', 'coverage', '__pycache__', 'vendor']

// Per-tier caps on how much code gets sampled into the AI prompt. Mirrors
// the Small/Medium/Large credit tiers from projectSizeEstimator.js — a
// project that was priced (and charged credits) as Medium/Large should
// also get proportionally more of its actual code in front of the AI,
// otherwise every project gets evaluated on the same ~15 files no matter
// how big it is, which hurts accuracy on larger codebases.
const TIER_LIMITS = {
  small:  { maxFiles: 15, maxTotalContent: 15000 },
  medium: { maxFiles: 40, maxTotalContent: 45000 },
  large:  { maxFiles: 80, maxTotalContent: 90000 },
}
function limitsForTier(tier) {
  return TIER_LIMITS[tier] || TIER_LIMITS.small
}

function githubHeaders() {
  const headers = { 'Accept': 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' }
  if (GITHUB_TOKEN) headers['Authorization'] = `Bearer ${GITHUB_TOKEN}`
  return headers
}

function parseGithubUrl(url) {
  const match = url.match(/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?(?:\/|$)/)
  if (!match) throw new Error('Invalid GitHub URL')
  return { owner: match[1], repo: match[2] }
}

async function getRepoInfo(owner, repo) {
  const res = await axios.get(`https://api.github.com/repos/${owner}/${repo}`, { headers: githubHeaders() })
  return res.data
}

async function getCommitCount(owner, repo) {
  try {
    const res = await axios.get(`https://api.github.com/repos/${owner}/${repo}/commits?per_page=1`, {
      headers: githubHeaders()
    })
    const link = res.headers.link || ''
    const match = link.match(/page=(\d+)>; rel="last"/)
    return match ? parseInt(match[1]) : 1
  } catch {
    return 0
  }
}

async function getFileTree(owner, repo, branch) {
  const res = await axios.get(
    `https://api.github.com/repos/${owner}/${repo}/git/trees/${branch}?recursive=1`,
    { headers: githubHeaders() }
  )
  return res.data.tree
    .filter(f => f.type === 'blob' && !SKIP_DIRS.some(d => f.path.includes(`${d}/`)))
    .map(f => ({ path: f.path, size: f.size }))
}

async function getFileContent(owner, repo, path) {
  try {
    const res = await axios.get(
      `https://api.github.com/repos/${owner}/${repo}/contents/${path}`,
      { headers: githubHeaders() }
    )
    if (res.data.encoding === 'base64') {
      return Buffer.from(res.data.content, 'base64').toString('utf-8')
    }
    return res.data.content
  } catch {
    return null
  }
}

function detectTechStack(fileTree) {
  const stack = new Set()
  const paths = fileTree.map(f => f.path.toLowerCase())
  const check = (name, tech) => { if (paths.some(p => p.includes(name))) stack.add(tech) }

  check('package.json', 'Node.js')
  check('requirements.txt', 'Python')
  check('go.mod', 'Go')
  check('cargo.toml', 'Rust')
  check('pom.xml', 'Java/Maven')
  check('build.gradle', 'Java/Gradle')
  check('composer.json', 'PHP')
  check('gemfile', 'Ruby')
  check('pubspec.yaml', 'Flutter/Dart')

  const allText = paths.join(' ')
  if (allText.includes('react')) stack.add('React')
  if (allText.includes('next')) stack.add('Next.js')
  if (allText.includes('vue')) stack.add('Vue.js')
  if (allText.includes('angular')) stack.add('Angular')
  if (allText.includes('django')) stack.add('Django')
  if (allText.includes('fastapi')) stack.add('FastAPI')
  if (allText.includes('express')) stack.add('Express.js')
  if (allText.includes('prisma')) stack.add('Prisma')
  if (allText.includes('dockerfile')) stack.add('Docker')
  if (allText.includes('.tsx') || allText.includes('.ts')) stack.add('TypeScript')

  return Array.from(stack)
}

// ── Size stats (for credit-cost estimation) ─────────────────────────────
// Cheap variant of analyzeGithubRepo: fetches repo info + the recursive file
// tree (2 API calls, no per-file content fetches) and returns raw totals.
// Used by projectSizeEstimator to bucket the project into a Small/Medium/
// Large credit tier BEFORE we spend any AI tokens on it.
async function getRepoSizeStats(githubUrl) {
  const { owner, repo } = parseGithubUrl(githubUrl)
  const repoInfo = await getRepoInfo(owner, repo)
  const branch = repoInfo.default_branch || 'main'
  const fileTree = await getFileTree(owner, repo, branch)
  const codeFiles = fileTree.filter(f => IMPORTANT_EXTENSIONS.some(ext => f.path.endsWith(ext)))
  const totalCodeBytes = codeFiles.reduce((sum, f) => sum + (f.size || 0), 0)

  return {
    totalFiles: fileTree.length,
    codeFileCount: codeFiles.length,
    totalCodeBytes,
    techStack: detectTechStack(fileTree),
  }
}

async function analyzeGithubRepo(githubUrl, { tier = 'small' } = {}) {
  const { maxFiles, maxTotalContent } = limitsForTier(tier)
  // Larger tiers also get a bigger per-file slice, not just more files —
  // otherwise a Large project still only gets ~2000 chars per file, which
  // starves the AI on any individual big file even with more files total.
  const perFileChars = tier === 'large' ? 6000 : tier === 'medium' ? 3500 : 2000

  const { owner, repo } = parseGithubUrl(githubUrl)
  const repoInfo = await getRepoInfo(owner, repo)
  const branch = repoInfo.default_branch || 'main'
  const fileTree = await getFileTree(owner, repo, branch)
  const techStack = detectTechStack(fileTree)

  // Prioritize important code files
  const codeFiles = fileTree
    .filter(f => IMPORTANT_EXTENSIONS.some(ext => f.path.endsWith(ext)) && f.size < MAX_FILE_SIZE)
    .sort((a, b) => {
      // Prioritize root-level and src/ files
      const aScore = a.path.includes('src/') ? 2 : a.path.split('/').length === 1 ? 3 : 1
      const bScore = b.path.includes('src/') ? 2 : b.path.split('/').length === 1 ? 3 : 1
      return bScore - aScore
    })
    .slice(0, maxFiles)

  let fileContents = ''
  for (const file of codeFiles) {
    if (fileContents.length > maxTotalContent) break
    const content = await getFileContent(owner, repo, file.path)
    if (content) {
      fileContents += `\n\n--- ${file.path} ---\n${content.slice(0, perFileChars)}`
    }
  }

  return {
    fileTree: fileTree.slice(0, 100).map(f => f.path),
    fileContents: fileContents.slice(0, maxTotalContent),
    techStack,
    repoInfo: {
      stars: repoInfo.stargazers_count,
      forks: repoInfo.forks_count,
      language: repoInfo.language,
      description: repoInfo.description,
    }
  }
}

// ── Domain classification ────────────────────────────────────────────────
// Guesses which exam domain (Frontend / Backend / Full Stack / Mobile /
// Data Science / DevOps / Programming Languages) a repo belongs to, purely
// from the detected tech stack + file tree. This runs BEFORE we spend an AI
// call generating Phase 2 questions, so a candidate who pastes the wrong
// repo (e.g. a Backend repo for a Frontend exam) gets an instant, cheap
// rejection instead of burning AI credits/time on a repo we're going to
// throw away anyway.
const FRONTEND_SIGNALS = ['React', 'Vue.js', 'Angular', 'Next.js']
const BACKEND_SIGNALS = ['Express.js', 'Django', 'FastAPI', 'Java/Maven', 'Java/Gradle', 'Go', 'Prisma']
const MOBILE_PATH_HINTS = ['androidmanifest.xml', '.xcodeproj', 'pubspec.yaml', 'app/src/main']
const DEVOPS_PATH_HINTS = ['dockerfile', 'docker-compose', '.github/workflows', 'kubernetes', 'helm/']
const DATASCIENCE_PATH_HINTS = ['.ipynb', 'requirements.txt', 'model.py', 'train.py', 'dataset']

function classifyRepoDomain({ techStack = [], fileTree = [] } = {}) {
  const paths = fileTree.map(p => String(p).toLowerCase())
  const hasAny = (hints) => hints.some(h => paths.some(p => p.includes(h)))

  const hasFrontend = techStack.some(t => FRONTEND_SIGNALS.includes(t)) || hasAny(['.jsx', '.tsx', '.vue'])
  const hasBackend = techStack.some(t => BACKEND_SIGNALS.includes(t))
  const hasMobile = hasAny(MOBILE_PATH_HINTS)
  const hasDevOps = hasAny(DEVOPS_PATH_HINTS)
  const hasDataScience = hasAny(DATASCIENCE_PATH_HINTS) && techStack.includes('Python')

  if (hasMobile) return { domain: 'Mobile', confidence: 'high' }
  if (hasFrontend && hasBackend) return { domain: 'Full Stack', confidence: 'high' }
  if (hasFrontend) return { domain: 'Frontend', confidence: 'high' }
  if (hasBackend) return { domain: 'Backend', confidence: 'high' }
  if (hasDataScience) return { domain: 'Data Science', confidence: 'medium' }
  if (hasDevOps) return { domain: 'DevOps', confidence: 'medium' }
  if (techStack.length > 0) return { domain: 'Programming Languages', confidence: 'low' }
  return { domain: null, confidence: 'none' }
}

// Is the detected repo domain compatible with the exam domain the candidate
// selected? 'Full Stack' exams accept either a Full Stack repo, or a repo
// that's purely Frontend or purely Backend (since Full Stack candidates
// submit frontend + backend as two SEPARATE links anyway — see
// examController's isFullStack branch, which never calls this on the
// combined repo). Low-confidence / undetectable repos are allowed through
// rather than blocked, to avoid false-positive rejections on unusual stacks.
function domainsAreCompatible(examDomain, detected) {
  // Only bypass the check when NOTHING could be detected at all (empty/
  // unrecognized repo) — this is the genuinely ambiguous case worth letting
  // through rather than falsely rejecting.
  if (!detected.domain || detected.confidence === 'none') return true
  if (detected.domain === examDomain) return true
  if (examDomain === 'Full Stack' && (detected.domain === 'Frontend' || detected.domain === 'Backend')) return true
  // 'low' confidence means SOME tech stack was detected but it didn't match
  // any specific domain signal (falls through to 'Programming Languages').
  // That's still a real signal, not a lack of one — it should only be
  // treated as compatible when the candidate is actually taking the
  // generic 'Programming Languages' exam. Previously this bypassed the
  // check for every domain, which meant a repo that clearly wasn't
  // Frontend/Backend/Mobile/etc. still showed as "match" no matter what
  // domain the candidate picked.
  if (detected.confidence === 'low') return examDomain === 'Programming Languages'
  return false
}

// ── AI Domain Analyzer ───────────────────────────────────────────────────
// Strict, authoritative Phase 2 domain match check. classifyRepoDomain above
// is a fast/free heuristic based purely on tech-stack keywords and file
// paths — useful as an instant pre-filter, but easy to fool (a "backend/"
// folder that's actually static HTML, or a framework name that doesn't
// prove what the code inside actually does). This instead samples real code
// CONTENT and sends it to the AI model, asking it to both classify the
// domain and explicitly judge whether it matches the domain the candidate
// selected for this exam attempt.
const DOMAIN_ANALYZER_SAMPLE_CHARS = 4000

/**
 * Pulls a representative slice of characters out of the (already file-
 * prioritized) fileContents string built by analyzeGithubRepo/analyzeZip.
 * Takes most of the budget from the start (highest-signal root/src files,
 * per analyzeGithubRepo's sort) plus a smaller slice from the end, so a
 * single very large first file can't starve every other file out of the
 * sample sent to the AI.
 */
function sampleCodeCharacters(fileContents = '', maxChars = DOMAIN_ANALYZER_SAMPLE_CHARS) {
  if (!fileContents) return ''
  if (fileContents.length <= maxChars) return fileContents
  const headChars = Math.ceil(maxChars * 0.7)
  const tailChars = maxChars - headChars
  const head = fileContents.slice(0, headChars)
  const tailStart = Math.max(headChars, fileContents.length - tailChars)
  const tail = fileContents.slice(tailStart)
  return `${head}\n\n[...sampled...]\n\n${tail}`
}

const VALID_AI_DOMAINS = new Set([
  'Frontend', 'Backend', 'Full Stack', 'Mobile', 'Data Science', 'DevOps', 'Programming Languages',
])

/**
 * `sampleLabel` ("frontend" | "backend" | null) is used by the Full Stack
 * combo flow, where each half of the submission is analyzed independently
 * (see submitPhase2Project's isFullStack branch in examController.js). It
 * tells the model this specific sample is one half of a combo submission, so
 * a frontend-labeled half classifying as plain "Frontend" (rather than
 * "Full Stack") still counts as a correct match, and likewise for the
 * backend half — the one legitimate exception to otherwise strict matching.
 */
async function aiAnalyzeDomainMatch({ targetDomain, techStack = [], fileTree = [], fileContents = '', sampleLabel = null }) {
  const codeSample = sampleCodeCharacters(fileContents)

  let result
  try {
    result = await callAIForJSON({
      systemPrompt: PROMPTS.DOMAIN_ANALYZER_SYSTEM,
      userPrompt: PROMPTS.DOMAIN_ANALYZER_USER({ targetDomain, techStack, fileTree, codeSample, sampleLabel }),
      maxTokens: 400,
      temperature: 0,
    })
  } catch (err) {
    // AI is unreachable/misconfigured/returned garbage. Fail CLOSED (treat as
    // "could not confirm a match") for a strict gate — silently letting every
    // submission through whenever the analyzer itself is down would defeat
    // the point of adding it. The caller turns this into a clear, actionable
    // error rather than a generic 500.
    const error = new Error(`AI domain analysis failed: ${err.message}`)
    error.aiUnavailable = true
    throw error
  }

  if (!VALID_AI_DOMAINS.has(result.detectedDomain)) result.detectedDomain = null
  result.matches = result.detectedDomain ? !!result.matches : false
  result.confidence = Math.max(0, Math.min(100, Number(result.confidence) || 0))
  result.reasoning = result.reasoning || ''

  return result
}

async function validateGithubRepo(githubUrl) {
  try {
    const { owner, repo } = parseGithubUrl(githubUrl)
    const [repoInfo, commitCount] = await Promise.all([
      getRepoInfo(owner, repo),
      getCommitCount(owner, repo)
    ])
    return {
      valid: true,
      isPublic: !repoInfo.private,
      commitCount,
      hasEnoughCommits: commitCount >= 1,
      name: repoInfo.full_name,
      description: repoInfo.description,
      language: repoInfo.language
    }
  } catch (err) {
    return { valid: false, error: err.message }
  }
}

module.exports = {
  analyzeGithubRepo, validateGithubRepo, parseGithubUrl,
  classifyRepoDomain, domainsAreCompatible, getRepoSizeStats,
  limitsForTier, TIER_LIMITS,
  aiAnalyzeDomainMatch,
}
