const express = require('express')
const router = express.Router()
const { getTestimonials } = require('../controllers/testimonialController')

// Public — no auth required
router.get('/', getTestimonials)

module.exports = router