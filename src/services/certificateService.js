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
const LOGO_DATA_URI = 'data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iNjAwIiBoZWlnaHQ9IjYwMCIgdmlld0JveD0iMCAwIDYwMCA2MDAiIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyI+CiAgPGRlZnM+CiAgICA8IS0tIEJhY2tncm91bmQgR3JhZGllbnQgLS0+CiAgICA8cmFkaWFsR3JhZGllbnQgaWQ9ImJnX2ciIGN4PSI1MCUiIGN5PSI1MCUiIHI9IjkwJSI+CiAgICAgIDxzdG9wIG9mZnNldD0iMCUiIHN0b3AtY29sb3I9IiMxQTIwMjgiLz4KICAgICAgPHN0b3Agb2Zmc2V0PSIxMDAlIiBzdG9wLWNvbG9yPSIjMEEwRDEyIi8+CiAgICA8L3JhZGlhbEdyYWRpZW50PgoKICAgIDwhLS0gRGlhbW9uZCBCYXNlIEdyYWRpZW50cyAtLT4KICAgIDxsaW5lYXJHcmFkaWVudCBpZD0idGVhbF9nIiB4MT0iMCUiIHkxPSIwJSIgeDI9IjEwMCUiIHkyPSIxMDAlIj4KICAgICAgPHN0b3Agb2Zmc2V0PSIwJSIgc3RvcC1jb2xvcj0iIzAwRjVENCIvPgogICAgICA8c3RvcCBvZmZzZXQ9IjEwMCUiIHN0b3AtY29sb3I9IiMwMEEzODkiLz4KICAgIDwvbGluZWFyR3JhZGllbnQ+CiAgICA8bGluZWFyR3JhZGllbnQgaWQ9InZpb2xldF9nIiB4MT0iMCUiIHkxPSIwJSIgeDI9IjEwMCUiIHkyPSIxMDAlIj4KICAgICAgPHN0b3Agb2Zmc2V0PSIwJSIgc3RvcC1jb2xvcj0iI0E3OEJGQSIvPgogICAgICA8c3RvcCBvZmZzZXQ9IjEwMCUiIHN0b3AtY29sb3I9IiM2RDI4RDkiLz4KICAgIDwvbGluZWFyR3JhZGllbnQ+CiAgICAKICAgIDwhLS0gRGlhbW9uZCBEYXJrIEZhY2V0cyAoU2hhZG93KSAtLT4KICAgIDxsaW5lYXJHcmFkaWVudCBpZD0idGVhbF9kYXJrIiB4MT0iMCUiIHkxPSIwJSIgeDI9IjEwMCUiIHkyPSIxMDAlIj4KICAgICAgPHN0b3Agb2Zmc2V0PSIwJSIgc3RvcC1jb2xvcj0iIzAwODU3MyIvPgogICAgICA8c3RvcCBvZmZzZXQ9IjEwMCUiIHN0b3AtY29sb3I9IiMwMDREM0YiLz4KICAgIDwvbGluZWFyR3JhZGllbnQ+CiAgICA8bGluZWFyR3JhZGllbnQgaWQ9InZpb2xldF9kYXJrIiB4MT0iMCUiIHkxPSIwJSIgeDI9IjEwMCUiIHkyPSIxMDAlIj4KICAgICAgPHN0b3Agb2Zmc2V0PSIwJSIgc3RvcC1jb2xvcj0iIzVBM0ZDQyIvPgogICAgICA8c3RvcCBvZmZzZXQ9IjEwMCUiIHN0b3AtY29sb3I9IiMyRTFBNzMiLz4KICAgIDwvbGluZWFyR3JhZGllbnQ+CgogICAgPCEtLSBHbGFzcyBIaWdobGlnaHQgR3JhZGllbnQgLS0+CiAgICA8bGluZWFyR3JhZGllbnQgaWQ9ImdsYXNzX2ciIHgxPSIwJSIgeTE9IjAlIiB4Mj0iMCUiIHkyPSIxMDAlIj4KICAgICAgPHN0b3Agb2Zmc2V0PSIwJSIgc3RvcC1jb2xvcj0iI0ZGRkZGRiIgc3RvcC1vcGFjaXR5PSIwLjgiLz4KICAgICAgPHN0b3Agb2Zmc2V0PSIxMDAlIiBzdG9wLWNvbG9yPSIjRkZGRkZGIiBzdG9wLW9wYWNpdHk9IjAiLz4KICAgIDwvbGluZWFyR3JhZGllbnQ+CgogICAgPCEtLSBQcm9mZXNzaW9uYWwgR2xvdyBiZWhpbmQgdGhlIGRpYW1vbmQgLS0+CiAgICA8cmFkaWFsR3JhZGllbnQgaWQ9Imdsb3dfZyIgY3g9IjUwJSIgY3k9IjUwJSIgcj0iNTAlIj4KICAgICAgPHN0b3Agb2Zmc2V0PSIwJSIgc3RvcC1jb2xvcj0iIzAwRjVENCIgc3RvcC1vcGFjaXR5PSIwLjIiLz4KICAgICAgPHN0b3Agb2Zmc2V0PSIxMDAlIiBzdG9wLWNvbG9yPSIjMDBGNUQ0IiBzdG9wLW9wYWNpdHk9IjAiLz4KICAgIDwvcmFkaWFsR3JhZGllbnQ+CgogICAgPCEtLSBTdWJ0bGUgQm9yZGVyIEdyYWRpZW50IC0tPgogICAgPGxpbmVhckdyYWRpZW50IGlkPSJib3JkZXJfZyIgeDE9IjAlIiB5MT0iMCUiIHgyPSIxMDAlIiB5Mj0iMTAwJSI+CiAgICAgIDxzdG9wIG9mZnNldD0iMCUiIHN0b3AtY29sb3I9IiMyQTMxM0MiIHN0b3Atb3BhY2l0eT0iMC44Ii8+CiAgICAgIDxzdG9wIG9mZnNldD0iMTAwJSIgc3RvcC1jb2xvcj0iIzE0MUEyNCIgc3RvcC1vcGFjaXR5PSIwLjgiLz4KICAgIDwvbGluZWFyR3JhZGllbnQ+CiAgPC9kZWZzPgoKICA8IS0tIEJhY2tncm91bmQgQ2FyZCAtLT4KICA8cmVjdCB4PSIwIiB5PSIwIiB3aWR0aD0iNjAwIiBoZWlnaHQ9IjYwMCIgcng9IjE0MCIgZmlsbD0idXJsKCNiZ19nKSIvPgogIDxyZWN0IHg9IjIiIHk9IjIiIHdpZHRoPSI1OTYiIGhlaWdodD0iNTk2IiByeD0iMTM4IiBmaWxsPSJub25lIiBzdHJva2U9InVybCgjYm9yZGVyX2cpIiBzdHJva2Utd2lkdGg9IjIiLz4KCiAgPCEtLSBBbWJpZW50IEdsb3cgYmVoaW5kIHRoZSBkaWFtb25kIC0tPgogIDxjaXJjbGUgY3g9IjMwMCIgY3k9IjI4OCIgcj0iMTgwIiBmaWxsPSJ1cmwoI2dsb3dfZykiIC8+CgogIDwhLS0gRGlhbW9uZCBMb2dvIEdyb3VwIChDZW50ZXJlZCkgLS0+CiAgPGcgdHJhbnNmb3JtPSJ0cmFuc2xhdGUoNDQsIDMyKSI+CiAgICAKICAgIDwhLS0gTGVmdCBMYXJnZSBGYWNldCAtLT4KICAgIDxwb2x5Z29uIHBvaW50cz0iMjU2LDExMiAxNTYsMjU2IDI1Niw0MDAiIGZpbGw9InVybCgjdGVhbF9nKSIvPgogICAgCiAgICA8IS0tIFJpZ2h0IExhcmdlIEZhY2V0IC0tPgogICAgPHBvbHlnb24gcG9pbnRzPSIyNTYsMTEyIDM1NiwyNTYgMjU2LDQwMCIgZmlsbD0idXJsKCN2aW9sZXRfZykiLz4KICAgIAogICAgPCEtLSBCb3R0b20gTGVmdCBEYXJrIEZhY2V0IC0tPgogICAgPHBvbHlnb24gcG9pbnRzPSIxNTYsMjU2IDI1Niw0MDAgMjU2LDMwMCIgZmlsbD0idXJsKCN0ZWFsX2RhcmspIiBvcGFjaXR5PSIwLjg1Ii8+CiAgICAKICAgIDwhLS0gQm90dG9tIFJpZ2h0IERhcmsgRmFjZXQgLS0+CiAgICA8cG9seWdvbiBwb2ludHM9IjM1NiwyNTYgMjU2LDQwMCAyNTYsMzAwIiBmaWxsPSJ1cmwoI3Zpb2xldF9kYXJrKSIgb3BhY2l0eT0iMC44NSIvPgogICAgCiAgICA8IS0tIFRvcCBMZWZ0IFNtYWxsIEhpZ2hsaWdodCAtLT4KICAgIDxwb2x5Z29uIHBvaW50cz0iMjU2LDExMiAyMTAsMTgyIDI1NiwyMjQiIGZpbGw9IiMwMEY1RDQiIG9wYWNpdHk9IjAuOSIvPgogICAgCiAgICA8IS0tIFRvcCBSaWdodCBTbWFsbCBIaWdobGlnaHQgLS0+CiAgICA8cG9seWdvbiBwb2ludHM9IjI1NiwxMTIgMzAyLDE4MiAyNTYsMjI0IiBmaWxsPSIjQzRCNUZEIiBvcGFjaXR5PSIwLjkiLz4KCiAgICA8IS0tIEdsYXNzIFJlZmxlY3Rpb24gRWZmZWN0IChPcHRpb25hbCwgYWRkcyBhIDNEIGdlbSBsb29rKSAtLT4KICAgIDxwb2x5Z29uIHBvaW50cz0iMjU2LDExMiAyMDAsMTYwIDI1NiwyNDAiIGZpbGw9InVybCgjZ2xhc3NfZykiIG9wYWNpdHk9IjAuMTUiIC8+CiAgICAKICAgIDwhLS0gSW5uZXIgRGlhbW9uZCBFZGdlIEhpZ2hsaWdodHMgZm9yIFN0cnVjdHVyZSAtLT4KICAgIDxwYXRoIGQ9Ik0yNTYsMTEyIEwyNTYsNDAwIiBzdHJva2U9IiNGRkZGRkYiIHN0cm9rZS1vcGFjaXR5PSIwLjEiIHN0cm9rZS13aWR0aD0iMS41IiAvPgogICAgPHBhdGggZD0iTTE1NiwyNTYgTDM1NiwyNTYiIHN0cm9rZT0iI0ZGRkZGRiIgc3Ryb2tlLW9wYWNpdHk9IjAuMSIgc3Ryb2tlLXdpZHRoPSIxLjUiIC8+CiAgICA8cGF0aCBkPSJNMjU2LDExMiBMMjEwLDE4MiBMMjU2LDIyNCBMMzAyLDE4MiBaIiBzdHJva2U9IiNGRkZGRkYiIHN0cm9rZS1vcGFjaXR5PSIwLjIiIHN0cm9rZS13aWR0aD0iMSIgZmlsbD0ibm9uZSIgLz4KCiAgPC9nPgo8L3N2Zz4='

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
// Level controls the SEAL COLOR (gold/silver/bronze = Advanced/Intermediate/Beginner).
const LEVEL_METAL = {
  Advanced:     { sealFrom: '#fcd34d', sealMid: '#d97706', sealTo: '#92400e' },
  Intermediate: { sealFrom: '#e2e8f0', sealMid: '#64748b', sealTo: '#334155' },
  Beginner:     { sealFrom: '#f0b27a', sealMid: '#b87333', sealTo: '#7a4b1f' }
}

