// src/routes/apply.js  (replace existing file)
const express = require('express')
const router = express.Router()
const auth = require('../middleware/userAuth')
const validate = require('../middleware/validate')
const { applySchema } = require('../validators/pipelineValidators')
const { getPublicPosting, submitApplication } = require('../controllers/jobPostingController')
const { getApplyPreflight } = require('../controllers/profileCompletenessController')
const multer = require('multer')

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } })

// GET /apply/:slug              — public: posting info (no auth needed)
router.get('/:slug', getPublicPosting)

// GET /apply/:slug/preflight    — auth: completeness check + prefill data
router.get('/:slug/preflight', auth, getApplyPreflight)

// POST /apply/:slug             — auth: submit (resume upload now OPTIONAL if profile has CV)
router.post('/:slug', auth, upload.single('resume'), validate(applySchema), submitApplication)

module.exports = router
