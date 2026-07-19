/**
 * pythonPipelineClient.js
 */

const axios = require('axios')
const { analyzeGithubRepo } = require('./githubAnalyzer')
const { analyzeZip } = require('./zipAnalyzer')
const toolAnalysis = require('../services/toolAnalysis')

const PYTHON_URL = process.env.PYTHON_PIPELINE_URL || 'http://localhost:8001'

const client = axios.create({
  baseURL: PYTHON_URL,
  timeout: 180000,
  headers: { 'Content-Type': 'application/json' }
})

async function evaluateProject(project) {
  console.log('[PythonPipeline] Starting for project:', project.id)

  let fileTree = []
  let fileContents = ''
  let techStack = []

  if (project.githubUrl) {
    console.log('[PythonPipeline] Analyzing GitHub repo...')
    const analyzed = await analyzeGithubRepo(project.githubUrl)

    fileTree = analyzed.fileTree
    fileContents = analyzed.fileContents
    techStack = analyzed.techStack

    console.log('[PythonPipeline] GitHub analysis done')
  } else if (project.zipFileUrl) {
    console.log('[PythonPipeline] Analyzing ZIP...')

    const analyzed = await analyzeZip(project.zipFileUrl)

    fileTree = analyzed.fileTree
    fileContents = analyzed.fileContents
    techStack = analyzed.techStack

    console.log('[PythonPipeline] ZIP analysis done')
  } else if (project.liveUrl) {
    console.log('[PythonPipeline] Live URL only mode')

    fileContents = `Live URL: ${project.liveUrl}\nNote: No source code available.`
  }

  console.log('\n========== REQUEST TO PYTHON ==========')
  console.log('Project ID:', project.id)
  console.log('Title:', project.title)
  console.log('Domain:', project.domain)
  console.log('File Tree Count:', fileTree.length)
  console.log('Tech Stack:', techStack)
  console.log('File Content Length:', fileContents?.length || 0)

  // Run the deterministic static-analysis layer (ESLint/Ruff, Semgrep,
  // Gitleaks, Trivy, jscpd, Lizard, signal-file domain detection) BEFORE
  // calling the AI pipeline, so the AI receives verified tool output
  // instead of guessing everything from raw code. This never blocks or
  // fails the evaluation — any staging/tool error just results in an
  // empty-but-valid toolResults object, and the AI pipeline falls back to
  // its own judgment exactly as before.
  let toolResults = {}
  try {
    console.log('[toolAnalysis] Running static analysis for project:', project.id)
    toolResults = await toolAnalysis.analyzeProject(project)
    console.log('[toolAnalysis] Done:', JSON.stringify(toolResults.meta || {}))
  } catch (err) {
    console.error('[toolAnalysis] analyzeProject failed (continuing without it):', err.message)
    toolResults = {}
  }

  const { data } = await client.post('/evaluate', {
    project: {
      id: project.id,
      title: project.title,
      domain: project.domain,
      description: project.description || ''
    },
    codeContext: {
      title: project.title,
      domain: project.domain,
      description: project.description || '',
      fileTree,
      fileContents,
      techStack,
      toolResults
    }
  })

  console.log('\n========== RAW PYTHON RESPONSE ==========')
  console.log(JSON.stringify(data, null, 2))

  if (!data.success) {
    console.error('\n========== PYTHON ERROR ==========')
    console.error(JSON.stringify(data, null, 2))
    throw new Error(`Pipeline error: ${JSON.stringify(data)}`)
  }

  const result = data.data

  console.log('\n========== RESULT.DATA ==========')
  console.log(JSON.stringify(result, null, 2))

  const report = result.report || {}

  console.log('\n========== RESULT.REPORT ==========')
  console.log(JSON.stringify(report, null, 2))

  const finalResponse = {
    ...report,
    bugReport: result.bugReport || {},
    architectureReport: result.architectureReport || {},
    plagiarismReport: result.plagiarismReport || {},
    fastScores: result.fastScores || {},
    bestPracticesReport: result.bestPracticesReport || {},
    improvementsReport: result.improvementsReport || {},
    domainReport: result.domainReport || {},
    questions: result.questions || {},
    // Defensive defaults — report.* already carries these once the Python
    // pipeline synthesizes them, but this guards against an older/rolled-
    // back pipeline version that doesn't produce them yet.
    toolResults: report.toolResults || toolResults || {},
    findingsSource: report.findingsSource || {},
    toolsUsed: report.toolsUsed || (toolResults?.meta?.toolsRun || []),
    methodology: report.methodology || 'AI code review',
    // Raw file tree + detected tech stack, so the frontend can render an
    // actual code-structure view instead of only text findings. Capped at
    // 100 entries upstream in githubAnalyzer/zipAnalyzer already.
    fileTree,
    techStack,
  }

  console.log('\n========== RETURNING TO NODE WORKER ==========')
  console.log(JSON.stringify(finalResponse, null, 2))

  return finalResponse
}

async function generatePhase2Questions(projectContext) {
  const { data } = await client.post('/phase2/questions', {
    codeContext: {
      title: projectContext.title,
      domain: projectContext.domain,
      fileTree: projectContext.fileTree || [],
      fileContents: projectContext.fileContents || '',
      techStack: projectContext.techStack || []
    },
    bugReport: projectContext.bugReport || {},
    architectureReport: projectContext.architectureReport || {},
    fastScores: projectContext.fastScores || {}
  })

  return data.data
}

async function evaluatePhase2Answers(context) {
  const { data } = await client.post('/phase2/answers', {
    projectSummary: context.projectSummary || '',
    detectedLevel: context.detectedLevel || 'Intermediate',
    questionsAndAnswers: context.questionsAndAnswers || []
  })

  return data.data
}

module.exports = {
  evaluateProject,
  generatePhase2Questions,
  evaluatePhase2Answers
}