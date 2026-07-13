const express = require('express')
const router = express.Router()
const auth = require('../middleware/auth')
const admin = require('../middleware/admin')
const {
  getStats, getUsers, updateUserRole, banUser,
  addQuestion, getQuestions, updateQuestion, deleteQuestion,
  bulkImportQuestions, getQuestionBankStats, recomputeQuestionBankStats,
  getQueueStats, getCompanies, verifyCompany
} = require('../controllers/adminController')
const {
  createTestimonial, updateTestimonial, deleteTestimonial
} = require('../controllers/testimonialController')

// All admin routes require auth + admin role
router.use(auth, admin)

router.get('/stats',                  getStats)
router.get('/users',                  getUsers)
router.put('/users/:id/role',         updateUserRole)
router.delete('/users/:id',           banUser)

router.post('/questions',             addQuestion)
router.get('/questions',              getQuestions)
router.get('/questions/stats',        getQuestionBankStats)
router.post('/questions/stats/recompute', recomputeQuestionBankStats)
router.put('/questions/:id',          updateQuestion)
router.delete('/questions/:id',       deleteQuestion)
router.post('/questions/bulk-import', bulkImportQuestions)

router.get('/queues',                 getQueueStats)

router.get('/companies',              getCompanies)
router.post('/companies/:id/verify', verifyCompany)

router.post('/testimonials',          createTestimonial)
router.put('/testimonials/:id',       updateTestimonial)
router.delete('/testimonials/:id',    deleteTestimonial)

module.exports = router