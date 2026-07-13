const express = require('express')
const router = express.Router()
const auth = require('../middleware/userAuth')
const validate = require('../middleware/validate')
const { submitAssignmentSchema } = require('../validators/pipelineValidators')
const {
  getMyApplications, getApplication, submitAssignment, startPipelineExam, upload
} = require('../controllers/applicationController')
const { getMessages } = require('../controllers/messageController')

router.get('/',                         auth, getMyApplications)
router.get('/:id',                      auth, getApplication)
router.post('/:id/submit-assignment',   auth, upload.single('zipFile'), validate(submitAssignmentSchema), submitAssignment)
router.post('/:id/exam/start',          auth, startPipelineExam)
router.get('/:id/messages',             auth, getMessages)

module.exports = router