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
  viewOwnCV,
  viewUserCV,
  deleteCV,
  getProfileCompleteness,
  upload,
  uploadCVMulter
} = require('../controllers/userController')

const requireAuth = (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1]
  if (!token) return res.status(401).json({ success: false, message: 'Please log in to view this page.' })
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET)
    req.user = { ...decoded, id: decoded.userId }
    next()
  } catch {
    return res.status(401).json({ success: false, message: 'Your session has expired. Please log in again.' })
  }
}

// ── public ────────────────────────────────────────────────────────────────────
router.get('/profile/:username',      requireAuth, getPublicProfile)

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

// ── CV view — proxied through our own domain (never links straight to Cloudinary) ──
router.get('/me/cv',                  auth,        viewOwnCV)
router.get('/:username/cv',           requireAuth, viewUserCV)
router.delete('/cv',                  auth,        deleteCV)

// ── profile completeness (dashboard widget + apply gate) ──────────────────────
router.get('/profile-completeness',   auth, getProfileCompleteness)

module.exports = router