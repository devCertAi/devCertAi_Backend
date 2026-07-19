const cloudinary = require('../config/cloudinary')
const prisma = require('../config/database')
const { generateVerificationId } = require('../utils/generateIds')

// ────────────────────────────────────────────────────────────────────────
// Proeva logo (faceted gem mark) — embedded as a base64 data URI so it
// renders identically locally AND inside the sandboxed Chromium on Render.
// Puppeteer/Chromium cannot reliably fetch external image URLs inside some
// serverless/container network setups, so we inline the asset instead of
// pointing at a hosted file or Cloudinary URL.
// ────────────────────────────────────────────────────────────────────────
const LOGO_DATA_URI = 'data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iNjAwIiBoZWlnaHQ9IjYwMCIgdmlld0JveD0iMCAwIDYwMCA2MDAiIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyI+CiAgPGRlZnM+CiAgICA8IS0tIEJhY2tncm91bmQgR3JhZGllbnQgLS0+CiAgICA8cmFkaWFsR3JhZGllbnQgaWQ9ImJnX2ciIGN4PSI1MCUiIGN5PSI1MCUiIHI9IjkwJSI+CiAgICAgIDxzdG9wIG9mZnNldD0iMCUiIHN0b3AtY29sb3I9IiMxQTIwMjgiLz4KICAgICAgPHN0b3Agb2Zmc2V0PSIxMDAlIiBzdG9wLWNvbG9yPSIjMEEwRDEyIi8+CiAgICA8L3JhZGlhbEdyYWRpZW50PgoKICAgIDwhLS0gRGlhbW9uZCBCYXNlIEdyYWRpZW50cyAtLT4KICAgIDxsaW5lYXJHcmFkaWVudCBpZD0idGVhbF9nIiB4MT0iMCUiIHkxPSIwJSIgeDI9IjEwMCUiIHkyPSIxMDAlIj4KICAgICAgPHN0b3Agb2Zmc2V0PSIwJSIgc3RvcC1jb2xvcj0iIzAwRjVENCIvPgogICAgICA8c3RvcCBvZmZzZXQ9IjEwMCUiIHN0b3AtY29sb3I9IiMwMEEzODkiLz4KICAgIDwvbGluZWFyR3JhZGllbnQ+CiAgICA8bGluZWFyR3JhZGllbnQgaWQ9InZpb2xldF9nIiB4MT0iMCUiIHkxPSIwJSIgeDI9IjEwMCUiIHkyPSIxMDAlIj4KICAgICAgPHN0b3Agb2Zmc2V0PSIwJSIgc3RvcC1jb2xvcj0iI0E3OEJGQSIvPgogICAgICA8c3RvcCBvZmZzZXQ9IjEwMCUiIHN0b3AtY29sb3I9IiM2RDI4RDkiLz4KICAgIDwvbGluZWFyR3JhZGllbnQ+CiAgICAKICAgIDwhLS0gRGlhbW9uZCBEYXJrIEZhY2V0cyAoU2hhZG93KSAtLT4KICAgIDxsaW5lYXJHcmFkaWVudCBpZD0idGVhbF9kYXJrIiB4MT0iMCUiIHkxPSIwJSIgeDI9IjEwMCUiIHkyPSIxMDAlIj4KICAgICAgPHN0b3Agb2Zmc2V0PSIwJSIgc3RvcC1jb2xvcj0iIzAwODU3MyIvPgogICAgICA8c3RvcCBvZmZzZXQ9IjEwMCUiIHN0b3AtY29sb3I9IiMwMEQ0M0YiLz4KICAgIDwvbGluZWFyR3JhZGllbnQ+CiAgICA8bGluZWFyR3JhZGllbnQgaWQ9InZpb2xldF9kYXJrIiB4MT0iMCUiIHkxPSIwJSIgeDI9IjEwMCUiIHkyPSIxMDAlIj4KICAgICAgPHN0b3Agb2Zmc2V0PSIwJSIgc3RvcC1jb2xvcj0iIzVBM0ZDQyIvPgogICAgICA8c3RvcCBvZmZzZXQ9IjEwMCUiIHN0b3AtY29sb3I9IiMyRTFBNzMiLz4KICAgIDwvbGluZWFyR3JhZGllbnQ+CgogICAgPCEtLSBHbGFzcyBIaWdobGlnaHQgR3JhZGllbnQgLS0+CiAgICA8bGluZWFyR3JhZGllbnQgaWQ9Imdsb3dfZyIgY3g9IjUwJSIgY3k9IjUwJSIgcj0iNTAlIj4KICAgICAgPHN0b3Agb2Zmc2V0PSIwJSIgc3RvcC1jb2xvcj0iI0ZGRkZGRiIgc3RvcC1vcGFjaXR5PSIwLjgiLz4KICAgICAgPHN0b3Agb2Zmc2V0PSIxMDAlIiBzdG9wLWNvbG9yPSIjRkZGRkZGIiBzdG9wLW9wYWNpdHk9IjAiLz4KICAgIDwvbGluZWFyR3JhZGllbnQ+CgogICAgPCEtLSBQcm9mZXNzaW9uYWwgR2xvdyBiZWhpbmQgdGhlIGRpYW1vbmQgLS0+CiAgICA8cmFkaWFsR3JhZGllbnQgaWQ9Imdsb3dfZyIgY3g9IjUwJSIgY3k9IjUwJSIgcj0iNTAlIj4KICAgICAgPHN0b3Agb2Zmc2V0PSIwJSIgc3RvcC1jb2xvcj0iIzAwRjVENCIgc3RvcC1vcGFjaXR5PSIwLjIiLz4KICAgICAgPHN0b3Agb2Zmc2V0PSIxMDAlIiBzdG9wLWNvbG9yPSIjMDBGNUQ0IiBzdG9wLW9wYWNpdHk9IjAiLz4KICAgIDwvcmFkaWFsR3JhZGllbnQ+CgogICAgPCEtLSBTdWJ0bGUgQm9yZGVyIEdyYWRpZW50IC0tPgogICAgPGxpbmVhckdyYWRpZW50IGlkPSJib3JkZXJfZyIgeDE9IjAlIiB5MT0iMCUiIHgyPSIxMDAlIiB5Mj0iMTAwJSI+CiAgICAgIDxzdG9wIG9mZnNldD0iMCUiIHN0b3AtY29sb3I9IiMyQTMxM0MiIHN0b3Atb3BhY2l0eT0iMC44Ii8+CiAgICAgIDxzdG9wIG9mZnNldD0iMTAwJSIgc3RvcC1jb2xvcj0iIzE0MUEyNCIgc3RvcC1vcGFjaXR5PSIwLjgiLz4KICAgIDwvbGluZWFyR3JhZGllbnQ+CiAgPC9kZWZzPgoKICA8IS0tIEJhY2tncm91bmQgQ2FyZCAtLT4KICA8cmVjdCB4PSIwIiB5PSIwIiB3aWR0aD0iNjAwIiBoZWlnaHQ9IjYwMCIgcng9IjE0MCIgZmlsbD0idXJsKCNiZ19nKSIvPgogIDxyZWN0IHg9IjIiIHk9IjIiIHdpZHRoPSI1OTYiIGhlaWdodD0iNTk2IiByeD0iMTM4IiBmaWxsPSJub25lIiBzdHJva2U9InVybCgjYm9yZGVyX2cpIiBzdHJva2Utd2lkdGg9IjIiLz4KCiAgPCEtLSBBbWJpZW50IEdsb3cgYmVoaW5kIHRoZSBkaWFtb25kIC0tPgogIDxjaXJjbGUgY3g9IjMwMCIgY3k9IjI4OCIgcj0iMTgwIiBmaWxsPSJ1cmwoI2dsb3dfZykiIC8+CgogIDwhLS0gRGlhbW9uZCBMb2dvIEdyb3VwIChDZW50ZXJlZCkgLS0+CiAgPGcgdHJhbnNmb3JtPSJ0cmFuc2xhdGUoNDQsIDMyKSI+CiAgICAKICAgIDwhLS0gTGVmdCBMYXJnZSBGYWNldCAtLT4KICAgIDxwb2x5Z29uIHBvaW50cz0iMjU2LDExMiAxNTYsMjU2IDI1Niw0MDAiIGZpbGw9InVybCgjdGVhbF9nKSIvPgogICAgCiAgICA8IS0tIFJpZ2h0IExhcmdlIEZhY2V0IC0tPgogICAgPHBvbHlnb24gcG9pbnRzPSIyNTYsMTEyIDM1NiwyNTYgMjU2LDQwMCIgZmlsbD0idXJsKCN2aW9sZXRfZykiLz4KICAgIAogICAgPCEtLSBCb3R0b20gTGVmdCBEYXJrIEZhY2V0IC0tPgogICAgPHBvbHlnb24gcG9pbnRzPSIxNTYsMjU2IDI1Niw0MDAgMjU2LDMwMCIgZmlsbD0idXJsKCN0ZWFsX2RhcmspIiBvcGFjaXR5PSIwLjg1Ii8+CiAgICAKICAgIDwhLS0gQm90dG9tIFJpZ2h0IERhcmsgRmFjZXQgLS0+CiAgICA8cG9seWdvbiBwb2ludHM9IjM1NiwyNTYgMjU2LDQwMCAyNTYsMzAwIiBmaWxsPSJ1cmwoI3Zpb2xldF9kYXJrKSIgb3BhY2l0eT0iMC44NSIvPgogICAgCiAgICA8IS0tIFRvcCBMZWZ0IFNtYWxsIEhpZ2hsaWdodCAtLT4KICAgIDxwb2x5Z29uIHBvaW50cz0iMjU2LDExMiAyMTAsMTgyIDI1NiwyMjQiIGZpbGw9IiMwMEY1RDQiIG9wYWNpdHk9IjAuOSIvPgogICAgCiAgICA8IS0tIFRvcCBSaWdodCBTbWFsbCBIaWdobGlnaHQgLS0+CiAgICA8cG9seWdvbiBwb2ludHM9IjI1NiwxMTIgMzAyLDE4MiAyNTYsMjI0IiBmaWxsPSIjQzRCNUZEIiBvcGFjaXR5PSIwLjkiLz4KCiAgICA8IS0tIEdsYXNzIFJlZmxlY3Rpb24gRWZmZWN0IChPcHRpb25hbCwgYWRkcyBhIDNEIGdlbSBsb29rKSAtLT4KICAgIDxwb2x5Z29uIHBvaW50cz0iMjU2LDExMiAyMDAsMTYwIDI1NiwyNDAiIGZpbGw9InVybCgjZ2xhc3NfZykiIG9wYWNpdHk9IjAuMTUiIC8+CiAgICAKICAgIDwhLS0gSW5uZXIgRGlhbW9uZCBFZGdlIEhpZ2hsaWdodHMgZm9yIFN0cnVjdHVyZSAtLT4KICAgIDxwYXRoIGQ9Ik0yNTYsMTEyIEwyNTYsNDAwIiBzdHJva2U9IiNGRkZGRkYiIHN0cm9rZS1vcGFjaXR5PSIwLjEiIHN0cm9rZS13aWR0aD0iMS41IiAvPgogICAgPHBhdGggZD0iTTE1NiwyNTYgTDM1NiwyNTYiIHN0cm9rZT0iI0ZGRkZGRiIgc3Ryb2tlLW9wYWNpdHk9IjAuMSIgc3Ryb2tlLXdpZHRoPSIxLjUiIC8+CiAgICA8cGF0aCBkPSJNMjU2LDExMiBMMjEwLDE4MiBMMjU2LDIyNCBMMzAyLDE4MiBaIiBzdHJva2U9IiNGRkZGRkYiIHN0cm9rZS1vcGFjaXR5PSIwLjIiIHN0cm9rZS13aWR0aD0iMSIgZmlsbD0ibm9uZSIgLz4KCiAgPC9nPgo8L3N2Zz4='

