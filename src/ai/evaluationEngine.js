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

async function generatePhase2Questions(projectContext, questionCount = 6, difficultyDesc = '', difficulty = 'medium') {
  return await callAIForJSON({
    systemPrompt: PROMPTS.PHASE2_QUESTION_GEN_SYSTEM(questionCount, difficultyDesc, difficulty),
    userPrompt: PROMPTS.PHASE2_QUESTION_GEN_USER(projectContext),
    maxTokens: 1800,
    temperature: 0.4
  })
}

async function evaluatePhase2Answers(context) {
  return await callAIForJSON({
    systemPrompt: PROMPTS.PHASE2_ANSWER_EVAL_SYSTEM(context.difficulty),
    userPrompt: PROMPTS.PHASE2_ANSWER_EVAL_USER(context),
    maxTokens: 1500,
    temperature: 0.2
  })
}

// One batched AI call per graded Phase 1 attempt — takes only the questions
// the candidate got WRONG and returns a short explanation for each (why the
// correct option is right / why their pick was a common mistake). Kept
// separate from grading itself (which uses the QuestionBank answer key, no
// AI needed) so a slow/failed AI call never blocks the actual score.
async function generatePhase1Explanations(wrongItems) {
  if (!Array.isArray(wrongItems) || wrongItems.length === 0) return []
  const result = await callAIForJSON({
    systemPrompt: PROMPTS.PHASE1_EXPLAIN_SYSTEM,
    userPrompt: PROMPTS.PHASE1_EXPLAIN_USER(wrongItems),
    maxTokens: 1200,
    temperature: 0.2
  })
  return Array.isArray(result?.explanations) ? result.explanations : []
}

module.exports = { evaluateProject, generatePhase2Questions, evaluatePhase2Answers, generatePhase1Explanations }
