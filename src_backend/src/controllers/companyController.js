const prisma = require('../config/database')
const { ApiError } = require('../utils/ApiError')
const { ApiResponse } = require('../utils/ApiResponse')
const asyncHandler = require('../utils/asyncHandler')
const notificationService = require('../services/notificationService')

// GET /companies/me — null if the recruiter hasn't created one yet (not an error)
const getMyCompany = asyncHandler(async (req, res) => {
  const company = await prisma.company.findUnique({ where: { recruiterId: req.user.id } })
  return res.json(new ApiResponse(200, { company }))
})

// POST /companies — "create first company". Idempotent: calling it again just
// returns the existing one rather than erroring, since the schema only allows
// one company per recruiter today.
const createCompany = asyncHandler(async (req, res) => {
 
  const existing = await prisma.company.findUnique({ where: { recruiterId: req.user.id } })
  if (existing) {
    return res.json(new ApiResponse(200, { company: existing }, 'You already have a company'))
  }

  const { name, website, logo, industry, size, description } = req.body
  const company = await prisma.company.create({
    data: { recruiterId: req.user.id, name, website, logo, industry, size, description }
  })

  return res.status(201).json(new ApiResponse(201, { company }, 'Company created'))
})

// PUT /companies/me
const updateCompany = asyncHandler(async (req, res) => {
  const existing = await prisma.company.findUnique({ where: { recruiterId: req.user.id } })
  if (!existing) throw new ApiError(404, 'Create your company first')

  const { name, website, logo, industry, size, description } = req.body
  const company = await prisma.company.update({
    where: { recruiterId: req.user.id },
    data: {
      ...(name !== undefined && { name }),
      ...(website !== undefined && { website }),
      ...(logo !== undefined && { logo }),
      ...(industry !== undefined && { industry }),
      ...(size !== undefined && { size }),
      ...(description !== undefined && { description })
    }
  })

  return res.json(new ApiResponse(200, { company }, 'Company updated'))
})

// POST /companies/me/submit-verification — recruiter submits their company for admin review.
const submitForVerification = asyncHandler(async (req, res) => {
  const company = await prisma.company.findUnique({ where: { recruiterId: req.user.id } })
  if (!company) throw new ApiError(404, 'Create your company before submitting it for verification')

  if (company.verificationStatus === 'verified') {
    throw new ApiError(400, 'This company is already verified')
  }
  if (company.verificationStatus === 'pending') {
    throw new ApiError(400, 'This company is already pending review')
  }

  const { verificationDocUrl } = req.body
  const updated = await prisma.company.update({
    where: { recruiterId: req.user.id },
    data: {
      verificationStatus: 'pending',
      verificationDocUrl: verificationDocUrl || company.verificationDocUrl,
      verificationNote: null
    }
  })

  const admins = await prisma.user.findMany({ where: { role: 'admin' }, select: { id: true } })
  await Promise.all(admins.map(admin => notificationService.create(admin.id, {
    type: 'company_verification_requested',
    title: 'New company verification request',
    message: `${company.name} submitted their company for verification.`,
    data: { companyId: company.id }
  })))

  return res.json(new ApiResponse(200, { company: updated }, 'Submitted for verification — we will email you within 1-2 business days'))
})

module.exports = { getMyCompany, createCompany, updateCompany, submitForVerification }
