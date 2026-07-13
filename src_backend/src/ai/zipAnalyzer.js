const AdmZip = require('adm-zip')
const axios = require('axios')
const path = require('path')
const fs = require('fs')
const { limitsForTier } = require('./githubAnalyzer')
const IMPORTANT_EXTENSIONS = ['.js', '.ts', '.jsx', '.tsx', '.py', '.java', '.go', '.rs', '.cpp', '.c', '.cs', '.php', '.rb', '.swift', '.kt']
const SKIP_DIRS = ['node_modules', '.git', 'dist', 'build', '.next', 'coverage', '__pycache__', 'vendor']
const MAX_FILE_SIZE = 50000
const MAX_TOTAL_CONTENT = 15000

function detectTechStackFromFiles(fileNames) {
  const stack = new Set()
  const lower = fileNames.join(' ').toLowerCase()
  if (lower.includes('package.json')) stack.add('Node.js')
  if (lower.includes('requirements.txt')) stack.add('Python')
  if (lower.includes('go.mod')) stack.add('Go')
  if (lower.includes('cargo.toml')) stack.add('Rust')
  if (lower.includes('pom.xml')) stack.add('Java')
  if (lower.includes('react')) stack.add('React')
  if (lower.includes('.tsx') || lower.includes('.ts')) stack.add('TypeScript')
  if (lower.includes('next')) stack.add('Next.js')
  if (lower.includes('vue')) stack.add('Vue.js')
  if (lower.includes('angular')) stack.add('Angular')
  if (lower.includes('django')) stack.add('Django')
  if (lower.includes('express')) stack.add('Express.js')
  if (lower.includes('dockerfile')) stack.add('Docker')
  return Array.from(stack)
}

// ── Size stats (for credit-cost estimation) ─────────────────────────────
// Cheap, buffer-only variant: just walks the zip's central directory
// entries (no content reads) and totals up code file sizes. Used both by
// the pre-submit /estimate-size endpoint (uploaded file still in memory,
// nothing written to disk yet) and by submitProject itself right before
// the credit is consumed.
function getZipSizeStats(buffer) {
  const zip = new AdmZip(buffer)
  const entries = zip.getEntries()

  let totalFiles = 0
  let codeFileCount = 0
  let totalCodeBytes = 0
  const fileTree = []

  for (const entry of entries) {
    if (entry.isDirectory) continue
    const entryPath = entry.entryName.replace(/\\/g, '/')
    if (SKIP_DIRS.some(d => entryPath.includes(`${d}/`))) continue

    totalFiles++
    fileTree.push(entryPath)

    const ext = path.extname(entryPath).toLowerCase()
    if (IMPORTANT_EXTENSIONS.includes(ext)) {
      codeFileCount++
      totalCodeBytes += entry.header.size
    }
  }

  return {
    totalFiles,
    codeFileCount,
    totalCodeBytes,
    techStack: detectTechStackFromFiles(fileTree),
  }
}

async function analyzeZip(zipUrl, { tier = 'small' } = {}) {
  const { maxFiles, maxTotalContent } = limitsForTier(tier)
  const perFileChars = tier === 'large' ? 6000 : tier === 'medium' ? 3500 : 2000

  // Download zip
let buffer
if (zipUrl.startsWith('/') || zipUrl.match(/^[A-Z]:\\/i)) {
  buffer = fs.readFileSync(zipUrl)
} else {
  const response = await axios.get(zipUrl, { responseType: 'arraybuffer', timeout: 30000 })
  buffer = Buffer.from(response.data)
}

  const zip = new AdmZip(buffer)
  const entries = zip.getEntries()

  const fileTree = []
  const codeFiles = []

  for (const entry of entries) {
    if (entry.isDirectory) continue

    const entryPath = entry.entryName.replace(/\\/g, '/')
    // Skip unwanted dirs
    if (SKIP_DIRS.some(d => entryPath.includes(`${d}/`))) continue
    if (entry.header.size > MAX_FILE_SIZE) continue

    fileTree.push(entryPath)

    const ext = path.extname(entryPath).toLowerCase()
    if (IMPORTANT_EXTENSIONS.includes(ext)) {
      codeFiles.push({ path: entryPath, entry })
    }
  }

  const techStack = detectTechStackFromFiles(fileTree)

  // Sort: prefer src/ and root-level files
  codeFiles.sort((a, b) => {
    const aScore = a.path.includes('src/') ? 2 : a.path.split('/').length === 2 ? 3 : 1
    const bScore = b.path.includes('src/') ? 2 : b.path.split('/').length === 2 ? 3 : 1
    return bScore - aScore
  })

  let fileContents = ''
  for (const file of codeFiles.slice(0, maxFiles)) {
    if (fileContents.length >= maxTotalContent) break
    try {
      const content = file.entry.getData().toString('utf-8')
      fileContents += `\n\n--- ${file.path} ---\n${content.slice(0, perFileChars)}`
    } catch {}
  }

  return {
    fileTree: fileTree.slice(0, 100),
    fileContents: fileContents.slice(0, maxTotalContent),
    techStack
  }
}

module.exports = { analyzeZip, getZipSizeStats }
