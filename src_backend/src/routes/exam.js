const express = require('express')
const router = express.Router()
const auth = require('../middleware/userAuth')
const validate = require('../middleware/validate')
const { examLimiter } = require('../middleware/rateLimiter')
const { startExamSchema, startDemoExamSchema, submitAnswerSchema, violationSchema } = require('../validators/examValidators')
const {
  startExam, startDemoExam, getAttempt, submitAnswer, submitExam,
  reportTabSwitch, reportViolation, heartbeat,
  submitPhase2Project, getExamHistory, getDomains, checkGithubDomain, upload
} = require('../controllers/examController')

// Exam-specific limiter (generous — see rateLimiter.js) instead of the
// strict app-wide globalLimiter, which a single exam session's heartbeats +
// autosaves would otherwise exhaust on its own mid-exam.
router.use(examLimiter)

router.post('/check-github-domain',           auth, checkGithubDomain)

router.post('/start',                         auth, validate(startExamSchema), startExam)
router.post('/demo/start',                    auth, validate(startDemoExamSchema), startDemoExam)
router.get('/history',                        auth, getExamHistory)
router.get('/domains',                        auth, getDomains)
router.get('/attempt/:id',                    auth, getAttempt)
router.post('/attempt/:id/answer',            auth, validate(submitAnswerSchema), submitAnswer)
router.post('/attempt/:id/submit',            auth, submitExam)
router.post('/attempt/:id/tab-switch',        auth, reportTabSwitch)
router.post('/attempt/:id/violation',         auth, validate(violationSchema), reportViolation)
router.post('/attempt/:id/heartbeat',         auth, heartbeat)
// accepts multipart/form-data (zipFile, OR frontendZip+backendZip for Full
// Stack) OR a plain JSON/form body with githubUrl (OR frontendGithubUrl+
// backendGithubUrl for Full Stack)
router.post(
  '/attempt/:id/phase2/project',
  auth,
  upload.fields([
    { name: 'zipFile', maxCount: 1 },
    { name: 'frontendZip', maxCount: 1 },
    { name: 'backendZip', maxCount: 1 },
  ]),
  submitPhase2Project
)

module.exports = router