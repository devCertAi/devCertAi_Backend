]nding                 — all apps awaiting recruiter action
 */

const express = require('express')
const router = express.Router()
const validate = require('../middleware/validate')
const recruiterAuth = require('../middleware/recruiterAuth')
const { createJobPostingSchema, updateJobPostingSchema, manualAdvanceSchema, manualRejectSchema, sendReminderSchema } = require('../validators/pipelineValidators')

const {
  createPosting, getMyPostings, getPosting, updatePosting, closePosting, clonePosting,
  getPostingApplications, getApplicationDetail, triggerRanking, getPostingStats,
  getRecruiterOverview, getThresholdSuggestions
} = require('../controllers/jobPostingController')

const { getRecruiterProfile } = require('../controllers/recruiterAuthController')
const { sendMessage } = require('../controllers/messageController')
const {
  hireCandidate, rejectCandidate, advanceApplication, sendStageReminder,
  sendAssignment, sendTestLink, getRankedList, getManualPending
} = require('../controllers/hireController')

router.use(recruiterAuth)

// ── Overview ──────────────────────────────────────────────────────────────────
router.get('/overview', getRecruiterOverview)

// ── Manual pending — all apps awaiting recruiter action ───────────────────────
router.get('/manual-pending', getManualPending)

// ── Postings ──────────────────────────────────────────────────────────────────
router.post('/postings',         validate(createJobPostingSchema), createPosting)
router.get('/postings',          getMyPostings)
router.get('/postings/:id',      getPosting)
router.patch('/postings/:id',    validate(updateJobPostingSchema), updatePosting)
router.patch('/postings/:id/close', closePosting)
router.post('/postings/:id/clone',  clonePosting)

// ── Per-posting analytics ─────────────────────────────────────────────────────
router.get('/postings/:id/applications',          getPostingApplications)
router.get('/postings/:id/stats',                 getPostingStats)
router.get('/postings/:id/threshold-suggestions', getThresholdSuggestions)
router.post('/postings/:id/rank',                 triggerRanking)
router.get('/postings/:id/ranked',                getRankedList)

// ── Single application reads ──────────────────────────────────────────────────
router.get('/applications/:id',             getApplicationDetail)
router.post('/applications/:id/messages',   sendMessage)

// ── Hire pipeline actions ─────────────────────────────────────────────────────
router.patch('/applications/:id/hire',           hireCandidate)
router.patch('/applications/:id/reject',         validate(manualRejectSchema), rejectCandidate)

// Manual mode controls
router.post('/applications/:id/advance',         validate(manualAdvanceSchema), advanceApplication)
router.post('/applications/:id/send-reminder',   validate(sendReminderSchema), sendStageReminder)

// Utility: (re)send assignment / exam link
router.post('/applications/:id/send-assignment', sendAssignment)
router.post('/applications/:id/send-test',       sendTestLink)

// ── Profile ───────────────────────────────────────────────────────────────────
router.get('/profile', getRecruiterProfile)

module.exports = {
  createPosting, getMyPostings, getPosting, updatePosting, closePosting, clonePosting,
  getPostingApplications, getApplicationDetail, triggerRanking, getPostingStats,
  getRecruiterOverview, getThresholdSuggestions
}``