// ────────────────────────────────────────────────────────────────────────

const IS_RENDER = process.env.RENDER === 'true' || process.env.RENDER === true

// Optional manual override — set PUPPETEER_EXECUTABLE_PATH locally only if
// you want to point at a specific Chrome install. Never set this on Render.
const EXECUTABLE_PATH_OVERRIDE = process.env.PUPPETEER_EXECUTABLE_PATH || process.env.CHROME_PATH || null

let puppeteer
let chromium = null

if (IS_RENDER) {
  // Production on Render (Linux) — serverless-friendly Chromium binary
  puppeteer = require('puppeteer-core')
  chromium = require('@sparticuz/chromium')
} else {
  // Local dev (Windows/Mac/Linux) — full puppeteer manages its own Chromium
  puppeteer = require('puppeteer')
}

let browserPromise = null

async function launchBrowser() {
  if (IS_RENDER) {
    const executablePath = EXECUTABLE_PATH_OVERRIDE || (await chromium.executablePath())

    // 🔎 Log exactly what we're about to launch — this alone tells you 90%
    // of the time why it works locally but not on Render. Check your
    // Render service logs after a failed generation for these lines.
    console.log('[certificateService] IS_RENDER =', IS_RENDER)
    console.log('[certificateService] executablePath =', executablePath)
    console.log('[certificateService] chromium args =', chromium.args)

    return puppeteer.launch({
      // chromium.args already ships the flags @sparticuz/chromium recommends
      // for constrained/serverless containers. Deliberately NOT adding
      // --single-process here — on recent Chromium builds (147+) it's known
      // to cause crashes/hangs rather than help, due to sandbox/zygote
      // changes upstream. Keep this close to the library defaults.
      args: chromium.args,
      executablePath,
      headless: chromium.headless,
      defaultViewport: chromium.defaultViewport
    })
  }

  // ✅ FIX 1: headless: 'new' → headless: true
  return puppeteer.launch({
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    executablePath: EXECUTABLE_PATH_OVERRIDE || undefined, // undefined = puppeteer's own bundled Chromium
    headless: true   // no more visible black window
  })
}

