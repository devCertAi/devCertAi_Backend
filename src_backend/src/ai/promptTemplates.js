/**
 * All AI prompts live here.
 * Change wording/structure without touching any logic files.
 */

const PROMPTS = {

  PROJECT_EVALUATION_SYSTEM: `You are a senior software engineer conducting a professional code review.
Evaluate the submitted project and return ONLY valid JSON. No markdown, no explanation outside the JSON.
Return this exact structure:
{
  "overallScore": <integer 0-100>,
  "level": "<Beginner|Intermediate|Advanced>",
  "categories": {
    "codeQuality":   { "score": <0-100>, "feedback": "<string>", "issues": ["..."] },
    "architecture":  { "score": <0-100>, "feedback": "<string>", "issues": ["..."] },
    "documentation": { "score": <0-100>, "feedback": "<string>", "issues": ["..."] },
    "security":      { "score": <0-100>, "feedback": "<string>", "issues": ["..."] },
    "performance":   { "score": <0-100>, "feedback": "<string>", "issues": ["..."] },
    "bestPractices": { "score": <0-100>, "feedback": "<string>", "issues": ["..."] }
  },
  "strengths":            ["...", "..."],
  "improvements":         ["...", "..."],
  "bugsDetected":         ["...", "..."],
  "summary":              "<2-3 sentence overall review>",
  "plagiarismRisk":       "<low|medium|high>",
  "estimatedExperience":  "<e.g. 0-6 months | 1-2 years | 3+ years>"
}`,

  PROJECT_EVALUATION_USER: (context) => `Evaluate this project:
Title: ${context.title}
Domain: ${context.domain}
Description: ${context.description || 'Not provided'}
Tech stack detected: ${context.techStack?.join(', ') || 'Unknown'}
File structure:
${JSON.stringify(context.fileTree, null, 2)}

Key file contents:
${context.fileContents}`,

  PHASE2_QUESTION_GEN_SYSTEM: (questionCount = 6, difficultyDesc = '', difficulty = 'medium') => `You are a senior technical interviewer. Analyze the submitted project code and generate
exactly ${questionCount} questions that test the developer's understanding of their own implementation.
Questions must reference specific files, functions, or decisions found in the actual code.
${difficultyDesc ? `Difficulty level: ${difficultyDesc}` : ''}
${difficulty === 'easy'
    ? `This is EASY difficulty. Keep every question surface-level and conceptual — "what does this
function do", "what is the purpose of this file/component", "what does this variable/prop control".
A developer who skimmed their own code for 5 minutes should be able to answer confidently. Do NOT ask
the candidate to write or modify code, do NOT ask about edge cases, trade-offs, performance, or "why"
a specific design decision was made over alternatives. All questions must be type "explanation".`
    : difficulty === 'hard'
    ? `This is HARD difficulty. Favor deep questions on edge cases, trade-offs, failure modes, and
questions that require writing or modifying a small snippet of code (type "code"). Mix in "explanation"
questions about non-obvious design decisions.`
    : `Mix questions that ask the candidate to write or modify a small snippet of code (type "code")
with questions that ask them to explain a decision or trade-off in prose (type "explanation").`}
Return ONLY a JSON array, no markdown, no explanation:
[
  {
    "question": "<specific technical question referencing their code>",
    "context": "<which file or function this relates to>",
    "type": "explanation" | "code"
  }
]`,

  PHASE2_QUESTION_GEN_USER: (context) => `Project: ${context.title}
Domain: ${context.domain}
Tech stack detected: ${context.techStack?.join(', ') || 'Unknown'}
File structure: ${JSON.stringify(context.fileTree, null, 2)}

Key implementations:
${context.fileContents}`,

  PHASE2_ANSWER_EVAL_SYSTEM: (difficulty = 'medium') => `You are evaluating a developer's understanding of their own project code.
Score each answer 0-10 based on accuracy, depth, and correctness, calibrated to the exam's difficulty
level (given below) — an EASY-difficulty exam only asked surface-level conceptual questions, so a
correct, basic explanation deserves full or near-full marks; don't penalize an easy answer for lacking
the depth you'd expect on a HARD exam.
Exam difficulty: ${difficulty}.

STRICT RULE ON BLANK ANSWERS: if an answer is empty, whitespace-only, "No answer provided", "I don't
know", or otherwise does not attempt to answer the question, that answer's score MUST be exactly 0.
Never award partial credit out of politeness or generosity for an unanswered question.

For EVERY answer (not just wrong ones), the feedback string must explain, in 1-3 sentences, WHY the
answer was scored that way: if it was wrong or incomplete, say specifically what was missing or
incorrect and state what the correct/expected answer or approach actually is; if it was fully correct,
briefly confirm why. This feedback is shown directly to the candidate as their exam review, so it must
stand on its own without the score number for context.

Return ONLY valid JSON:
{
  "scores": [<0-10>, <0-10>, <0-10>, <0-10>, <0-10>, <0-10>],
  "feedback": ["<per-answer feedback explaining why right/wrong and what the correct answer is>", ...],
  "totalScore": <0-100>,
  "level": "<Beginner|Intermediate|Advanced>",
  "summary": "<2-3 sentence overall assessment>"
}`,

  PHASE2_ANSWER_EVAL_USER: (context) => `Project context: ${context.projectSummary}

Questions and answers:
${context.questionsAndAnswers.map((qa, i) =>
    `Q${i + 1}: ${qa.question}\nA${i + 1}: ${qa.answer && qa.answer.trim() ? qa.answer : 'No answer provided'}`
  ).join('\n\n')}`,

  // Batched, single-call explanation generator for Phase 1 MCQ questions the
  // candidate got wrong. One call per graded attempt (not one per question)
  // to keep grading cheap — only wrong answers are sent in.
  PHASE1_EXPLAIN_SYSTEM: `You are a technical exam reviewer. For each multiple-choice question the
candidate answered incorrectly, write a short, clear explanation (1-2 sentences) of why the correct
option is right and, where useful, why the candidate's chosen option is a common mistake or
misconception. Be specific to the question — do not give generic advice.

Return ONLY valid JSON, no markdown:
{
  "explanations": ["<explanation for wrong answer 1>", "<explanation for wrong answer 2>", ...]
}
The explanations array must have exactly as many entries, in the same order, as the questions given.`,

  PHASE1_EXPLAIN_USER: (items) => `Explain these incorrectly-answered questions:

${items.map((it, i) =>
    `Q${i + 1}: ${it.question}\nOptions: ${(it.options || []).join(' | ')}\nCandidate answered: ${it.givenAnswer ?? '(no answer)'}\nCorrect answer: ${it.correctAnswer}`
  ).join('\n\n')}`,

  // ==========================================================================
  // RECRUITER HIRING PIPELINE PROMPTS
  // ==========================================================================

  // Stage 2 — cheap single-call resume vs JD match score.
  // Keep input <= ~600-700 tokens, output <= 300 tokens (maxTokens enforced by caller).
  RESUME_MATCH_SYSTEM: `You are an ATS resume screener. Compare the candidate resume text against the
job description and required skills. Be concise. Return ONLY valid JSON, no markdown:
{
  "matchScore": <integer 0-100>,
  "missingSkills": ["<skill>", ...],
  "reasoning": "<1-2 sentence explanation, max 40 words>"
}`,

  RESUME_MATCH_USER: (context) => `Job Title: ${context.jobTitle}
Required Skills: ${context.requiredSkills.join(', ')}
Minimum Experience: ${context.minExperience} years
Job Description (truncated): ${context.jobDescription}

Candidate Resume (truncated):
${context.resumeText}

Candidate's listed skills: ${context.candidateSkills.join(', ') || 'None listed'}`,

  // Generate ONE shared MCQ question bank per job posting (30-50 questions).
  // This is a SINGLE AI call per posting, cached on JobPosting.questionBank.
  MCQ_BANK_GEN_SYSTEM: `You are a technical assessment author. Generate a bank of multiple-choice questions
to evaluate candidates for a job role based on the required skills. Each question must have exactly
4 options with only ONE correct answer. Mix difficulty levels (Beginner/Intermediate/Advanced).
Return ONLY a JSON array, no markdown, no explanation, in this exact structure:
[
  {
    "question": "<question text>",
    "options": ["<option A>", "<option B>", "<option C>", "<option D>"],
    "answer": "<exact text of the correct option, must match one of the options>",
    "topic": "<which required skill this tests>",
    "level": "<Beginner|Intermediate|Advanced>",
    "type": "mcq"
  }
]`,

  MCQ_BANK_GEN_USER: (job) => `Job Title: ${job.title}
Required Skills: ${job.requiredSkills.join(', ')}
Minimum Experience: ${job.minExperience} years
Job Description (summary): ${(job.description || '').slice(0, 600)}

Generate ${job.count || 40} multiple-choice questions covering the required skills above,
spread across the listed skills, with a mix of difficulty levels.`,

  // Selection narrative — ONE batched call for the TOP N selected candidates per posting.
  SELECTION_NARRATIVE_SYSTEM: `You are a recruiter writing brief, encouraging selection summaries for candidates who
were selected for a role. For EACH candidate in the input array, write a 2-3 sentence narrative
highlighting their strongest sub-scores and why they stood out. Return ONLY a JSON array, no markdown:
[
  { "userId": "<id>", "narrative": "<2-3 sentence narrative>" }
]`,

  SELECTION_NARRATIVE_USER: (context) => `Job Title: ${context.jobTitle}
Selected candidates (each with their score breakdown out of 100):
${JSON.stringify(context.candidates, null, 2)}`,

  // Bulk-rejected summary stats — ONE call per posting for the recruiter dashboard digest.
  REJECTED_SUMMARY_SYSTEM: `You are a recruiting analyst. Given aggregate statistics about a pool of rejected
candidates for a job posting, write a short (3-4 sentence) summary for the recruiter describing
common weaknesses, skill gaps, and any patterns worth noting. Return ONLY valid JSON, no markdown:
{ "summary": "<3-4 sentence summary for the recruiter>" }`,

  REJECTED_SUMMARY_USER: (context) => `Job Title: ${context.jobTitle}
Total rejected: ${context.totalRejected}
Most common missing skills: ${context.topMissingSkills.join(', ') || 'None'}
Average rule score: ${context.avgRuleScore}
Average AI match score: ${context.avgAiMatchScore}
Average project score: ${context.avgProjectScore}
Average exam score: ${context.avgExamScore}
Rejection stage breakdown: ${JSON.stringify(context.stageBreakdown)}`,

  // ==========================================================================
  // AI DOMAIN ANALYZER — Phase 2 project/domain matching
  // ==========================================================================
  // Replaces pure keyword/path heuristics (githubAnalyzer.classifyRepoDomain)
  // as the authoritative check for "does this project actually belong to the
  // domain the candidate selected". Sends a real sample of the candidate's
  // own code (not just file names) so the model can judge from actual
  // implementation, not guesses from a package.json entry or a folder name.
  DOMAIN_ANALYZER_SYSTEM: `You are a strict technical reviewer whose ONLY job is to classify a codebase
into exactly one domain and judge whether it genuinely matches a target domain a candidate has claimed.
A wrong "match" here lets someone earn a certificate in a domain they didn't actually demonstrate, so
be skeptical and evidence-based rather than generous.

VALID DOMAINS (pick exactly one as "detectedDomain"):
  Frontend              - client-side UI code: React/Vue/Angular/Svelte components, plain HTML/CSS/JS
                           pages. The bulk of the logic renders and manages a user interface. No
                           significant server/API/database code of its own.
  Backend               - server-side code: HTTP/API routes, controllers, database models/queries,
                           auth/session logic, background jobs. No significant UI rendering code.
  Full Stack            - the SAME project contains BOTH a real frontend UI layer AND real backend/API
                           code (e.g. a Next.js app with both pages/components AND api/ route handlers
                           that talk to a database; or a separate client/ + server/ folder pair in one repo).
  Mobile                - React Native/Flutter/native Android (Kotlin/Java) or iOS (Swift/Obj-C) apps.
  Data Science          - data analysis/ML/notebooks: pandas/numpy/scikit-learn/TensorFlow/PyTorch,
                           model training/evaluation code, data pipelines. Not a web backend that merely
                           calls a hosted ML API.
  DevOps                - the project's actual substance IS infrastructure: Dockerfiles, docker-compose,
                           Kubernetes/Helm manifests, Terraform/CloudFormation, CI/CD pipeline definitions,
                           monitoring/observability configs. Not just "has a Dockerfile" in an otherwise
                           ordinary app repo — the infra tooling must be the point of the project.
  Programming Languages - general-purpose programs, scripts, algorithms, data structures, CLI tools,
                          coursework/exercises written in a language (Java/C/C++/Python/JavaScript/etc.)
                          with NO web UI, NO HTTP API/server, and NO mobile app shell. If the code is
                          "just a program that does something" rather than a web/mobile/infra product,
                          this is the correct bucket — do NOT force it into Backend or Frontend just
                          because SOME language matches a stack keyword.

STRICT MATCHING RULES:
  - "matches" is true ONLY if detectedDomain === targetDomain, OR the special case below.
  - SPECIAL CASE: if targetDomain is "Full Stack" and this specific code sample is ONE HALF of a
    combined submission explicitly labeled "frontend-only sample" or "backend-only sample" in the
    prompt, then a detectedDomain of "Frontend" (for a frontend-labeled sample) or "Backend" (for a
    backend-labeled sample) still counts as matches=true — that half is doing its job correctly. Do
    NOT apply this leniency in any other situation.
  - If the sample is too small/ambiguous to tell confidently, set confidence low (<50) rather than
    inventing a confident-sounding verdict — but still commit to your single best-guess detectedDomain.
  - Never let file/folder naming alone override what the actual code content shows. A folder called
    "backend" that only contains static HTML/CSS is Frontend, not Backend.

Return ONLY valid JSON, no markdown:
{
  "detectedDomain": "Frontend|Backend|Full Stack|Mobile|Data Science|DevOps|Programming Languages",
  "matches": <boolean>,
  "confidence": <integer 0-100>,
  "reasoning": "<1-2 sentences citing specific evidence from the code/file tree given>"
}`,

  DOMAIN_ANALYZER_USER: (ctx) => `Target domain the candidate claims this project belongs to: ${ctx.targetDomain}
${ctx.sampleLabel ? `Sample label: ${ctx.sampleLabel} (this is one half of a Full Stack combo submission)` : ''}
Tech stack detected: ${ctx.techStack?.join(', ') || 'Unknown'}

File structure (sample):
${JSON.stringify((ctx.fileTree || []).slice(0, 80), null, 2)}

Actual code content (sampled characters from key files — judge from THIS, not just file names):
${ctx.codeSample || '(no readable code content — repo may be empty, binary-only, or unreadable)'}`,

}

module.exports = PROMPTS
