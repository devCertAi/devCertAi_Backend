const puppeteer = require('puppeteer')
const cloudinary = require('../config/cloudinary')
const prisma = require('../config/database')
const { generateVerificationId } = require('../utils/generateIds')

// Launching a fresh headless Chromium per certificate (cold start) takes
// 2-5s+ on its own. Keep a single shared browser instance alive and reuse
// it for every PDF render — this is the main reason certificate generation
// (and downloads) were slow.
let browserPromise = null
async function getBrowser() {
  if (!browserPromise) {
    browserPromise = puppeteer.launch({
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
      headless: 'new'
    }).catch(err => { browserPromise = null; throw err })
  }
  let browser = await browserPromise
  if (!browser.isConnected()) {
    browserPromise = null
    browser = await getBrowser()
  }
  return browser
}

async function renderCertPdf(data) {
  const browser = await getBrowser()
  const page = await browser.newPage()
  try {
    await page.setViewport({ width: 1123, height: 794 })
    await page.setContent(buildCertHTML(data), { waitUntil: 'networkidle0', timeout: 30000 })
    return await page.pdf({
      width: '1123px', height: '794px',
      printBackground: true,
      pageRanges: '1'
    })
  } finally {
    await page.close()
  }
}

const LEVEL_COLORS = {
  Advanced:     { primary: '#FFD700', secondary: '#B8860B', glow: 'rgba(255,215,0,0.15)' },
  Intermediate: { primary: '#C0C0C0', secondary: '#808080', glow: 'rgba(192,192,192,0.15)' },
  Beginner:     { primary: '#CD7F32', secondary: '#8B4513', glow: 'rgba(205,127,50,0.15)' }
}