// Puppeteer v22+ deprecated the `isConnected()` method in favor of a
// `.connected` boolean property; older versions only have the method.
// Support both so this works regardless of which Puppeteer version ends up
// installed locally vs. whatever puppeteer-core resolves to on Render.
function isBrowserConnected(browser) {
  if (typeof browser.isConnected === 'function') return browser.isConnected()
  if (typeof browser.connected === 'boolean') return browser.connected
  return true // unknown API shape — assume connected rather than loop forever
}

async function getBrowser() {
  if (!browserPromise) {
    browserPromise = launchBrowser().catch(err => {
      browserPromise = null
      // 🔎 This is the single most useful log line for the Render issue —
      // it captures the REAL crash reason (missing lib, OOM kill, wrong
      // chromium/puppeteer-core version pairing, etc.) instead of letting
      // the request die with a generic timeout.
      console.error('[certificateService] Failed to launch browser:', err.message)
      console.error(err.stack)
      throw err
    })
  }
  let browser = await browserPromise
  if (!isBrowserConnected(browser)) {
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

    // ✅ FIX 2: Use domcontentloaded + font.ready to avoid blank PDFs
    await page.setContent(buildCertHTML(data), {
      waitUntil: 'domcontentloaded',   // doesn't hang on external fonts
      timeout: 15000
    })

    // Wait for fonts to render (ignoring failure if Google Fonts is blocked)
    await page.evaluate(() => document.fonts.ready).catch(() => {})
    // Optional tiny safety pause (just in case)
    await new Promise(r => setTimeout(r, 300))

    const pdfBytes = await page.pdf({
      width: '1123px', height: '794px',
      printBackground: true,
      pageRanges: '1'
    })
    // Puppeteer v22+ returns a plain Uint8Array here, not a Node Buffer.
    // Buffer.from() ensures we always have a proper Buffer for downstream use.
    return Buffer.from(pdfBytes)
  } catch (err) {
    // 🔎 Surface page-level failures (bad HTML, font timeout, PDF render
    // crash) separately from browser-launch failures above.
    console.error('[certificateService] renderCertPdf failed:', err.message)
    console.error(err.stack)
    throw err
  } finally {
    await page.close()
  }
}

