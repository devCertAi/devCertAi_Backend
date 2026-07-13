const express = require('express')
const router = express.Router()
const auth = require('../middleware/userAuth')
const premium = require('../middleware/premium')
const { evalLimiter, sizeEstimateLimiter } = require('../middleware/rateLimiter')
const validate = require('../middleware/validate')
const { submitProjectSchema } = require('../validators/projectValidators')
const {
  submitProject, getUserProjects, getProject,
  getProjectReport, reEvaluate, deleteProject,
  validateGithub, estimateSize, upload
} = require('../controllers/projectController')

router.get('/validate-github',  auth, validateGithub)
// Preview the size tier & credit cost before submitting. Takes the same
// three source shapes as /submit (multipart so a zipFile can be included).
router.post('/estimate-size',   auth, sizeEstimateLimiter, upload.single('zipFile'), estimateSize)
router.post('/submit',          auth, evalLimiter, upload.single('zipFile'), validate(submitProjectSchema), submitProject)
router.get('/',                 auth, getUserProjects)
router.get('/:id',              auth, getProject)
router.get('/:id/report',       auth, premium, getProjectReport)
router.post('/:id/re-evaluate', auth, evalLimiter, reEvaluate)
router.delete('/:id',           auth, deleteProject)

module.exports = router