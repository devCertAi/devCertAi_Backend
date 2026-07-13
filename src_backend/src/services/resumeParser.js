const axios = require('axios')
const prisma = require('../config/database')

// ─── text extraction ──────────────────────────────────────────────────────────

async function extractTextFromUrl(resumeUrl) {
  if (!resumeUrl) return ''
  try {
    const { signRawUrl } = require('./storageService')
    const response = await axios.get(signRawUrl(resumeUrl), { responseType: 'arraybuffer', timeout: 15000 })
    const buffer = Buffer.from(response.data)
    const pdfParse = require('pdf-parse')
    const result = await pdfParse(buffer)
    return sanitize(result.text || '')
  } catch (err) {
    console.error('[ResumeParser] extractTextFromUrl failed:', err.message)
    return ''
  }
}

async function extractTextFromBuffer(buffer) {
  try {
    const pdfParse = require('pdf-parse')
    const result = await pdfParse(buffer)
    return sanitize(result.text || '')
  } catch {
    return sanitize(buffer.toString('utf-8'))
  }
}

function sanitize(text) {
  return text
    .replace(/\0/g, '')
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '')
    .trim()
}

// ─── basic field extraction ───────────────────────────────────────────────────

function extractPhone(text) {
  const m = text.match(/(?:\+91[\s-]?)?[6-9]\d{9}|\+?[\d][\d\s\-().]{8,15}\d/)
  return m ? m[0].trim() : null
}

function extractLinkedin(text) {
  const m = text.match(/https?:\/\/(?:www\.)?linkedin\.com\/in\/[\w-]+\/?/i)
  return m ? m[0] : null
}

function extractGithub(text) {
  const m = text.match(/https?:\/\/(?:www\.)?github\.com\/[\w-]+\/?/i)
  return m ? m[0] : null
}

function extractPortfolio(text) {
  const m = text.match(/https?:\/\/(?!.*(?:linkedin|github|google|facebook|twitter|instagram))[\w.-]+\.[a-z]{2,}(?:\/[^\s]*)*/i)
  return m ? m[0] : null
}

function extractEmail(text) {
  const m = text.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/)
  return m ? m[0] : null
}

function extractLocation(text) {
  // Look for "City, State" or "City, Country" patterns
  const m = text.match(/(?:location|address|city)[:\s]+([A-Za-z\s]+,\s*[A-Za-z\s]+)/i)
    || text.match(/\b([A-Z][a-z]+(?:\s[A-Z][a-z]+)?,\s*(?:India|USA|UK|Canada|Australia|[A-Z]{2}))\b/)
  return m ? m[1].trim() : null
}

