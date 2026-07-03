const express = require('express')
const router = express.Router()
const auth = require('../middleware/userAuth')
const premium = require('../middleware/premium')
const { evalLimiter } = require('../middleware/rateLimiter')
const validate = require('../middleware/validate')
const { submitProjectSchema } = require('../validators/projectValidators')
const {
  submitProject, getUserProjects, getProject,
  getProjectReport, reEvaluate, deleteProject,
  validateGithub, upload
} = require('../controllers/projectController')

router.get('/validate-github',  auth, validateGithub)
router.post('/submit',          auth, evalLimiter, upload.single('zipFile'), validate(submitProjectSchema), submitProject)
router.get('/',                 auth, getUserProjects)
router.get('/:id',              auth, getProject)
router.get('/:id/report',       auth, premium, getProjectReport)
router.post('/:id/re-evaluate', auth, evalLimiter, reEvaluate)
router.delete('/:id',           auth, deleteProject)

module.exports = router