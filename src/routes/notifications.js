const express = require('express')
const router = express.Router()
const auth = require('../middleware/userAuth')
const { getAll, markRead, markAllRead, deleteOne } = require('../controllers/notificationController')

router.get('/',             auth, getAll)
router.put('/read-all',     auth, markAllRead)
router.put('/:id/read',     auth, markRead)
router.delete('/:id',       auth, deleteOne)

module.exports = router