function extractHeadline(lines) {
  // Usually line 1 is name, line 2 is title/headline
  const candidates = lines.slice(0, 5).filter(l =>
    l.length > 5 && l.length < 100 &&
    !l.match(/^\+?\d/) &&        // not a phone
    !l.match(/^[\w.]+@/) &&      // not an email
    !l.match(/^https?:\/\//)     // not a URL
  )
  return candidates[1] || candidates[0] || null
}

function extractSummary(text) {
  // Look for common summary section headers
  const m = text.match(
    /(?:summary|objective|profile|about me|career objective)[:\s\n]+([^\n]{30,}(?:\n(?!\n)[^\n]{0,}){0,5})/i
  )
  if (m) return m[1].replace(/\n/g, ' ').trim().slice(0, 600)

  // Fallback: grab a decent-sized early paragraph
  const paras = text.split(/\n{2,}/).map(p => p.replace(/\n/g, ' ').trim())
  const para = paras.find(p => p.length > 80 && p.length < 600 && !p.match(/^[\d+]/))
  return para || null
}

// ─── education extraction ─────────────────────────────────────────────────────

const DEGREE_PATTERNS = [
  /\b(b\.?tech|bachelor of technology|be\b|b\.?e\.?)\b/i,
  /\b(m\.?tech|master of technology|me\b|m\.?e\.?)\b/i,
  /\b(b\.?sc|bachelor of science)\b/i,
  /\b(m\.?sc|master of science)\b/i,
  /\b(bca|mca)\b/i,
  /\b(bba|mba)\b/i,
  /\b(phd|ph\.d|doctorate)\b/i,
  /\b(diploma|12th|10th|high school|secondary)\b/i,
]

function extractEducation(text) {
  const section = extractSection(text, ['education', 'academic', 'qualification'])
  if (!section) return []

  const entries = []
  const blocks = section.split(/\n{2,}|\n(?=[A-Z])/).filter(b => b.trim().length > 10)

  for (const block of blocks.slice(0, 6)) {
    const lines = block.split('\n').map(l => l.trim()).filter(Boolean)
    if (!lines.length) continue

    let degree = null
    for (const pat of DEGREE_PATTERNS) {
      const m = block.match(pat)
      if (m) { degree = m[0]; break }
    }

    const yearMatch = block.match(/(\d{4})\s*[-–to]+\s*(\d{4}|present|current)/i)
      || block.match(/(\d{4})/)

    const gradeMatch = block.match(/(?:cgpa|gpa|grade|percentage|marks)[:\s]+([0-9.]+\s*(?:\/\s*\d+|%)?)/i)
      || block.match(/([0-9]+(?:\.[0-9]+)?)\s*(?:\/\s*10|cgpa|%)/i)

    entries.push({
      institution: lines[0] || '',
      degree: degree || null,
      fieldOfStudy: extractFieldOfStudy(block),
      startYear: yearMatch ? yearMatch[1] : null,
      endYear: yearMatch && yearMatch[2] && !yearMatch[2].match(/present|current/i) ? yearMatch[2] : null,
      grade: gradeMatch ? gradeMatch[1].trim() : null,
      description: ''
    })
  }

  return entries.filter(e => e.institution)
}

function extractFieldOfStudy(text) {
  const m = text.match(/(?:computer science|information technology|electronics|mechanical|civil|electrical|finance|management|commerce|arts|science|engineering)/i)
  return m ? m[0] : null
}

// ─── experience extraction ────────────────────────────────────────────────────

const EMP_TYPES = {
  internship: /intern(ship)?/i,
  part_time: /part[- ]time/i,
  freelance: /freelance|contract/i,
  full_time: /full[- ]time/i,
}

function extractExperience(text) {
  const section = extractSection(text, ['experience', 'employment', 'work history', 'professional'])
  if (!section) return []

  const entries = []
  const blocks = section.split(/\n{2,}|\n(?=[A-Z][a-z])/).filter(b => b.trim().length > 10)

  for (const block of blocks.slice(0, 8)) {
    const lines = block.split('\n').map(l => l.trim()).filter(Boolean)
    if (lines.length < 2) continue

    const dateMatch = block.match(
      /([A-Za-z]+\.?\s*\d{4}|\d{4})\s*[-–to]+\s*([A-Za-z]+\.?\s*\d{4}|\d{4}|present|current)/i
    )

    let employmentType = 'full_time'
    for (const [type, pat] of Object.entries(EMP_TYPES)) {
      if (pat.test(block)) { employmentType = type; break }
    }

    const isCurrent = dateMatch ? /present|current/i.test(dateMatch[2]) : false

    entries.push({
      company: lines[0] || '',
      title: lines[1] || '',
      employmentType,
      location: extractLocation(block) || '',
      startDate: dateMatch ? normalizeDate(dateMatch[1]) : '',
      endDate: isCurrent ? '' : (dateMatch ? normalizeDate(dateMatch[2]) : ''),
      isCurrent,
      description: lines.slice(2).join(' ').trim().slice(0, 500)
    })
  }

  return entries.filter(e => e.company && e.title)
}

// ─── certifications extraction ────────────────────────────────────────────────

function extractCertifications(text) {
  const section = extractSection(text, ['certification', 'certificate', 'course', 'achievement', 'license'])
  if (!section) return []

  const entries = []
  const lines = section.split('\n').map(l => l.trim()).filter(l => l.length > 5)

  for (const line of lines.slice(0, 10)) {
    const dateMatch = line.match(/([A-Za-z]+\.?\s*\d{4}|\d{4})/)
    const urlMatch = line.match(/https?:\/\/[^\s]+/)

    entries.push({
      name: line.replace(/[-–|]\s*\d{4}.*/, '').replace(/https?:\/\/[^\s]+/, '').trim(),
      issuer: extractIssuer(line),
      issueDate: dateMatch ? normalizeDate(dateMatch[1]) : '',
      expiryDate: '',
      credentialUrl: urlMatch ? urlMatch[0] : ''
    })
  }

  return entries.filter(e => e.name && e.name.length > 3)
}

function extractIssuer(text) {
  const issuers = ['coursera', 'udemy', 'aws', 'google', 'microsoft', 'oracle', 'cisco', 'meta', 'linkedin', 'nptel', 'infosys']
  const lower = text.toLowerCase()
  return issuers.find(i => lower.includes(i)) || null
}

// ─── skills extraction ────────────────────────────────────────────────────────

async function extractSkillsFromText(text) {
  if (!text) return []
  const allSkills = await prisma.skill.findMany({ select: { name: true } })
  const lowerText = text.toLowerCase()
  const found = []
  for (const { name } of allSkills) {
    const escaped = name.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const pattern = new RegExp(`(?:^|[^a-z0-9])${escaped}(?:[^a-z0-9]|$)`, 'i')
    if (pattern.test(lowerText)) found.push(name)
  }
  return found
}

// ─── experience years ─────────────────────────────────────────────────────────

function extractExperienceYears(text) {
  if (!text) return null
  const patterns = [
    /(\d+(?:\.\d+)?)\+?\s*(?:years|yrs)\s*(?:of)?\s*experience/i,
    /experience\s*[:\-]?\s*(\d+(?:\.\d+)?)\+?\s*(?:years|yrs)/i,
  ]
  for (const pattern of patterns) {
    const match = text.match(pattern)
    if (match) {
      const years = parseFloat(match[1])
      if (!isNaN(years)) return years
    }
  }
  return null
}

// ─── helpers ──────────────────────────────────────────────────────────────────

function extractSection(text, headings) {
  const pattern = new RegExp(
    `(?:${headings.join('|')})[:\\s]*\\n([\\s\\S]*?)(?=\\n(?:education|experience|skills|projects|certif|award|language|reference|summary|objective|profile|contact|$)[:\\s]*\\n|$)`,
    'i'
  )
  const m = text.match(pattern)
  return m ? m[1].trim() : null
}

function normalizeDate(str) {
  if (!str) return ''
  // "Jan 2022" → "2022-01-01", "2022" → "2022-01-01"
  const months = { jan:1,feb:2,mar:3,apr:4,may:5,jun:6,jul:7,aug:8,sep:9,oct:10,nov:11,dec:12 }
  const m = str.match(/([A-Za-z]+)\.?\s*(\d{4})/)
  if (m) {
    const mon = months[m[1].toLowerCase().slice(0, 3)]
    return `${m[2]}-${String(mon || 1).padStart(2, '0')}-01`
  }
  const y = str.match(/(\d{4})/)
  return y ? `${y[1]}-01-01` : ''
}

// ─── full parse ───────────────────────────────────────────────────────────────

async function parseResumeFromBuffer(buffer) {
  const rawText = await extractTextFromBuffer(buffer)
  if (!rawText || rawText.length < 30) return { rawText: '', parsed: buildEmpty() }

  const lines = rawText.split('\n').map(l => l.trim()).filter(Boolean)

  const [parsedSkills, education, experience, certifications] = await Promise.all([
    extractSkillsFromText(rawText),
    Promise.resolve(extractEducation(rawText)),
    Promise.resolve(extractExperience(rawText)),
    Promise.resolve(extractCertifications(rawText)),
  ])

  const parsed = {
    headline: extractHeadline(lines),
    summary: extractSummary(rawText),
    phone: extractPhone(rawText),
    location: extractLocation(rawText),
    linkedinUrl: extractLinkedin(rawText),
    githubUrl: extractGithub(rawText),
    portfolioUrl: extractPortfolio(rawText),
    skills: parsedSkills.map(name => ({ name, level: null })),
    education,
    experience,
    certifications,
  }

  return { rawText, parsed }
}

function buildEmpty() {
  return {
    headline: null, summary: null, phone: null, location: null,
    linkedinUrl: null, githubUrl: null, portfolioUrl: null,
    skills: [], education: [], experience: [], certifications: []
  }
}

// ─── cache helper (used by pipeline) ─────────────────────────────────────────

async function parseAndCacheResume(userId, resumeUrl) {
  const existing = await prisma.parsedResume.findUnique({ where: { userId } })
  if (existing && existing.rawText) return existing

  const rawText = await extractTextFromUrl(resumeUrl)
  const parsedSkills = await extractSkillsFromText(rawText)
  const experienceYears = extractExperienceYears(rawText)

  return prisma.parsedResume.upsert({
    where: { userId },
    update: { rawText, parsedSkills, experienceYears },
    create: { userId, rawText, parsedSkills, experienceYears }
  })
}

module.exports = {
  extractTextFromUrl,
  extractTextFromBuffer,
  extractSkillsFromText,
  extractExperienceYears,
  extractPhone,
  extractLinkedin,
  extractGithub,
  parseResumeFromBuffer,
  parseAndCacheResume,
}