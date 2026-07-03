const { callAIForJSON } = require('./aiProvider')
const PROMPTS = require('./promptTemplates')
const { analyzeGithubRepo } = require('./githubAnalyzer')
const { analyzeZip } = require('./zipAnalyzer')
const { buildReport } = require('./reportBuilder')

async function evaluateProject(project) {
  console.log('[EvalEngine] Starting evaluation for:', project.id)
  console.log('[EvalEngine] githubUrl:', project.githubUrl)
  console.log('[EvalEngine] zipFileUrl:', project.zipFileUrl)
  console.log('[EvalEngine] liveUrl:', project.liveUrl)

  let context = {
    title: project.title,
    domain: project.domain,
    description: project.description,
    fileTree: [],
    fileContents: '',
    techStack: []
  }

  if (project.githubUrl) {
    console.log('[EvalEngine] Analyzing GitHub repo...')
    const analyzed = await analyzeGithubRepo(project.githubUrl)
    Object.assign(context, analyzed)
    console.log('[EvalEngine] GitHub analysis done')
  } else if (project.zipFileUrl) {
    console.log('[EvalEngine] Analyzing ZIP...')
    const analyzed = await analyzeZip(project.zipFileUrl)
    Object.assign(context, analyzed)
    console.log('[EvalEngine] ZIP analysis done')
  } else if (project.liveUrl) {
    console.log('[EvalEngine] Live URL only mode')
    context.fileContents = `Live URL: ${project.liveUrl}\nNote: No source code available. Evaluate based on description only.`
  }

  console.log('[EvalEngine] Calling AI...')
  const rawResult = await callAIForJSON({
    systemPrompt: PROMPTS.PROJECT_EVALUATION_SYSTEM,
    userPrompt: PROMPTS.PROJECT_EVALUATION_USER(context),
    maxTokens: 2000,
    temperature: 0.2
  })
  console.log('[EvalEngine] AI call done, building report...')

  return buildReport(rawResult, project)
}

async function generatePhase2Questions(projectContext) {
  return await callAIForJSON({
    systemPrompt: PROMPTS.PHASE2_QUESTION_GEN_SYSTEM,
    userPrompt: PROMPTS.PHASE2_QUESTION_GEN_USER(projectContext),
    maxTokens: 1500,
    temperature: 0.4
  })
}

async function evaluatePhase2Answers(context) {
  return await callAIForJSON({
    systemPrompt: PROMPTS.PHASE2_ANSWER_EVAL_SYSTEM,
    userPrompt: PROMPTS.PHASE2_ANSWER_EVAL_USER(context),
    maxTokens: 1500,
    temperature: 0.2
  })
}

module.exports = { evaluateProject, generatePhase2Questions, evaluatePhase2Answers }
