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

module.exports = { uploadBuffer, uploadFile, deleteFile, uploadZip, uploadAvatar, uploadCV, getSignedUrl }