// Shared certificate design tokens — per-level metal palette. Keep this in
// sync with frontend/src/components/certificates/CertificateCard.tsx
// LEVEL_METAL so the downloaded PDF always matches the on-screen preview.
// Level controls the SEAL RING COLOR (gold/silver/bronze = Advanced/Intermediate/Beginner).
const LEVEL_METAL = {
  Advanced:     { sealFrom: '#fcd34d', sealMid: '#d97706', sealTo: '#92400e' },
  Intermediate: { sealFrom: '#e2e8f0', sealMid: '#64748b', sealTo: '#334155' },
  Beginner:     { sealFrom: '#f0b27a', sealMid: '#b87333', sealTo: '#7a4b1f' }
}

// Per-type certificate theme — controls ACCENT COLOR, SUBTITLE, and
// WATERMARK so a SkillCert and a ProjCert are unmistakable at a glance, even
// before reading a word. Keep this in sync with
// frontend/src/components/certificates/CertificateCard.tsx TYPE_THEME.
const TYPE_THEME = {
  skill_cert: {
    label: 'SkillCert',
    typeLabel: 'SkillCert — Verified Skill Certificate',
    accent: '#1d4ed8',
    accentSoft: 'rgba(29,78,216,0.12)',
    subtitle: 'Of Proficiency',
    watermark: 'SKILL ASSESSMENT'
  },
  project_eval: {
    label: 'ProjCert',
    typeLabel: 'ProjCert — Project Evaluation Certificate',
    accent: '#b45309',
    accentSoft: 'rgba(180,83,9,0.12)',
    subtitle: 'Of Project Excellence',
    watermark: 'PROJECT EVALUATION'
  },
  combo_cert: {
    label: 'ComboCert',
    typeLabel: 'ComboCert — Phase 1 + Phase 2 Combined Certificate',
    accent: '#0f766e',
    accentSoft: 'rgba(15,118,110,0.12)',
    subtitle: 'Of Comprehensive Achievement',
    watermark: 'COMBINED CERTIFICATION'
  }
}

