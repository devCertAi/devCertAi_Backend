/**
 * profileCompleteness.js
 *
 * Internshala-style profile completeness checker.
 * Defines required sections + calculates percentage and missing fields.
 * Used by:
 *   - applyController (gate before applying)
 *   - GET /users/profile-completeness (dashboard widget)
 */

const SECTIONS = [
  {
    key: 'basicInfo',
    label: 'Basic Information',
    description: 'Name, phone, headline and location',
    weight: 20,
    check: (user, detail) =>
      !!(user.name && detail?.phone && detail?.headline && detail?.location),
    missing: (user, detail) => {
      const m = []
      if (!user.name)        m.push('Full name')
      if (!detail?.phone)    m.push('Phone number')
      if (!detail?.headline) m.push('Headline / title')
      if (!detail?.location) m.push('Location')
      return m
    },
  },
  {
    key: 'education',
    label: 'Education',
    description: 'At least one education entry',
    weight: 20,
    check: (_u, detail) => !!(detail?.education?.length),
    missing: (_u, detail) =>
      detail?.education?.length ? [] : ['Education details (degree, institution)'],
  },
  {
    key: 'skills',
    label: 'Skills',
    description: 'At least 3 skills added',
    weight: 20,
    check: (_u, _d, skills) => skills?.length >= 3,
    missing: (_u, _d, skills) =>
      (skills?.length ?? 0) >= 3 ? [] : [`${3 - (skills?.length ?? 0)} more skill(s) required`],
  },
  {
    key: 'summary',
    label: 'About / Summary',
    description: 'A short bio (≥ 50 characters)',
    weight: 15,
    check: (_u, detail) => (detail?.summary?.trim()?.length ?? 0) >= 50,
    missing: (_u, detail) =>
      (detail?.summary?.trim()?.length ?? 0) >= 50 ? [] : ['Write a summary (at least 50 characters)'],
  },
  {
    key: 'cv',
    label: 'Resume / CV',
    description: 'Upload a PDF/DOCX resume',
    weight: 15,
    check: (_u, detail) => !!(detail?.cvUrl),
    missing: (_u, detail) =>
      detail?.cvUrl ? [] : ['Upload your resume (PDF/DOCX)'],
  },
  {
    key: 'links',
    label: 'Portfolio Links',
    description: 'GitHub or portfolio URL',
    weight: 10,
    check: (_u, detail) => !!(detail?.githubUrl || detail?.portfolioUrl || detail?.linkedinUrl),
    missing: (_u, detail) =>
      (detail?.githubUrl || detail?.portfolioUrl || detail?.linkedinUrl)
        ? []
        : ['Add GitHub, LinkedIn or portfolio URL'],
  },
]

/**
 * Returns the completeness report for a user.
 *
 * @param {object} user         - Prisma User row (must include .name)
 * @param {object|null} detail  - Prisma ProfileDetail row with education, experience, certifications
 * @param {Array}  skills       - Array of user's UserSkill rows (or just skill names)
 * @returns {{ percentage: number, isComplete: boolean, sections: Array, missingFields: string[] }}
 */
function computeCompleteness(user, detail, skills = []) {
  let earned = 0
  const sections = []
  const allMissing = []

  for (const section of SECTIONS) {
    const done = section.check(user, detail, skills)
    const missing = done ? [] : section.missing(user, detail, skills)
    earned += done ? section.weight : 0
    sections.push({ key: section.key, label: section.label, description: section.description, weight: section.weight, done, missing })
    if (!done) allMissing.push(...missing)
  }

  return {
    percentage: earned,
    isComplete: earned >= 70, // 70% = minimum to apply (same as Internshala)
    sections,
    missingFields: allMissing,
  }
}

module.exports = { computeCompleteness, SECTIONS }
