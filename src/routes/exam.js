const express = require('express')
const router = express.Router()
const auth = require('../middleware/userAuth')
const validate = require('../middleware/validate')
const { startExamSchema, startDemoExamSchema, submitAnswerSchema, violationSchema } = require('../validators/examValidators')
const {
  startExam, startDemoExam, getAttempt, submitAnswer, submitExam,
  reportTabSwitch, reportViolation, heartbeat,
  submitPhase2Project, getExamHistory, getDomains
} = require('../controllers/examController')

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
router.post('/attempt/:id/phase2/project',    auth, submitPhase2Project)

module.exports = router