const express = require('express')
const router = express.Router()
const recruiterAuth = require('../middleware/recruiterAuth')
const validate = require('../middleware/validate')
const { createCompanySchema, updateCompanySchema, submitVerificationSchema } = require('../validators/companyValidators')
const { getMyCompany, createCompany, updateCompany, submitForVerification } = require('../controllers/companyController')

router.get('/me',                      recruiterAuth, getMyCompany)
router.post('/',                       recruiterAuth, validate(createCompanySchema), createCompany)
router.put('/me',                      recruiterAuth, validate(updateCompanySchema), updateCompany)
router.post('/me/submit-verification', recruiterAuth, validate(submitVerificationSchema), submitForVerification)

module.exports = router