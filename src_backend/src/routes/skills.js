const express = require('express')
const router = express.Router()
const { searchSkills, createSkill } = require('../controllers/skillController')

router.get('/',  searchSkills)
router.post('/', createSkill)

module.exports = router