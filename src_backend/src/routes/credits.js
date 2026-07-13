const express = require('express')
const router = express.Router()
const auth = require('../middleware/userAuth')
const { getMyCredits, getCreditHistory, checkCredits, watchAdReward } = require('../controllers/creditController')

router.get('/', auth, getMyCredits)
router.get('/history', auth, getCreditHistory)
router.post('/check', auth, checkCredits)
router.post('/watch-ad-reward', auth, watchAdReward)

module.exports = router
