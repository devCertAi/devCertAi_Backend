/**
 * Transforms raw AI evaluation result into a structured report.
 * Validates and sanitizes all fields.
 */

function clampScore(score) {
  const n = parseInt(score)
  if (isNaN(n)) return 50
  return Math.max(0, Math.min(100, n))
}

function sanitizeLevel(level) {
  const valid = ['Beginner', 'Intermediate', 'Advanced']
  return valid.includes(level) ? level : 'Beginner'
}

function buildReport(rawResult, project) {
  const categories = rawResult.categories || {}

  const getCat = (key) => ({
    score: clampScore(categories[key]?.score ?? 50),
    feedback: categories[key]?.feedback || 'No feedback provided.',
    issues: Array.isArray(categories[key]?.issues) ? categories[key].issues : []
  })

  const report = {
    overallScore: clampScore(rawResult.overallScore),
    level: sanitizeLevel(rawResult.level),
    categories: {
      codeQuality:   getCat('codeQuality'),
      architecture:  getCat('architecture'),
      documentation: getCat('documentation'),
      security:      getCat('security'),
      performance:   getCat('performance'),
      bestPractices: getCat('bestPractices')
    },
    strengths:           Array.isArray(rawResult.strengths) ? rawResult.strengths : [],
    improvements:        Array.isArray(rawResult.improvements) ? rawResult.improvements : [],
    bugsDetected:        Array.isArray(rawResult.bugsDetected) ? rawResult.bugsDetected : [],
    summary:             rawResult.summary || 'Evaluation complete.',
    plagiarismRisk:      ['low', 'medium', 'high'].includes(rawResult.plagiarismRisk) ? rawResult.plagiarismRisk : 'low',
    estimatedExperience: rawResult.estimatedExperience || 'Unknown',
    projectId:           project.id,
    evaluatedAt:         new Date().toISOString()
  }

  return report
}

module.exports = { buildReport }
