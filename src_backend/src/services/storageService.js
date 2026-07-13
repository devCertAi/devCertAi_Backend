const streamifier = require('streamifier')
const cloudinary = require('../config/cloudinary')

async function uploadBuffer(buffer, options = {}) {
  return new Promise((resolve, reject) => {
    const uploadStream = cloudinary.uploader.upload_stream(
      { folder: 'devcert', ...options },
      (error, result) => {
        if (error) reject(error)
        else resolve(result)
      }
    )
    streamifier.createReadStream(buffer).pipe(uploadStream)
  })
}

async function uploadFile(filePath, options = {}) {
  return cloudinary.uploader.upload(filePath, { folder: 'devcert', ...options })
}

async function deleteFile(publicId) {
  return cloudinary.uploader.destroy(publicId)
}

async function uploadZip(buffer) {
  return uploadBuffer(buffer, {
    folder: 'devcert/projects',
    resource_type: 'raw',
    format: 'zip',
    access_mode: 'public',
    type: 'upload'
  })
}

async function uploadAvatar(buffer) {
  return uploadBuffer(buffer, {
    folder: 'devcert/avatars',
    transformation: [{ width: 200, height: 200, crop: 'fill', gravity: 'face' }]
  })
}

async function uploadCV(buffer, originalname) {
  return uploadBuffer(buffer, {
    folder: 'devcert/cvs',
    resource_type: 'raw',
    public_id: `cv_${Date.now()}_${originalname.replace(/\s+/g, '_')}`,
    access_mode: 'public',
    type: 'upload'
  })
}

async function getSignedUrl(publicId) {
  return cloudinary.url(publicId, {
    resource_type: 'raw',
    type: 'upload',
    sign_url: true,
    expires_at: Math.floor(Date.now() / 1000) + 3600
  })
}

// Cloudinary's "Restricted media types" security setting (default ON for
// accounts created after mid-2024) returns a 401 when a raw asset — which
// is what PDFs/ZIPs uploaded with resource_type:'raw' are — is requested
// without a signature, even though the asset itself is "public". Every CV
// and assignment zip in this app is stored as a plain secure_url in the
// database, so every "View it" / "Download" link built straight from that
// stored URL hits the same 401. This derives the public_id back out of a
// previously-stored raw upload URL and re-signs it for delivery, with a
// generous (7 day) expiry so the link keeps working from things like old
// emails and cached pages.
//
// One extra wrinkle: for resource_type:'raw', Cloudinary doesn't consistently
// keep the file extension as part of the public_id — depending on the
// account/SDK version, it's either kept literally in the public_id
// ("cv_123_resume.pdf") or split out into a separate `format` field
// ("cv_123_resume" + format: "pdf"). Signing the wrong shape produces a
// signature for a public_id that doesn't actually exist, which Cloudinary
// rejects with a 404. Rather than guess, we generate both candidate signed
// URLs and the caller tries them in order until one actually resolves.
const RAW_EXT_RE = /\.([a-zA-Z0-9]{1,6})$/

function signRawUrlCandidates(url) {
  if (!url || typeof url !== 'string') return [url]
  const match = url.match(/\/raw\/upload\/(?:v\d+\/)?(.+)$/)
  if (!match) {
    console.warn('[signRawUrl] URL did not match /raw/upload/ pattern, returning unsigned:', url)
    return [url] // not a Cloudinary raw/upload URL — leave untouched (e.g. local/test fixtures)
  }

  const fullPublicId = match[1] // e.g. devcert/cvs/cv_123_java_backend.pdf
  const extMatch = fullPublicId.match(RAW_EXT_RE)

  const sign = (publicId, format) => {
    try {
      return cloudinary.url(publicId, {
        resource_type: 'raw',
        type: 'upload',
        sign_url: true,
        secure: true,
        ...(format ? { format } : {}),
        expires_at: Math.floor(Date.now() / 1000) + 7 * 24 * 3600
      })
    } catch (err) {
      console.error('[signRawUrl] failed to sign a candidate URL:', err.message)
      return null
    }
  }

  const candidates = []

  // Candidate 1: extension is a literal part of the public_id (most common
  // for resource_type:'raw' uploads that pass an explicit public_id).
  const c1 = sign(fullPublicId)
  if (c1) candidates.push(c1)

  // Candidate 2: extension was split out into `format`, real public_id has
  // no extension.
  if (extMatch) {
    const ext = extMatch[1]
    const publicIdNoExt = fullPublicId.slice(0, -extMatch[0].length)
    const c2 = sign(publicIdNoExt, ext)
    if (c2) candidates.push(c2)
  }

  return candidates.length ? candidates : [url]
}

// Kept for any other callers that just want a single best-guess URL
// (non-CV raw assets like project zips, where we haven't seen this
// two-shapes issue occur in practice).
function signRawUrl(url) {
  return signRawUrlCandidates(url)[0]
}

module.exports = { uploadBuffer, uploadFile, deleteFile, uploadZip, uploadAvatar, uploadCV, getSignedUrl, signRawUrl, signRawUrlCandidates }