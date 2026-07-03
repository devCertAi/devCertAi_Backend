const axios = require('axios')

const GITHUB_TOKEN = process.env.GITHUB_TOKEN
const MAX_FILE_SIZE = 50000 // 50KB per file
const MAX_TOTAL_CONTENT = 15000 // chars sent to AI
const IMPORTANT_EXTENSIONS = ['.js', '.ts', '.jsx', '.tsx', '.py', '.java', '.go', '.rs', '.cpp', '.c', '.cs', '.php', '.rb', '.swift', '.kt']
const SKIP_DIRS = ['node_modules', '.git', 'dist', 'build', '.next', 'coverage', '__pycache__', 'vendor']

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

async function analyzeGithubRepo(githubUrl) {
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
    .slice(0, 15)

  let fileContents = ''
  for (const file of codeFiles) {
    if (fileContents.length > MAX_TOTAL_CONTENT) break
    const content = await getFileContent(owner, repo, file.path)
    if (content) {
      fileContents += `\n\n--- ${file.path} ---\n${content.slice(0, 2000)}`
    }
  }

  return {
    fileTree: fileTree.slice(0, 100).map(f => f.path),
    fileContents: fileContents.slice(0, MAX_TOTAL_CONTENT),
    techStack,
    repoInfo: {
      stars: repoInfo.stargazers_count,
      forks: repoInfo.forks_count,
      language: repoInfo.language,
      description: repoInfo.description,
    }
  }
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

module.exports = { analyzeGithubRepo, validateGithubRepo, parseGithubUrl }