function getTypeTheme(type) {
  return TYPE_THEME[type] || TYPE_THEME.skill_cert
}

// Per-type certificate description — keep in sync with
// frontend/src/components/certificates/CertificateCard.tsx getCertDescription
function getCertDescription(type, level, domain) {
  if (type === 'project_eval') {
    return `has successfully designed, built, and delivered a real-world project in
      <strong>${domain}</strong>, demonstrating <strong>${level}</strong>-level proficiency in
      practical implementation, problem-solving, and engineering best practices.`
  }
  if (type === 'combo_cert') {
    return `has successfully completed both a comprehensive skill assessment and a hands-on
      project evaluation in <strong>${domain}</strong>, demonstrating <strong>${level}</strong>-level
      proficiency across theoretical knowledge and real-world application.`
  }
  // default: skill_cert (exam-based)
  return `has successfully completed a rigorous skill assessment, demonstrating
    <strong>${level}</strong>-level proficiency in <strong>${domain}</strong> with strong
    conceptual understanding and practical command of core principles.`
}

// Verification base URL — the printed/PDF link always points here so a
// downloaded certificate is verifiable even outside the app.
const VERIFY_BASE_URL = 'https://proeva.dev/certificate'

// Four corner flourishes for the ornate frame. Drawn once and reused with a
// CSS transform (mirrored/flipped) for the other three corners, so all four
// stay perfectly symmetric and only need one path to maintain.
function cornerFlourishSVG(accent) {
  return `<svg viewBox="0 0 90 90" xmlns="http://www.w3.org/2000/svg" fill="none">
    <path d="M6 60 L6 20 Q6 6 20 6 L60 6" stroke="${accent}" stroke-width="2.5" stroke-linecap="round"/>
    <path d="M6 34 Q22 34 22 18" stroke="${accent}" stroke-width="1.3" opacity="0.55" stroke-linecap="round"/>
    <path d="M34 6 Q34 22 18 22" stroke="${accent}" stroke-width="1.3" opacity="0.55" stroke-linecap="round"/>
    <circle cx="6" cy="6" r="4" fill="${accent}"/>
    <circle cx="6" cy="46" r="2" fill="${accent}" opacity="0.6"/>
    <circle cx="46" cy="6" r="2" fill="${accent}" opacity="0.6"/>
  </svg>`
}

