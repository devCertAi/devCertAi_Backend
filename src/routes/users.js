const express = require('express')
const router = express.Router()
const auth = require('../middleware/userAuth')
const jwt = require('jsonwebtoken')
const validate = require('../middleware/validate')
const { updateUserSkillsSchema } = require('../validators/pipelineValidators')
const {
  getPublicProfile, updateProfile, changePassword,
  getDashboard, updateSkills, deleteAccount,
  getProfileDetail, updateProfileDetail,
  uploadAndParseCV,
  getProfileCompleteness,
  upload,
  uploadCVMulter
} = require('../controllers/userController')

const optionalAuth = (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1]
  if (!token) return next()
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET)
    req.user = { ...decoded, id: decoded.userId }
  } catch {}
  next()
}

// ── public ────────────────────────────────────────────────────────────────────
router.get('/profile/:username',      optionalAuth, getPublicProfile)

// ── authenticated ─────────────────────────────────────────────────────────────
// NOTE: POST /become-recruiter was removed. It used to flip role:'recruiter'
// directly on a `User` row, bypassing the dedicated Recruiter table/OTP flow
// entirely — this was the actual cause of user accounts ending up on the
// recruiter dashboard. Users who want to hire now go through
// /auth/register-recruiter, which creates a proper Recruiter-table account.
router.put('/profile',                auth, upload.single('avatar'),           updateProfile)
router.put('/skills',                 auth, validate(updateUserSkillsSchema),  updateSkills)
router.put('/change-password',        auth, changePassword)
router.get('/dashboard',              auth, getDashboard)
router.delete('/account',             auth, deleteAccount)

// ── profile detail (resume-style) ─────────────────────────────────────────────
router.get('/profile-detail',         auth, getProfileDetail)
router.put('/profile-detail',         auth, updateProfileDetail)

// ── CV upload + AI parse (10 MB limit) ────────────────────────────────────────
router.post('/upload-cv',             auth, uploadCVMulter.single('cv'),       uploadAndParseCV)

// ── profile completeness (dashboard widget + apply gate) ──────────────────────
router.get('/profile-completeness',   auth, getProfileCompleteness)

module.exports = router