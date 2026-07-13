const express = require('express')
const router = express.Router()
const auth = require('../middleware/userAuth')
const { verifyCertificate, getUserCertificates, downloadCertificate, toggleVisibility } = require('../controllers/certificateController')

router.get('/verify/:verificationId',   verifyCertificate)        // public
router.get('/',                         auth, getUserCertificates)
router.get('/:id/download',             auth, downloadCertificate)
router.put('/:id/visibility',           auth, toggleVisibility)

module.exports = router