function buildCertHTML(data) {
  const { userName, domain, level, score, type, verificationId, projectTitle, issuedDate, difficulty, metadata } = data
  const metal = LEVEL_METAL[level] || LEVEL_METAL.Advanced
  const theme = getTypeTheme(type)
  const difficultyLabel = difficulty ? String(difficulty).charAt(0).toUpperCase() + String(difficulty).slice(1) : null
  const comboBreakdown = type === 'combo_cert' && metadata
    ? `Phase 1: ${metadata.phase1Score ?? '-'}/100 &middot; Phase 2: ${metadata.phase2Score ?? '-'}/100`
    : null
  const extraLine = comboBreakdown || (projectTitle ? `Project: ${projectTitle}` : '')
  // Certificates are only ever generated for a signed-in, named user, but
  // guard against a blank/undefined name so a rendering bug never produces
  // a certificate that looks unissued.
  const holderName = userName || 'Certificate Holder'
  const description = getCertDescription(type, level, domain)
  const verifyUrl = `${VERIFY_BASE_URL}/${verificationId || ''}`
  const flourish = cornerFlourishSVG(theme.accent)

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <link href="https://fonts.googleapis.com/css2?family=UnifrakturMaguntia&family=Playfair+Display:ital,wght@0,400;0,600;0,700;1,400&family=Cinzel:wght@400;600;700&family=EB+Garamond:ital,wght@0,400;0,500;1,400&display=swap" rel="stylesheet">
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

    /* Top accent stripe — colour identifies the certificate TYPE at a glance */
    .accent-bar {
      position: absolute;
      top: 0; left: 0; right: 0;
      height: 6px;
      background: ${theme.accent};
      z-index: 3;
    }

    /* Faint diagonal watermark naming the certificate type */
    .watermark {
      position: absolute;
      top: 46%;
      left: -8%;
      width: 140%;
      text-align: center;
      transform: rotate(-9deg);
      font-family: 'Cinzel', serif;
      font-weight: 700;
      font-size: 90px;
      letter-spacing: 10px;
      color: ${theme.accent};
      opacity: 0.05;
      z-index: 0;
      pointer-events: none;
      white-space: nowrap;
    }

    /* Ornate double-line frame + four corner flourishes, all in the
       certificate's accent colour so the border reads as one design with
       the seal and top stripe. */
    .ornate-frame {
      position: absolute;
      inset: 22px;
      border: 2px solid ${theme.accent};
      opacity: 0.55;
      z-index: 2;
      pointer-events: none;
    }
    .ornate-frame::after {
      content: '';
      position: absolute;
      inset: 7px;
      border: 1px solid #0f172a;
      opacity: 0.18;
    }
    .corner-flourish {
      position: absolute;
      width: 90px;
      height: 90px;
      z-index: 3;
      pointer-events: none;
    }
    .corner-flourish.tl { top: 20px; left: 20px; }
    .corner-flourish.tr { top: 20px; right: 20px; transform: scaleX(-1); }
    .corner-flourish.bl { bottom: 20px; left: 20px; transform: scaleY(-1); }
    .corner-flourish.br { bottom: 20px; right: 20px; transform: scale(-1,-1); }

    .content {
      position:absolute;
      inset: 0;
      padding: 56px 110px;
      display:flex;
      flex-direction:column;
      justify-content: center;
      align-items: center;
      text-align: center;
      z-index: 1;
    }

    /* Logo lockup: gem mark + wordmark, centered at top */
    .brand-name {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 10px;
      margin-bottom: 14px;
    }

    .brand-logo {
      width: 30px;
      height: 30px;
      border-radius: 8px;
      display: block;
    }

    .brand-wordmark {
      font-family: 'Cinzel', serif;
      font-size: 22px;
      font-weight: 700;
      letter-spacing: 2px;
      color: #0f172a;
    }

    .brand-wordmark span { color: #d97706; }

    /* Seal / badge medallion — the ring colour follows the LEVEL (metal),
       the mark inside is always the Proeva gem logo, so every certificate
       carries the actual brand mark on its badge, not a generic icon. */
    .seal-medallion {
      width: 96px;
      height: 96px;
      border-radius: 50%;
      background: radial-gradient(circle, ${metal.sealFrom} 0%, ${metal.sealMid} 70%, ${metal.sealTo} 100%);
      border: 4px solid #0f172a;
      box-shadow: 0 4px 14px rgba(0,0,0,0.25);
      display: flex;
      align-items: center;
      justify-content: center;
      margin-bottom: 18px;
      position: relative;
    }
    .seal-medallion::after {
      content: '';
      position: absolute;
      width: 74px;
      height: 74px;
      border: 1.5px dashed rgba(255,255,255,0.6);
      border-radius: 50%;
    }
    .seal-logo {
      width: 54px;
      height: 54px;
      border-radius: 12px;
      position: relative;
      z-index: 1;
      box-shadow: 0 2px 8px rgba(0,0,0,0.3);
    }

    .main-title {
      font-family: 'UnifrakturMaguntia', 'Playfair Display', serif;
      font-size: 62px;
      font-weight: 400;
      color: #0f172a;
      line-height: 1.1;
      letter-spacing: 1px;
      margin-bottom: 6px;
    }

    .sub-title-box {
      background-color: #0f172a;
      color: #ffffff;
      font-family: 'Cinzel', sans-serif;
      font-size: 13px;
      font-weight: 600;
      letter-spacing: 5px;
      padding: 5px 22px 4px 26px;
      text-transform: uppercase;
      margin-bottom: 14px;
      display: inline-block;
    }

    /* Type badge — coloured pill so SkillCert / ProjCert / ComboCert
       are distinguishable without reading the fine print */
    .type-badge {
      display: inline-flex;
      align-items: center;
      gap: 7px;
      padding: 5px 16px;
      border-radius: 3px;
      font-family: 'Cinzel', sans-serif;
      font-size: 10px;
      font-weight: 600;
      letter-spacing: 2px;
      text-transform: uppercase;
      color: ${theme.accent};
      background: ${theme.accentSoft};
      border: 1px solid ${theme.accent};
      margin-bottom: 24px;
    }

    .type-badge .dot {
      width: 6px; height: 6px; border-radius: 50%;
      background: ${theme.accent};
      display: inline-block;
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
      border-bottom: 2px solid ${theme.accent};
      padding-bottom: 6px;
      margin-bottom: 22px;
      display: inline-block;
      max-width: 600px;
    }

    .details-text {
      font-family: 'EB Garamond', serif;
      font-size: 19px;
      line-height: 1.6;
      color: #475569;
      margin: 0 auto 8px;
      max-width: 620px;
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
      color: ${theme.accent};
      margin-bottom: 26px;
    }

    .bottom-meta {
      width: 100%;
      max-width: 760px;
      display: flex;
      flex-wrap: wrap;
      gap: 40px;
      justify-content: center;
      align-items: flex-start;
      border-top: 1px solid #e2e8f0;
      padding-top: 16px;
      margin-top: 10px;
    }

    .meta-block { display: flex; flex-direction: column; align-items: center; gap: 4px; }

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

    .authority-line {
      margin-top: 12px;
      font-family: 'EB Garamond', serif;
      font-style: italic;
      font-size: 12px;
      color: #94a3b8;
    }

    .authority-line a {
      color: ${theme.accent};
      text-decoration: none;
      font-style: normal;
      font-weight: 600;
    }
  </style>
</head>
<body>
<div class="page">
  <div class="accent-bar"></div>
  <div class="watermark">${theme.watermark}</div>
  <div class="ornate-frame"></div>
  <div class="corner-flourish tl">${flourish}</div>
  <div class="corner-flourish tr">${flourish}</div>
  <div class="corner-flourish bl">${flourish}</div>
  <div class="corner-flourish br">${flourish}</div>

  <div class="content">
    <div class="brand-name">
      <img class="brand-logo" src="${LOGO_DATA_URI}" alt="Proeva" />
      <span class="brand-wordmark"><span>Proeva</span></span>
    </div>

    <div class="seal-medallion">
      <img class="seal-logo" src="${LOGO_DATA_URI}" alt="Proeva seal" />
    </div>

    <div class="main-title">Certificate</div>
    <div class="sub-title-box">${theme.subtitle}</div>
    <div class="type-badge"><span class="dot"></span>${theme.typeLabel}</div>

    <div class="certifies-that">This certificate is proudly presented to</div>
    <div class="holder-name">${holderName}</div>

    <div class="details-text">
      ${description}
    </div>
    ${extraLine ? `<div class="extra-line">${extraLine}</div>` : '<div style="margin-bottom:26px"></div>'}

    <div class="bottom-meta">
      <div class="meta-block">
        <span class="meta-lbl">Date Issued</span>
        <span class="meta-val">${issuedDate}</span>
      </div>
      <div class="meta-block">
        <span class="meta-lbl">Score Achieved</span>
        <span class="meta-val">${score} / 100</span>
      </div>
      ${difficultyLabel ? `
      <div class="meta-block">
        <span class="meta-lbl">Difficulty</span>
        <span class="meta-val">${difficultyLabel}</span>
      </div>` : ''}
      <div class="meta-block">
        <span class="meta-lbl">Certificate Number</span>
        <span class="v-id">${verificationId || '0000'}</span>
      </div>
    </div>
    <div class="authority-line">Issued by Proeva Assessment Authority &middot; Verify at <a href="${verifyUrl}">${verifyUrl}</a></div>
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