const puppeteer = require('puppeteer')
const cloudinary = require('../config/cloudinary')
const prisma = require('../config/database')
const { generateVerificationId } = require('../utils/generateIds')

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

// Shared certificate design tokens — per-level metal palette. Keep this in
// sync with frontend/src/components/certificates/CertificateCard.tsx
// LEVEL_METAL so the downloaded PDF always matches the on-screen preview.
const LEVEL_METAL = {
  Advanced:     { stops: ['#FFF6D8', '#F0D278', '#C9A227', '#8B6914', '#F0D278', '#FFF6D8'], glow: 'rgba(201,162,39,0.45)', sealFrom: '#fcd34d', sealMid: '#d97706', sealTo: '#92400e' },
  Intermediate: { stops: ['#FFFFFF', '#D6DEEA', '#8593AC', '#4A5670', '#D6DEEA', '#FFFFFF'], glow: 'rgba(91,107,140,0.4)',  sealFrom: '#e2e8f0', sealMid: '#64748b', sealTo: '#334155' },
  Beginner:     { stops: ['#F6DCC0', '#DBA976', '#B87333', '#7A4B1F', '#DBA976', '#F6DCC0'], glow: 'rgba(184,115,51,0.4)',  sealFrom: '#f0b27a', sealMid: '#b87333', sealTo: '#7a4b1f' }
}