// Per-type certificate theme — controls ACCENT COLOR, ICON, SUBTITLE, and
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
    watermark: 'SKILL ASSESSMENT',
    // shield + checkmark
    iconPaths: '<path d="M12 3.2l6.2 2.3v5.1c0 4.6-2.7 8-6.2 9.2-3.5-1.2-6.2-4.6-6.2-9.2V5.5L12 3.2z"/><path d="M8.7 12.4l2.3 2.3 4.3-4.6"/>'
  },
  project_eval: {
    label: 'ProjCert',
    typeLabel: 'ProjCert — Project Evaluation Certificate',
    accent: '#b45309',
    accentSoft: 'rgba(180,83,9,0.12)',
    subtitle: 'Of Project Excellence',
    watermark: 'PROJECT EVALUATION',
    // drafting compass
    iconPaths: '<path d="M12 4.2v3.4"/><circle cx="12" cy="4.2" r="1.3" fill="#ffffff"/><path d="M12 7.6L7.6 19M12 7.6L16.4 19"/><path d="M9.2 15.2h5.6"/>'
  },
  combo_cert: {
    label: 'ComboCert',
    typeLabel: 'ComboCert — Phase 1 + Phase 2 Combined Certificate',
    accent: '#0f766e',
    accentSoft: 'rgba(15,118,110,0.12)',
    subtitle: 'Of Comprehensive Achievement',
    watermark: 'COMBINED CERTIFICATION',
    // twin stars
    iconPaths: '<path d="M8.2 4.6l1.1 2.3 2.5.9-2.5.9-1.1 2.3-1.1-2.3-2.5-.9 2.5-.9 1.1-2.3z"/><path d="M15.8 10.2l1.1 2.3 2.5.9-2.5.9-1.1 2.3-1.1-2.3-2.5-.9 2.5-.9 1.1-2.3z"/>'
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

    /* Metallic badge overlapping the ribbon — colour follows LEVEL,
       icon inside follows TYPE */
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
      z-index: 1;
    }

    /* Logo lockup: gem mark + wordmark, top-right corner */
    .brand-name {
      position: absolute;
      top: 50px;
      right: 80px;
      display: flex;
      align-items: center;
      gap: 10px;
      z-index: 2;
    }

    .brand-logo {
      width: 34px;
      height: 34px;
      border-radius: 9px;
      display: block;
    }

    .brand-wordmark {
      font-family: 'Cinzel', serif;
      font-size: 26px;
      font-weight: 700;
      letter-spacing: 2px;
      color: #0f172a;
    }

    .brand-wordmark span { color: #d97706; }

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
      margin-bottom: 26px;
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
      color: ${theme.accent};
      margin-bottom: 30px;
    }

    .bottom-meta {
      width: 100%;
      max-width: 760px;
      display: flex;
      flex-wrap: wrap;
      gap: 32px;
      justify-content: space-between;
      align-items: flex-end;
      border-top: 1px solid #e2e8f0;
      padding-top: 16px;
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

    .authority-line {
      margin-top: 10px;
      font-family: 'EB Garamond', serif;
      font-style: italic;
      font-size: 11px;
      color: #94a3b8;
    }
  </style>
</head>
<body>
<div class="page">
  <div class="accent-bar"></div>
  <div class="watermark">${theme.watermark}</div>
  <div class="vertical-ribbon"></div>
  <div class="gold-seal">
     <svg width="45" height="45" viewBox="0 0 24 24" fill="none" stroke="#ffffff" stroke-width="1.25">
       ${theme.iconPaths}
     </svg>
  </div>

  <div class="content">
    <div class="brand-name">
      <img class="brand-logo" src="${LOGO_DATA_URI}" alt="Proeva" />
      <span class="brand-wordmark"><span>Proeva</span></span>
    </div>

    <div class="main-title">Certificate</div>
    <div class="sub-title-box">${theme.subtitle}</div>
    <div class="type-badge"><span class="dot"></span>${theme.typeLabel}</div>

    <div class="certifies-that">This certificate is proudly presented to</div>
    <div class="holder-name">${holderName}</div>

    <div class="details-text">
      ${description}
    </div>
    ${extraLine ? `<div class="extra-line">${extraLine}</div>` : '<div style="margin-bottom:30px"></div>'}

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
    <div class="authority-line">Issued by Proeva Assessment Authority &middot; Verifiable at proeva.io/verify</div>
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