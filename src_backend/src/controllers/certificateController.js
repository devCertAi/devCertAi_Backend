const prisma = require('../config/database')
const { ApiError } = require('../utils/ApiError')
const { ApiResponse } = require('../utils/ApiResponse')
const asyncHandler = require('../utils/asyncHandler')

// GET /verify/:verificationId — public, no auth
const verifyCertificate = asyncHandler(async (req, res) => {
  const cert = await prisma.certificate.findUnique({
    where: { verificationId: req.params.verificationId },
    include: {
      user: { select: { name: true, username: true, avatar: true } },
      project: { select: { title: true, githubUrl: true } }
    }
  })
  if (!cert) throw new ApiError(404, 'Certificate not found or invalid verification ID')

  return res.json(new ApiResponse(200, { certificate: cert, verified: true }))
})

// GET / — user's certificates
const getUserCertificates = asyncHandler(async (req, res) => {
  const certificates = await prisma.certificate.findMany({
    where: { userId: req.user.id },
    orderBy: { createdAt: 'desc' },
    include: {
      // FIX: `user` was missing here, so every certificate in the list came
      // back with `cert.user === undefined`. The frontend card/preview then
      // had no real name to show and silently fell back to a placeholder.
      user: { select: { name: true, username: true, avatar: true } },
      project: { select: { title: true } }
    }
  })

  // FIX: explicitly expose downloadUrl and previewUrl so the frontend can
  // render both a "View" button (opens PDF in new tab) and a "Download" button
  // (triggers file download via the /download route). Without this, the frontend
  // had no reliable field to link to and the download button was invisible.
  const enriched = certificates.map(cert => ({
    ...cert,
    previewUrl:  cert.certificateUrl || null,
    downloadUrl: cert.certificateUrl
      ? `/api/certificates/${cert.id}/download`
      : null
  }))

  return res.json(new ApiResponse(200, { certificates: enriched }))
})

// GET /:id/download
const downloadCertificate = asyncHandler(async (req, res) => {
  const cert = await prisma.certificate.findFirst({
    where: { id: req.params.id, userId: req.user.id },
    include: { user: { select: { name: true } }, project: { select: { title: true } } }
  })
  if (!cert) throw new ApiError(404, 'Certificate not found')

  const { buildCertHTML, renderCertPdf } = require('../services/certificateService')

  const issuedDate = new Date(cert.createdAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })

  const pdfBuffer = await renderCertPdf({
    userName: cert.user.name,
    domain: cert.domain,
    level: cert.level,
    score: cert.score,
    type: cert.type,
    verificationId: cert.verificationId,
    projectTitle: cert.project?.title,
    issuedDate,
    difficulty: cert.difficulty,
    metadata: cert.metadata
  })

  // Guard against ever sending a non-Buffer (e.g. a Uint8Array) — Express
  // would silently JSON-serialize it instead of sending raw binary,
  // producing a corrupted PDF the browser can't open.
  const safeBuffer = Buffer.isBuffer(pdfBuffer) ? pdfBuffer : Buffer.from(pdfBuffer)

  res.setHeader('Content-Type', 'application/pdf')
  res.setHeader('Content-Length', safeBuffer.length)
  res.setHeader('Content-Disposition', `attachment; filename="devcert-${cert.verificationId}.pdf"`)
  res.send(safeBuffer)
})
// PUT /:id/visibility
const toggleVisibility = asyncHandler(async (req, res) => {
  const cert = await prisma.certificate.findFirst({
    where: { id: req.params.id, userId: req.user.id }
  })
  if (!cert) throw new ApiError(404, 'Certificate not found')

  const updated = await prisma.certificate.update({
    where: { id: cert.id },
    data: { isPublic: !cert.isPublic }
  })

  return res.json(new ApiResponse(200, { isPublic: updated.isPublic }, `Certificate is now ${updated.isPublic ? 'public' : 'private'}`))
})

module.exports = { verifyCertificate, getUserCertificates, downloadCertificate, toggleVisibility }