function buildCertHTML(data) {
  const { userName, domain, level, score, type, verificationId, projectTitle, issuedDate } = data
  const colors = LEVEL_COLORS[level] || LEVEL_COLORS.Beginner
  const typeLabel = type === 'project_eval' ? 'ProjCert — Project Evaluation Certificate' : 'SkillCert — Verified Skill Certificate'

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <link href="https://fonts.googleapis.com/css2?family=Playfair+Display:wght@400;700&family=Inter:wght@300;400;500;600&display=swap" rel="stylesheet">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      width: 1123px; height: 794px;
      background: #0A0A0F;
      font-family: 'Inter', sans-serif;
      display: flex; align-items: center; justify-content: center;
      overflow: hidden;
    }
    .cert {
      width: 1060px; height: 730px;
      background: linear-gradient(135deg, #0F0F1A 0%, #13131F 100%);
      border: 2px solid ${colors.primary}40;
      border-radius: 20px;
      padding: 56px 72px;
      position: relative;
      display: flex; flex-direction: column; align-items: center; justify-content: center;
      box-shadow: 0 0 60px ${colors.glow}, inset 0 0 80px rgba(0,0,0,0.5);
    }
    .corner { position: absolute; width: 64px; height: 64px; border-color: ${colors.primary}; border-style: solid; }
    .tl { top: 24px; left: 24px; border-width: 2px 0 0 2px; border-radius: 4px 0 0 0; }
    .tr { top: 24px; right: 24px; border-width: 2px 2px 0 0; border-radius: 0 4px 0 0; }
    .bl { bottom: 24px; left: 24px; border-width: 0 0 2px 2px; border-radius: 0 0 0 4px; }
    .br { bottom: 24px; right: 24px; border-width: 0 2px 2px 0; border-radius: 0 0 4px 0; }
    .watermark { position: absolute; font-size: 200px; font-weight: 900; color: rgba(108,99,255,0.03); pointer-events: none; letter-spacing: -10px; font-family: 'Playfair Display', serif; }
    .logo { font-size: 15px; letter-spacing: 5px; color: ${colors.primary}; text-transform: uppercase; font-weight: 600; margin-bottom: 6px; }
    .cert-type { font-size: 11px; letter-spacing: 3px; color: #555; text-transform: uppercase; margin-bottom: 36px; }
    .certifies { font-size: 13px; color: #777; margin-bottom: 10px; letter-spacing: 1px; }
    .name { font-family: 'Playfair Display', serif; font-size: 46px; color: #F1F1F3; margin-bottom: 20px; line-height: 1.1; }
    .desc { font-size: 14px; color: #777; margin-bottom: 10px; letter-spacing: 0.5px; }
    .level-badge { display: inline-block; padding: 5px 18px; background: ${colors.primary}18; border: 1px solid ${colors.primary}50; border-radius: 20px; color: ${colors.primary}; font-size: 13px; font-weight: 600; letter-spacing: 1px; }
    .proficiency-text { font-size: 13px; color: #666; margin: 10px 0 4px; }
    .domain { font-size: 28px; color: ${colors.primary}; font-weight: 600; margin-bottom: 8px; letter-spacing: -0.5px; }
    .project-title { font-size: 12px; color: #555; margin-bottom: 28px; }
    .meta { display: flex; gap: 64px; }
    .meta-item { text-align: center; }
    .meta-label { font-size: 10px; color: #444; letter-spacing: 3px; text-transform: uppercase; margin-bottom: 6px; }
    .meta-value { font-size: 20px; font-weight: 600; color: #F1F1F3; }
    .line { width: 100px; height: 1px; background: rgba(255,255,255,0.08); margin: 16px auto 0; }
    .verify { position: absolute; bottom: 32px; right: 56px; text-align: right; }
    .verify-label { font-size: 9px; color: #444; letter-spacing: 2px; text-transform: uppercase; margin-bottom: 4px; }
    .verify-id { font-size: 11px; color: #555; font-family: 'Courier New', monospace; }
    .issued { position: absolute; bottom: 32px; left: 56px; }
  </style>
</head>
<body>
  <div class="cert">
    <div class="corner tl"></div><div class="corner tr"></div>
    <div class="corner bl"></div><div class="corner br"></div>
    <div class="watermark">DC</div>
    <div class="logo">DevCert</div>
    <div class="cert-type">${typeLabel}</div>
    <div class="certifies">This certifies that</div>
    <div class="name">${userName}</div>
    <div class="desc">has successfully demonstrated</div>
    <span class="level-badge">${level}</span>
    <div class="proficiency-text">level proficiency in</div>
    <div class="domain">${domain}</div>
    ${projectTitle ? `<div class="project-title">Project: ${projectTitle}</div>` : ''}
    <div class="meta">
      <div class="meta-item">
        <div class="meta-label">Score</div>
        <div class="meta-value">${score}/100</div>
        <div class="line"></div>
      </div>
      <div class="meta-item">
        <div class="meta-label">Level</div>
        <div class="meta-value">${level}</div>
        <div class="line"></div>
      </div>
      <div class="meta-item">
        <div class="meta-label">Issued</div>
        <div class="meta-value">${issuedDate}</div>
        <div class="line"></div>
      </div>
    </div>
    <div class="verify">
      <div class="verify-label">Verify at</div>
      <div class="verify-id">devcert.io/verify/${verificationId}</div>
    </div>
    <div class="issued">
      <div class="verify-label">Certificate ID</div>
      <div class="verify-id">${verificationId}</div>
    </div>
  </div>
</body>
</html>`
}

async function generateAndUpload(data) {
  const pdfBuffer = await renderCertPdf(data)

  // Upload to Cloudinary
  const uploadResult = await new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { folder: 'devcert/certificates', resource_type: 'raw', format: 'pdf',
        public_id: `cert_${data.verificationId}` },
      (error, result) => { if (error) reject(error); else resolve(result) }
    )
    stream.end(pdfBuffer)
  })

  return uploadResult.secure_url
}

async function createCertificate({ userId, type, domain, level, score, projectId, examAttemptId, projectTitle, userName }) {
  const verificationId = generateVerificationId()
  const issuedDate = new Date().toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })

  const certificateUrl = await generateAndUpload({
    userName, domain, level, score, type, verificationId, projectTitle, issuedDate
  })

  const cert = await prisma.certificate.create({
    data: {
      userId, type, domain, level, score,
      projectId: projectId || null,
      examAttemptId: examAttemptId || null,
      certificateUrl,
      verificationId
    }
  })

  return cert
}

module.exports = { createCertificate, generateAndUpload, buildCertHTML, renderCertPdf }