function buildCertHTML(data) {
  const { userName, domain, level, score, type, verificationId, projectTitle, issuedDate, difficulty, metadata } = data
  const metal = LEVEL_METAL[level] || LEVEL_METAL.Advanced
  const typeLabel = type === 'project_eval'
    ? 'ProjCert — Project Evaluation Certificate'
    : type === 'combo_cert'
      ? 'ComboCert — Phase 1 + Phase 2 Combined Certificate'
      : 'SkillCert — Verified Skill Certificate'
  const difficultyLabel = difficulty ? String(difficulty).charAt(0).toUpperCase() + String(difficulty).slice(1) : null
  const comboBreakdown = type === 'combo_cert' && metadata
    ? `Phase 1: ${metadata.phase1Score ?? '-'}/100 &middot; Phase 2: ${metadata.phase2Score ?? '-'}/100`
    : null
  const extraLine = comboBreakdown || (projectTitle ? `Project: ${projectTitle}` : '')
  // Certificates are only ever generated for a signed-in, named user, but
  // guard against a blank/undefined name so a rendering bug never produces
  // a certificate that looks unissued.
  const holderName = userName || 'Certificate Holder'

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <link href="https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,400;0,600;0,700;1,400&family=Cinzel:wght@400;600;700&family=EB+Garamond:ital,wght@0,400;0,500;1,400&display=swap" rel="stylesheet">
  <style>
    * { margin:0; padding:0; box-sizing:border-box; }
    body {
      width:1123px; height:794px;
      background:#E7E9EF;
      display:flex; align-items:center; justify-content:center;
      overflow:hidden;
      font-family:'EB Garamond', Georgia, serif;
    }

    .page {
      width:1060px; height:740px;
      background: #fdfcfa;
      border: 1px solid #cbd5e1;
      position:relative;
      overflow:hidden;
      box-shadow:
        0 0 0 8px #ffffff,
        0 0 0 9px #cbd5e1,
        0 25px 70px rgba(30,41,59,0.15),
        0 4px 18px rgba(30,41,59,0.10);
    }

    /* The dark navy ribbon running down the left side */
    .vertical-ribbon {
      position: absolute;
      top: 0;
      left: 80px;
      width: 45px;
      height: 100%;
      background-color: #0f172a;
      z-index: 1;
    }

    /* Metallic badge overlapping the ribbon — colour follows certificate level */
    .gold-seal {
      position: absolute;
      top: 110px;
      left: 52px;
      width: 100px;
      height: 100px;
      background: radial-gradient(circle, ${metal.sealFrom} 0%, ${metal.sealMid} 70%, ${metal.sealTo} 100%);
      border-radius: 50%;
      border: 4px solid #0f172a;
      box-shadow: 0 4px 14px rgba(0,0,0,0.25);
      z-index: 2;
      display: flex;
      align-items: center;
      justify-content: center;
    }

    .gold-seal::after {
      content: '';
      width: 76px;
      height: 76px;
      border: 1.5px dashed rgba(255, 255, 255, 0.6);
      border-radius: 50%;
      position: absolute;
    }

    .content {
      position:absolute;
      inset: 0;
      padding-left: 200px;
      padding-right: 80px;
      display:flex;
      flex-direction:column;
      justify-content: center;
      align-items: flex-start;
    }

    .brand-name {
      position: absolute;
      top: 60px;
      right: 80px;
      font-family: 'Cinzel', serif;
      font-size: 26px;
      font-weight: 700;
      letter-spacing: 2px;
      color: #0f172a;
    }

    .brand-name span { color: #d97706; }

    .main-title {
      font-family: 'Playfair Display', serif;
      font-size: 76px;
      font-weight: 400;
      font-style: italic;
      color: #0f172a;
      line-height: 1;
      margin-bottom: -3px;
    }

    .sub-title-box {
      background-color: #0f172a;
      color: #ffffff;
      font-family: 'Cinzel', sans-serif;
      font-size: 13px;
      font-weight: 600;
      letter-spacing: 5px;
      padding: 5px 20px 4px 24px;
      text-transform: uppercase;
      margin-bottom: 10px;
      display: inline-block;
    }

    .type-label {
      font-family: 'Cinzel', sans-serif;
      font-size: 10px;
      letter-spacing: 2.5px;
      color: #94a3b8;
      text-transform: uppercase;
      margin-bottom: 26px;
    }

    .certifies-that {
      font-family: 'EB Garamond', serif;
      font-size: 19px;
      color: #475569;
      margin-bottom: 12px;
    }

    .holder-name {
      font-family: 'Playfair Display', serif;
      font-size: 38px;
      font-weight: 700;
      color: #0f172a;
      border-bottom: 1px solid #94a3b8;
      padding-bottom: 4px;
      margin-bottom: 20px;
      width: 100%;
      max-width: 550px;
    }

    .details-text {
      font-family: 'EB Garamond', serif;
      font-size: 19px;
      line-height: 1.6;
      color: #475569;
      margin-bottom: 8px;
      max-width: 650px;
    }

    .details-text strong {
      font-family: 'Playfair Display', serif;
      font-weight: 700;
      color: #0f172a;
    }

    .extra-line {
      font-family: 'EB Garamond', serif;
      font-style: italic;
      font-size: 14px;
      color: #64748b;
      margin-bottom: 34px;
    }

    .bottom-meta {
      width: 100%;
      max-width: 760px;
      display: flex;
      flex-wrap: wrap;
      gap: 32px;
      justify-content: space-between;
      align-items: flex-end;
    }

    .meta-block { display: flex; flex-direction: column; gap: 4px; }

    .meta-lbl {
      font-family: 'Cinzel', sans-serif;
      font-size: 9px;
      letter-spacing: 2px;
      color: #94a3b8;
      text-transform: uppercase;
    }

    .meta-val {
      font-family: 'Playfair Display', serif;
      font-size: 18px;
      font-weight: 700;
      color: #0f172a;
    }

    .v-id {
      font-family: 'Courier New', monospace;
      font-size: 12px;
      color: #475569;
      font-weight: bold;
    }
  </style>
</head>
<body>
<div class="page">
  <div class="vertical-ribbon"></div>
  <div class="gold-seal">
     <svg width="45" height="45" viewBox="0 0 24 24" fill="none" stroke="#ffffff" stroke-width="1.25">
       <path d="M6 3c0 6 3 10 6 12m6-12c0 6-3 10-6 12" />
       <path d="M4 6c2 0 3.5 1 4 2M4 10c2 0 3.5 1 4 2m-4 4c2 0 3.5 1 4 2" />
       <path d="M20 6c-2 0-3.5 1-4 2m4 2c-2 0-3.5 1-4 2m4 4c-2 0-3.5 1-4 2" />
       <circle cx="12" cy="16" r="1.5" fill="#ffffff"/>
     </svg>
  </div>

  <div class="content">
    <div class="brand-name"><span>DevCert</span></div>

    <div class="main-title">Certificate</div>
    <div class="sub-title-box">Of Completion</div>
    <div class="type-label">${typeLabel}</div>

    <div class="certifies-that">This certificate is proudly presented to</div>
    <div class="holder-name">${holderName}</div>

    <div class="details-text">
      for successfully demonstrating <strong>${level}</strong> level proficiency in
      the framework environment discipline of <strong>${domain}</strong> on project implementation evaluations.
    </div>
    ${extraLine ? `<div class="extra-line">${extraLine}</div>` : '<div style="margin-bottom:34px"></div>'}

    <div class="bottom-meta">
      <div class="meta-block">
        <span class="meta-lbl">Date Issued</span>
        <span class="meta-val">${issuedDate}</span>
      </div>
      <div class="meta-block" style="align-items: center;">
        <span class="meta-lbl">Score Achieved</span>
        <span class="meta-val">${score} / 100</span>
      </div>
      ${difficultyLabel ? `
      <div class="meta-block" style="align-items: center;">
        <span class="meta-lbl">Difficulty</span>
        <span class="meta-val">${difficultyLabel}</span>
      </div>` : ''}
      <div class="meta-block" style="text-align: right; align-items: flex-end;">
        <span class="meta-lbl">Certificate Number</span>
        <span class="v-id">${verificationId || '0000'}</span>
      </div>
    </div>
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

async function createCertificate({ userId, type, domain, level, score, projectId, examAttemptId, projectTitle, userName, difficulty, metadata }) {
  const verificationId = generateVerificationId()
  const issuedDate = new Date().toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })

  const certificateUrl = await generateAndUpload({
    userName, domain, level, score, type, verificationId, projectTitle, issuedDate, difficulty, metadata
  })

  const cert = await prisma.certificate.create({
    data: {
      userId, type, domain, level, score,
      difficulty: difficulty || null,
      metadata: metadata || undefined,
      projectId: projectId || null,
      examAttemptId: examAttemptId || null,
      certificateUrl,
      verificationId
    }
  })

  return cert
}

module.exports = { createCertificate, generateAndUpload, buildCertHTML, renderCertPdf }