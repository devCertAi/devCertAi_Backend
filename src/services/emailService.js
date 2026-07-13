const { sendTransactionalEmail } = require('../config/brevoClient')

const BRAND_COLOR = '#6C63FF'
const BG = '#0A0A0F'
const SURFACE = '#13131A'
const TEXT = '#F1F1F3'
const MUTED = '#8B8B9E'

function baseTemplate(content) {
  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="color-scheme" content="dark light">
  <meta name="supported-color-schemes" content="dark light">
  <style>
    /* Tell Gmail/Outlook/Apple Mail dark-mode engines this is already a
       dark design so they don't "helpfully" re-invert our own colors —
       that auto-inversion is the usual cause of dark text landing on a
       dark background even when our own CSS looks correct. */
    :root { color-scheme: dark light; supported-color-schemes: dark light; }
    [data-ogsc] .card, [data-ogsc] body { background: ${BG} !important; }
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { background: ${BG}; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; color: ${TEXT}; }
    .wrapper { max-width: 600px; margin: 0 auto; padding: 40px 20px; }
    .card { background: ${SURFACE}; border-radius: 16px; border: 1px solid rgba(255,255,255,0.07); padding: 40px; }
    .logo { font-size: 22px; font-weight: 700; color: ${BRAND_COLOR}; letter-spacing: -0.5px; margin-bottom: 32px; }
    .title { font-size: 24px; font-weight: 700; margin-bottom: 12px; }
    .text { color: ${MUTED}; line-height: 1.6; margin-bottom: 16px; }
    .btn { display: inline-block; background: ${BRAND_COLOR}; color: #fff; text-decoration: none; padding: 14px 28px; border-radius: 12px; font-weight: 600; font-size: 15px; margin: 8px 0; }
    .divider { border: none; border-top: 1px solid rgba(255,255,255,0.07); margin: 24px 0; }
    .badge { display: inline-block; padding: 4px 14px; border-radius: 20px; font-size: 13px; font-weight: 600; }
    .badge-success { background: rgba(34,197,94,0.15); color: #22C55E; }
    .badge-error { background: rgba(239,68,68,0.15); color: #EF4444; }
    .badge-warning { background: rgba(245,158,11,0.15); color: #F59E0B; }
    .badge-primary { background: rgba(108,99,255,0.15); color: ${BRAND_COLOR}; }
    .score { font-size: 48px; font-weight: 800; color: ${BRAND_COLOR}; }
    .footer { text-align: center; color: ${MUTED}; font-size: 12px; margin-top: 24px; }
    .unsubscribe { color: ${MUTED}; text-decoration: underline; font-size: 12px; }
    .feature-item { display: flex; align-items: flex-start; gap: 12px; margin-bottom: 12px; }
    .feature-icon { color: #22C55E; font-size: 16px; margin-top: 2px; }
    .stat-row { display: flex; justify-content: space-between; padding: 10px 0; border-bottom: 1px solid rgba(255,255,255,0.05); font-size: 14px; }
  </style>
</head>
<body>
  <div class="wrapper" style="max-width:600px; margin:0 auto; padding:40px 20px;">
    <div class="card" style="background:${SURFACE}; border-radius:16px; border:1px solid rgba(255,255,255,0.07); padding:40px; color:${TEXT};">
      <div class="logo" style="font-size:22px; font-weight:700; color:${BRAND_COLOR}; letter-spacing:-0.5px; margin-bottom:32px;">Proeva</div>
      ${content}
    </div>
    <div class="footer" style="text-align:center; color:${MUTED}; font-size:12px; margin-top:24px;">
      <p style="margin-bottom:8px">© ${new Date().getFullYear()} Proeva. AI-powered skill certification.</p>
      <a href="${process.env.FRONTEND_URL}/settings" class="unsubscribe" style="color:${MUTED}; text-decoration:underline; font-size:12px;">Manage email preferences</a>
    </div>
  </div>
</body>
</html>`
}

async function sendEmail({ to, subject, html }) {
  if (!process.env.BREVO_API_KEY) {
    // FIX: this used to be the ONLY signal that email was disabled, and it
    // was easy to miss in a busy log stream — certificate/exam emails would
    // appear to "just not happen" with no obvious cause. Keep this per-send
    // warning so it's the thing that shows up right next to the specific
    // user/subject.
    console.warn(`[Email] SKIPPED (BREVO_API_KEY not set) — would have sent to ${to}: "${subject}"`)
    return
  }
  try {
    // FIX: sending via Brevo's SMTP relay (nodemailer, port 587) worked
    // locally but hung and timed out in production — Render (and several
    // other hosts) block outbound SMTP ports even when credentials are
    // correct. Switched to Brevo's HTTP API, which travels over normal
    // HTTPS (443) and isn't subject to that restriction.
    await sendTransactionalEmail({
      to,
      subject,
      html,
      fromEmail: process.env.MAIL_FROM || 'hello@proeva.dev',
    })
    console.log(`[Email] Sent to ${to}: "${subject}"`)
  } catch (err) {
    // FIX: previously any send failure (bad credentials, provider rate
    // limit, invalid recipient, etc.) bubbled up as an unhandled rejection
    // inside emailWorker's job processor and was only visible as a generic
    // "[Queue] Inline job failed" / Bull failed-job log — with no
    // indication it was specifically an email delivery problem. Log it
    // explicitly here so it's unambiguous, then rethrow so the queue's
    // normal retry/error handling still applies.
    const detail = err.response?.data?.message || err.message
    console.error(`[Email] FAILED to send to ${to}: "${subject}" —`, detail)
    throw err
  }
}

// 1. Welcome + Verify Email
async function sendVerifyEmail(user, verifyUrl) {
  await sendEmail({
    to: user.email,
    subject: 'Verify your Proeva account',
    html: baseTemplate(`
      <div class="title" style="font-size:24px; font-weight:700; margin-bottom:12px; color:${TEXT};">Welcome to Proeva, ${user.name}! 👋</div>
      <p class="text" style="color:${MUTED}; line-height:1.6; margin-bottom:16px;">You're one step away from getting AI-certified. Verify your email to unlock your account.</p>
      <a href="${verifyUrl}" class="btn" style="display:inline-block; background:${BRAND_COLOR}; color:#ffffff; text-decoration:none; padding:14px 28px; border-radius:12px; font-weight:600; font-size:15px; margin:8px 0;">Verify Email →</a>
      <hr class="divider" style="border:none; border-top:1px solid rgba(255,255,255,0.07); margin:24px 0;">
      <p class="text" style="color:${MUTED}; line-height:1.6; margin-bottom:16px; font-size:13px">This link expires in 24 hours. If you didn't sign up, you can safely ignore this email.</p>
    `)
  })
}

// 2. Email verified
async function sendWelcomeEmail(user) {
  await sendEmail({
    to: user.email,
    subject: "You're verified! Let's get started",
    html: baseTemplate(`
      <div class="title" style="font-size:24px; font-weight:700; margin-bottom:12px; color:${TEXT};">You're all set! 🎉</div>
      <p class="text" style="color:${MUTED}; line-height:1.6; margin-bottom:16px;">Your Proeva account is verified. Here's what to do next:</p>
      <div class="feature-item" style="display:flex; align-items:flex-start; gap:12px; margin-bottom:12px; color:${TEXT};"><span class="feature-icon" style="color:#4ADE80; font-size:16px; margin-top:2px;">✓</span><span>Submit a project from GitHub for instant AI evaluation</span></div>
      <div class="feature-item" style="display:flex; align-items:flex-start; gap:12px; margin-bottom:12px; color:${TEXT};"><span class="feature-icon" style="color:#4ADE80; font-size:16px; margin-top:2px;">✓</span><span>Take a proctored skill exam to earn a SkillCert</span></div>
      <div class="feature-item" style="display:flex; align-items:flex-start; gap:12px; margin-bottom:12px; color:${TEXT};"><span class="feature-icon" style="color:#4ADE80; font-size:16px; margin-top:2px;">✓</span><span>Download and share your certificate on LinkedIn</span></div>
      <br>
      <a href="${process.env.FRONTEND_URL}/dashboard" class="btn" style="display:inline-block; background:${BRAND_COLOR}; color:#ffffff; text-decoration:none; padding:14px 28px; border-radius:12px; font-weight:600; font-size:15px; margin:8px 0;">Go to Dashboard →</a>
    `)
  })
}

// 3. Password reset
async function sendPasswordResetEmail(user, resetUrl) {
  await sendEmail({
    to: user.email,
    subject: 'Reset your Proeva password',
    html: baseTemplate(`
      <div class="title" style="font-size:24px; font-weight:700; margin-bottom:12px; color:${TEXT};">Password Reset Request</div>
      <p class="text" style="color:${MUTED}; line-height:1.6; margin-bottom:16px;">You requested a password reset. Click the button below to set a new password.</p>
      <a href="${resetUrl}" class="btn" style="display:inline-block; background:${BRAND_COLOR}; color:#ffffff; text-decoration:none; padding:14px 28px; border-radius:12px; font-weight:600; font-size:15px; margin:8px 0;">Reset Password →</a>
      <hr class="divider" style="border:none; border-top:1px solid rgba(255,255,255,0.07); margin:24px 0;">
      <p class="text" style="color:${MUTED}; line-height:1.6; margin-bottom:16px; font-size:13px">⚠️ This link expires in <strong>1 hour</strong>. If you didn't request this, your account is safe — just ignore this email.</p>
    `)
  })
}

// 4. Project evaluation complete
async function sendEvaluationCompleteEmail(user, project, report) {
  const scoreColor = report.overallScore >= 75 ? '#22C55E' : report.overallScore >= 50 ? '#F59E0B' : '#EF4444'
  await sendEmail({
    to: user.email,
    subject: `Your project scored ${report.overallScore}/100`,
    html: baseTemplate(`
      <div class="title" style="font-size:24px; font-weight:700; margin-bottom:12px; color:${TEXT};">Project Evaluation Complete 🔍</div>
      <p class="text" style="color:${MUTED}; line-height:1.6; margin-bottom:16px;">Your project <strong>"${project.title}"</strong> has been evaluated.</p>
      <div style="text-align:center; padding: 24px 0;">
        <div class="score" style="font-size:48px; font-weight:800; color:${BRAND_COLOR}; color:${scoreColor}">${report.overallScore}/100</div>
        <span class="badge badge-primary" style="display:inline-block; padding:4px 14px; border-radius:20px; font-size:13px; font-weight:600; background:rgba(108,99,255,0.18); color:#A5A0FF; margin-top:8px">${report.level}</span>
      </div>
      <p class="text" style="color:${MUTED}; line-height:1.6; margin-bottom:16px;"><strong>Summary:</strong> ${report.summary}</p>
      ${report.strengths?.length ? `<p class="text" style="color:${MUTED}; line-height:1.6; margin-bottom:16px;"><strong>Key Strengths:</strong><br>${report.strengths.slice(0, 3).map(s => `• ${s}`).join('<br>')}</p>` : ''}
      <a href="${process.env.FRONTEND_URL}/projects/${project.id}" class="btn" style="display:inline-block; background:${BRAND_COLOR}; color:#ffffff; text-decoration:none; padding:14px 28px; border-radius:12px; font-weight:600; font-size:15px; margin:8px 0;">View Full Report →</a>
      ${report.overallScore >= 40 ? `<br><a href="${process.env.FRONTEND_URL}/certificates" class="btn" style="display:inline-block; background:${BRAND_COLOR}; color:#ffffff; text-decoration:none; padding:14px 28px; border-radius:12px; font-weight:600; font-size:15px; margin:8px 0; background:#22C55E; margin-top:8px">Download Certificate →</a>` : ''}
    `)
  })
}

// 4b. Project evaluation failed (credit refunded)
async function sendEvaluationFailedEmail(user, project) {
  await sendEmail({
    to: user.email,
    subject: `We couldn't evaluate "${project.title}" — credit refunded`,
    html: baseTemplate(`
      <div class="title" style="font-size:24px; font-weight:700; margin-bottom:12px; color:${TEXT};">Project Evaluation Failed</div>
      <p class="text" style="color:${MUTED}; line-height:1.6; margin-bottom:16px;">We ran into a problem evaluating your project <strong>"${project.title}"</strong> and couldn't finish the analysis.</p>
      <p class="text" style="color:${MUTED}; line-height:1.6; margin-bottom:16px;">The credit charged for this submission has been refunded to your account — no charge for this attempt.</p>
      <a href="${process.env.FRONTEND_URL}/projects/${project.id}" class="btn" style="display:inline-block; background:${BRAND_COLOR}; color:#ffffff; text-decoration:none; padding:14px 28px; border-radius:12px; font-weight:600; font-size:15px; margin:8px 0;">View Project & Re-evaluate →</a>
    `)
  })
}

// 5. Exam result
async function sendExamResultEmail(user, attempt) {
  const passed = (attempt.totalScore || 0) >= 50
  await sendEmail({
    to: user.email,
    subject: `Exam result: ${passed ? 'PASSED ✓' : 'FAILED ✗'} — ${attempt.domain}`,
    html: baseTemplate(`
      <div class="title" style="font-size:24px; font-weight:700; margin-bottom:12px; color:${TEXT};">Exam Result: ${attempt.domain}</div>
      <div style="text-align:center; padding: 24px 0;">
        <div class="score" style="font-size:48px; font-weight:800; color:${BRAND_COLOR}; color:${passed ? '#22C55E' : '#EF4444'}">${attempt.totalScore || 0}/100</div>
        <span class="badge ${passed ? 'badge-success' : 'badge-error'}" style="display:inline-block; padding:4px 14px; border-radius:20px; font-size:13px; font-weight:600; margin-top:8px; ${passed ? 'background:rgba(34,197,94,0.18); color:#4ADE80;' : 'background:rgba(239,68,68,0.18); color:#F87171;'}">${passed ? '✓ PASSED' : '✗ FAILED'}</span>
      </div>
      ${passed
        ? `<p class="text" style="color:${MUTED}; line-height:1.6; margin-bottom:16px;">Congratulations! You've passed the ${attempt.domain} exam. Your certificate is being generated.</p>
           <a href="${process.env.FRONTEND_URL}/certificates" class="btn" style="display:inline-block; background:${BRAND_COLOR}; color:#ffffff; text-decoration:none; padding:14px 28px; border-radius:12px; font-weight:600; font-size:15px; margin:8px 0;">View Certificate →</a>`
        : `<p class="text" style="color:${MUTED}; line-height:1.6; margin-bottom:16px;">You scored ${attempt.totalScore || 0}/100. The passing score is 50/100. Keep studying and try again!</p>
           <a href="${process.env.FRONTEND_URL}/exam" class="btn" style="display:inline-block; background:${BRAND_COLOR}; color:#ffffff; text-decoration:none; padding:14px 28px; border-radius:12px; font-weight:600; font-size:15px; margin:8px 0; background:#8B8B9E">Retry Exam →</a>`
      }
    `)
  })
}

// 6. Certificate ready
async function sendCertificateReadyEmail(user, certificate) {
  await sendEmail({
    to: user.email,
    subject: '🎓 Your Proeva certificate is ready',
    html: baseTemplate(`
      <div class="title" style="font-size:24px; font-weight:700; margin-bottom:12px; color:${TEXT};">Your Certificate is Ready! 🎓</div>
      <p class="text" style="color:${MUTED}; line-height:1.6; margin-bottom:16px;">Congratulations! Your <strong>${certificate.level}</strong> level certificate for <strong>${certificate.domain}</strong> is ready to download and share.</p>
      <div style="background:rgba(108,99,255,0.1); border:1px solid rgba(108,99,255,0.3); border-radius:12px; padding:20px; margin:16px 0; text-align:center;">
        <div style="font-size:13px; color:${MUTED}">Certificate ID</div>
        <div style="font-family:monospace; font-size:14px; color:${TEXT}">${certificate.verificationId}</div>
        <div style="font-size:13px; color:${MUTED}; margin-top:8px">Score: ${certificate.score}/100 • ${certificate.level}</div>
      </div>
      <a href="${process.env.FRONTEND_URL}/certificate/${certificate.verificationId}" class="btn" style="display:inline-block; background:${BRAND_COLOR}; color:#ffffff; text-decoration:none; padding:14px 28px; border-radius:12px; font-weight:600; font-size:15px; margin:8px 0;">View & Download Certificate →</a>
    `)
  })
}

// 7. Payment confirmed
async function sendPaymentConfirmedEmail(user, payment) {
  const { PLAN_DURATIONS, PLAN_CREDITS } = require('../validators/paymentValidators')
  const durationDays = PLAN_DURATIONS[payment.plan] || 30
  const expiry = new Date(Date.now() + durationDays * 24 * 60 * 60 * 1000)
  const bundle = PLAN_CREDITS[payment.plan] || { project: 0, skill: 0 }
  const planLabel = payment.plan.charAt(0).toUpperCase() + payment.plan.slice(1)

  await sendEmail({
    to: user.email,
    subject: 'Premium activated — enjoy Proeva Pro',
    html: baseTemplate(`
      <div class="title" style="font-size:24px; font-weight:700; margin-bottom:12px; color:${TEXT};">Welcome to Proeva Premium! ⚡</div>
      <span class="badge badge-primary" style="display:inline-block; padding:4px 14px; border-radius:20px; font-size:13px; font-weight:600; background:rgba(108,99,255,0.18); color:#A5A0FF;">Premium ${planLabel}</span>
      <p class="text" style="color:${MUTED}; line-height:1.6; margin-bottom:16px; margin-top:16px">Your credits are active until <strong>${expiry.toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' })}</strong>.</p>
      <div style="margin:16px 0">
        <div class="feature-item" style="display:flex; align-items:flex-start; gap:12px; margin-bottom:12px; color:${TEXT};"><span class="feature-icon" style="color:#4ADE80; font-size:16px; margin-top:2px;">✓</span><span>${bundle.project} project evaluation credit${bundle.project === 1 ? '' : 's'} with detailed AI reports</span></div>
        <div class="feature-item" style="display:flex; align-items:flex-start; gap:12px; margin-bottom:12px; color:${TEXT};"><span class="feature-icon" style="color:#4ADE80; font-size:16px; margin-top:2px;">✓</span><span>${bundle.skill} skill exam credit${bundle.skill === 1 ? '' : 's'}</span></div>
        <div class="feature-item" style="display:flex; align-items:flex-start; gap:12px; margin-bottom:12px; color:${TEXT};"><span class="feature-icon" style="color:#4ADE80; font-size:16px; margin-top:2px;">✓</span><span>Ad-free experience across all pages</span></div>
        <div class="feature-item" style="display:flex; align-items:flex-start; gap:12px; margin-bottom:12px; color:${TEXT};"><span class="feature-icon" style="color:#4ADE80; font-size:16px; margin-top:2px;">✓</span><span>Priority evaluation queue — faster results</span></div>
      </div>
      <a href="${process.env.FRONTEND_URL}/dashboard" class="btn" style="display:inline-block; background:${BRAND_COLOR}; color:#ffffff; text-decoration:none; padding:14px 28px; border-radius:12px; font-weight:600; font-size:15px; margin:8px 0;">Go to Dashboard →</a>
    `)
  })
}

// ============================================================================
// RECRUITER HIRING PIPELINE EMAILS (§6)
// All sent via emailWorker's 'application_status' / 'job_match' / 'recruiter_digest'
// cases — pipelineService/matchWorker never call nodemailer directly.
// ============================================================================

// 8. Application received
async function sendApplicationReceivedEmail(user, jobPosting) {
  await sendEmail({
    to: user.email,
    subject: `Application received — ${jobPosting.title} at ${jobPosting.companyName}`,
    html: baseTemplate(`
      <div class="title" style="font-size:24px; font-weight:700; margin-bottom:12px; color:${TEXT};">Application Received ✅</div>
      <p class="text" style="color:${MUTED}; line-height:1.6; margin-bottom:16px;">Thanks for applying to <strong>${jobPosting.title}</strong> at <strong>${jobPosting.companyName}</strong>.
      Our screening process is automatic and AI-assisted — we'll email you as soon as there's an update.</p>
      <a href="${process.env.FRONTEND_URL}/dashboard" class="btn" style="display:inline-block; background:${BRAND_COLOR}; color:#ffffff; text-decoration:none; padding:14px 28px; border-radius:12px; font-weight:600; font-size:15px; margin:8px 0;">View Application Status →</a>
    `)
  })
}

// 9. Screening rejection (stage 1 rule-based or stage 2 AI match)
async function sendScreeningRejectionEmail(user, jobPosting, reason) {
  await sendEmail({
    to: user.email,
    subject: `Update on your application — ${jobPosting.title}`,
    html: baseTemplate(`
      <div class="title" style="font-size:24px; font-weight:700; margin-bottom:12px; color:${TEXT};">Application Update</div>
      <span class="badge badge-error" style="display:inline-block; padding:4px 14px; border-radius:20px; font-size:13px; font-weight:600; background:rgba(239,68,68,0.18); color:#F87171;">Not moving forward</span>
      <p class="text" style="color:${MUTED}; line-height:1.6; margin-bottom:16px; margin-top:16px">Thanks for your interest in <strong>${jobPosting.title}</strong> at <strong>${jobPosting.companyName}</strong>.
      After an initial automated review, we won't be moving forward with your application at this time.</p>
      <div style="background:rgba(255,255,255,0.03); border-radius:12px; padding:16px; margin:16px 0;">
        <p class="text" style="color:${MUTED}; line-height:1.6; margin-bottom:16px; margin:0; font-size:13px">${reason || 'Your profile did not meet the minimum requirements for this role.'}</p>
      </div>
      <p class="text" style="color:${MUTED}; line-height:1.6; margin-bottom:16px; font-size:13px">Keep your skills profile up to date — we'll automatically match you to future roles.</p>
      <a href="${process.env.FRONTEND_URL}/profile" class="btn" style="display:inline-block; background:${BRAND_COLOR}; color:#ffffff; text-decoration:none; padding:14px 28px; border-radius:12px; font-weight:600; font-size:15px; margin:8px 0; background:#8B8B9E">Update Your Skills →</a>
    `)
  })
}

// 10. Shortlisted (passed Stage 2 AI match)
async function sendShortlistedEmail(user, jobPosting) {
  await sendEmail({
    to: user.email,
    subject: `You're shortlisted! — ${jobPosting.title}`,
    html: baseTemplate(`
      <div class="title" style="font-size:24px; font-weight:700; margin-bottom:12px; color:${TEXT};">You've Been Shortlisted! 🎉</div>
      <span class="badge badge-success" style="display:inline-block; padding:4px 14px; border-radius:20px; font-size:13px; font-weight:600; background:rgba(34,197,94,0.18); color:#4ADE80;">Moving forward</span>
      <p class="text" style="color:${MUTED}; line-height:1.6; margin-bottom:16px; margin-top:16px">Great news — your profile matches what <strong>${jobPosting.companyName}</strong> is looking for in their
      <strong>${jobPosting.title}</strong> role. You're moving on to the next stage of the hiring process.</p>
      <p class="text" style="color:${MUTED}; line-height:1.6; margin-bottom:16px;">We'll email you with the next step shortly — keep an eye on your inbox.</p>
      <a href="${process.env.FRONTEND_URL}/dashboard" class="btn" style="display:inline-block; background:${BRAND_COLOR}; color:#ffffff; text-decoration:none; padding:14px 28px; border-radius:12px; font-weight:600; font-size:15px; margin:8px 0;">View Application →</a>
    `)
  })
}

// 11. Assignment sent
async function sendAssignmentEmail(user, jobPosting, deadline) {
  const deadlineText = deadline ? new Date(deadline).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }) : 'No fixed deadline'
  await sendEmail({
    to: user.email,
    subject: `Your assignment for ${jobPosting.title} at ${jobPosting.companyName}`,
    html: baseTemplate(`
      <div class="title" style="font-size:24px; font-weight:700; margin-bottom:12px; color:${TEXT};">Project Assignment 📝</div>
      <p class="text" style="color:${MUTED}; line-height:1.6; margin-bottom:16px;">As the next step for <strong>${jobPosting.title}</strong> at <strong>${jobPosting.companyName}</strong>, please complete the
      following assignment and submit your GitHub repository:</p>
      <div style="background:rgba(255,255,255,0.03); border-radius:12px; padding:16px; margin:16px 0;">
        <p class="text" style="color:${MUTED}; line-height:1.6; margin-bottom:16px; margin:0; white-space:pre-wrap">${jobPosting.assignmentBrief || ''}</p>
      </div>
      <div class="stat-row" style="display:flex; justify-content:space-between; padding:10px 0; border-bottom:1px solid rgba(255,255,255,0.05); font-size:14px; color:${TEXT};"><span>Deadline</span><strong>${deadlineText}</strong></div>
      <a href="${process.env.FRONTEND_URL}/dashboard" class="btn" style="display:inline-block; background:${BRAND_COLOR}; color:#ffffff; text-decoration:none; padding:14px 28px; border-radius:12px; font-weight:600; font-size:15px; margin:8px 0; margin-top:16px">Submit Your Assignment →</a>
    `)
  })
}

// 12. Assignment reminder
async function sendAssignmentReminderEmail(user, jobPosting, hoursLeft) {
  await sendEmail({
    to: user.email,
    subject: `⏰ Reminder: assignment due soon — ${jobPosting.title}`,
    html: baseTemplate(`
      <div class="title" style="font-size:24px; font-weight:700; margin-bottom:12px; color:${TEXT};">Assignment Reminder ⏰</div>
      <span class="badge badge-warning" style="display:inline-block; padding:4px 14px; border-radius:20px; font-size:13px; font-weight:600; background:rgba(245,158,11,0.18); color:#FBBF24;">${hoursLeft}h remaining</span>
      <p class="text" style="color:${MUTED}; line-height:1.6; margin-bottom:16px; margin-top:16px">Your assignment for <strong>${jobPosting.title}</strong> at <strong>${jobPosting.companyName}</strong> is due in approximately
      <strong>${hoursLeft} hour${hoursLeft === 1 ? '' : 's'}</strong>. Submit your GitHub repository before the deadline to stay in the running.</p>
      <a href="${process.env.FRONTEND_URL}/dashboard" class="btn" style="display:inline-block; background:${BRAND_COLOR}; color:#ffffff; text-decoration:none; padding:14px 28px; border-radius:12px; font-weight:600; font-size:15px; margin:8px 0;">Submit Now →</a>
    `)
  })
}

// 13. Exam unlocked
async function sendExamUnlockedEmail(user, jobPosting, examLink, deadline) {
  const deadlineText = deadline ? new Date(deadline).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }) : 'No fixed window'
  await sendEmail({
    to: user.email,
    subject: `Assessment unlocked — ${jobPosting.title}`,
    html: baseTemplate(`
      <div class="title" style="font-size:24px; font-weight:700; margin-bottom:12px; color:${TEXT};">Skills Assessment Unlocked 🔓</div>
      <p class="text" style="color:${MUTED}; line-height:1.6; margin-bottom:16px;">As the next step for <strong>${jobPosting.title}</strong> at <strong>${jobPosting.companyName}</strong>, please complete a
      <strong>${jobPosting.examDurationMin}-minute</strong> proctored skills assessment, including a few questions about your submitted project.</p>
      <div class="stat-row" style="display:flex; justify-content:space-between; padding:10px 0; border-bottom:1px solid rgba(255,255,255,0.05); font-size:14px; color:${TEXT};"><span>Start before</span><strong>${deadlineText}</strong></div>
      <a href="${examLink}" class="btn" style="display:inline-block; background:${BRAND_COLOR}; color:#ffffff; text-decoration:none; padding:14px 28px; border-radius:12px; font-weight:600; font-size:15px; margin:8px 0; margin-top:16px">Start Assessment →</a>
      <hr class="divider" style="border:none; border-top:1px solid rgba(255,255,255,0.07); margin:24px 0;">
      <p class="text" style="color:${MUTED}; line-height:1.6; margin-bottom:16px; font-size:13px">⚠️ Once started, you'll have ${jobPosting.examDurationMin} minutes to complete the assessment. Make sure your camera and a stable connection are ready.</p>
    `)
  })
}

// 14. Exam reminder
async function sendExamReminderEmail(user, jobPosting, hoursLeft) {
  await sendEmail({
    to: user.email,
    subject: `⏰ Reminder: assessment window closing — ${jobPosting.title}`,
    html: baseTemplate(`
      <div class="title" style="font-size:24px; font-weight:700; margin-bottom:12px; color:${TEXT};">Assessment Reminder ⏰</div>
      <span class="badge badge-warning" style="display:inline-block; padding:4px 14px; border-radius:20px; font-size:13px; font-weight:600; background:rgba(245,158,11,0.18); color:#FBBF24;">${hoursLeft}h remaining</span>
      <p class="text" style="color:${MUTED}; line-height:1.6; margin-bottom:16px; margin-top:16px">Your skills assessment window for <strong>${jobPosting.title}</strong> at <strong>${jobPosting.companyName}</strong> closes in approximately
      <strong>${hoursLeft} hour${hoursLeft === 1 ? '' : 's'}</strong>. Start it now to stay in the running.</p>
      <a href="${process.env.FRONTEND_URL}/dashboard" class="btn" style="display:inline-block; background:${BRAND_COLOR}; color:#ffffff; text-decoration:none; padding:14px 28px; border-radius:12px; font-weight:600; font-size:15px; margin:8px 0;">Start Assessment →</a>
    `)
  })
}

// 15. Selected
async function sendSelectionEmail(user, jobPosting, rank, narrative) {
  await sendEmail({
    to: user.email,
    subject: `🎉 You've been selected — ${jobPosting.title} at ${jobPosting.companyName}`,
    html: baseTemplate(`
      <div class="title" style="font-size:24px; font-weight:700; margin-bottom:12px; color:${TEXT};">Congratulations — You're Selected! 🎉</div>
      <span class="badge badge-success" style="display:inline-block; padding:4px 14px; border-radius:20px; font-size:13px; font-weight:600; background:rgba(34,197,94,0.18); color:#4ADE80;">Selected${rank ? ` • Rank #${rank}` : ''}</span>
      <p class="text" style="color:${MUTED}; line-height:1.6; margin-bottom:16px; margin-top:16px">${narrative || `Your application for <strong>${jobPosting.title}</strong> at <strong>${jobPosting.companyName}</strong> stood out across the hiring pipeline — congratulations!`}</p>
      <p class="text" style="color:${MUTED}; line-height:1.6; margin-bottom:16px;">The recruiting team at ${jobPosting.companyName} will be in touch with next steps shortly.</p>
      <a href="${process.env.FRONTEND_URL}/dashboard" class="btn" style="display:inline-block; background:${BRAND_COLOR}; color:#ffffff; text-decoration:none; padding:14px 28px; border-radius:12px; font-weight:600; font-size:15px; margin:8px 0;">View Full Report →</a>
    `)
  })
}

// 16. Final rejection (post-ranking, or deadline-based auto-rejection)
async function sendRejectionEmail(user, jobPosting, reasonReport) {
  await sendEmail({
    to: user.email,
    subject: `Update on your application — ${jobPosting.title}`,
    html: baseTemplate(`
      <div class="title" style="font-size:24px; font-weight:700; margin-bottom:12px; color:${TEXT};">Application Update</div>
      <span class="badge badge-error" style="display:inline-block; padding:4px 14px; border-radius:20px; font-size:13px; font-weight:600; background:rgba(239,68,68,0.18); color:#F87171;">Not selected</span>
      <p class="text" style="color:${MUTED}; line-height:1.6; margin-bottom:16px; margin-top:16px">Thank you for completing the full hiring process for <strong>${jobPosting.title}</strong> at <strong>${jobPosting.companyName}</strong>.
      After careful review, we've decided to move forward with other candidates for this round.</p>
      <div style="background:rgba(255,255,255,0.03); border-radius:12px; padding:16px; margin:16px 0;">
        <p class="text" style="color:${MUTED}; line-height:1.6; margin-bottom:16px; margin:0; font-size:13px">${reasonReport || 'Your scores were below the cutoff for this round.'}</p>
      </div>
      <p class="text" style="color:${MUTED}; line-height:1.6; margin-bottom:16px;">We appreciate the time and effort you put into this process and encourage you to apply again in the future.</p>
      <a href="${process.env.FRONTEND_URL}/dashboard" class="btn" style="display:inline-block; background:${BRAND_COLOR}; color:#ffffff; text-decoration:none; padding:14px 28px; border-radius:12px; font-weight:600; font-size:15px; margin:8px 0; background:#8B8B9E">View Full Report →</a>
    `)
  })
}

// 17. Job match (skill-based auto-invite)
async function sendJobMatchEmail(user, jobPosting, matchPct) {
  await sendEmail({
    to: user.email,
    subject: `New job match: ${jobPosting.title} at ${jobPosting.companyName}`,
    html: baseTemplate(`
      <div class="title" style="font-size:24px; font-weight:700; margin-bottom:12px; color:${TEXT};">A New Role Matches Your Skills 🎯</div>
      <span class="badge badge-primary" style="display:inline-block; padding:4px 14px; border-radius:20px; font-size:13px; font-weight:600; background:rgba(108,99,255,0.18); color:#A5A0FF;">${matchPct}% skill match</span>
      <p class="text" style="color:${MUTED}; line-height:1.6; margin-bottom:16px; margin-top:16px"><strong>${jobPosting.companyName}</strong> is hiring for <strong>${jobPosting.title}</strong>, and your profile
      matches ${matchPct}% of the required skills.</p>
      <a href="${process.env.FRONTEND_URL}/apply/${jobPosting.applyLinkSlug}" class="btn" style="display:inline-block; background:${BRAND_COLOR}; color:#ffffff; text-decoration:none; padding:14px 28px; border-radius:12px; font-weight:600; font-size:15px; margin:8px 0;">View & Apply →</a>
      <hr class="divider" style="border:none; border-top:1px solid rgba(255,255,255,0.07); margin:24px 0;">
      <p class="text" style="color:${MUTED}; line-height:1.6; margin-bottom:16px; font-size:13px">Getting these emails too often? <a href="${process.env.FRONTEND_URL}/settings" style="color:${MUTED}">Update your notification preferences</a>.</p>
    `)
  })
}

// 18. Recruiter daily digest
async function sendRecruiterDigestEmail(recruiter, jobPosting, stats) {
  await sendEmail({
    to: recruiter.email,
    subject: `Pipeline update: ${jobPosting.title} — ${stats.newApplicants} new applicants`,
    html: baseTemplate(`
      <div class="title" style="font-size:24px; font-weight:700; margin-bottom:12px; color:${TEXT};">Hiring Pipeline Update 📊</div>
      <p class="text" style="color:${MUTED}; line-height:1.6; margin-bottom:16px;"><strong>${jobPosting.title}</strong> at <strong>${jobPosting.companyName}</strong></p>
      <div style="margin:16px 0">
        <div class="stat-row" style="display:flex; justify-content:space-between; padding:10px 0; border-bottom:1px solid rgba(255,255,255,0.05); font-size:14px; color:${TEXT};"><span>New applicants</span><strong>${stats.newApplicants}</strong></div>
        <div class="stat-row" style="display:flex; justify-content:space-between; padding:10px 0; border-bottom:1px solid rgba(255,255,255,0.05); font-size:14px; color:${TEXT};"><span>Shortlisted</span><strong>${stats.shortlisted}</strong></div>
        <div class="stat-row" style="display:flex; justify-content:space-between; padding:10px 0; border-bottom:1px solid rgba(255,255,255,0.05); font-size:14px; color:${TEXT};"><span>Pending review</span><strong>${stats.pendingReview}</strong></div>
        <div class="stat-row" style="display:flex; justify-content:space-between; padding:10px 0; border-bottom:1px solid rgba(255,255,255,0.05); font-size:14px; color:${TEXT};"><span>Selected</span><strong>${stats.selected ?? 0}</strong></div>
        <div class="stat-row" style="display:flex; justify-content:space-between; padding:10px 0; border-bottom:1px solid rgba(255,255,255,0.05); font-size:14px; color:${TEXT};"><span>Rejected</span><strong>${stats.rejected ?? 0}</strong></div>
      </div>
      ${stats.rejectedSummary ? `<p class="text" style="color:${MUTED}; line-height:1.6; margin-bottom:16px;"><strong>Rejected pool insights:</strong> ${stats.rejectedSummary}</p>` : ''}
      <a href="${process.env.FRONTEND_URL}/recruiter/postings/${jobPosting.id}" class="btn" style="display:inline-block; background:${BRAND_COLOR}; color:#ffffff; text-decoration:none; padding:14px 28px; border-radius:12px; font-weight:600; font-size:15px; margin:8px 0;">View Pipeline →</a>
    `)
  })
}

// 19. Company verified (Part B)
async function sendCompanyVerifiedEmail(recruiter, company) {
  await sendEmail({
    to: recruiter.email,
    subject: `${company.name} is now verified on Proeva ✅`,
    html: baseTemplate(`
      <div class="title" style="font-size:24px; font-weight:700; margin-bottom:12px; color:${TEXT};">Company Verified ✅</div>
      <span class="badge badge-success" style="display:inline-block; padding:4px 14px; border-radius:20px; font-size:13px; font-weight:600; background:rgba(34,197,94,0.18); color:#4ADE80;">Verified</span>
      <p class="text" style="color:${MUTED}; line-height:1.6; margin-bottom:16px; margin-top:16px">Great news — <strong>${company.name}</strong> has been reviewed and verified by the Proeva team.
      You can now publish job postings and start receiving AI-screened candidates.</p>
      <a href="${process.env.FRONTEND_URL}/recruiter/postings/new" class="btn" style="display:inline-block; background:${BRAND_COLOR}; color:#ffffff; text-decoration:none; padding:14px 28px; border-radius:12px; font-weight:600; font-size:15px; margin:8px 0;">Post a Job →</a>
    `)
  })
}

// 20. Company rejected (Part B)
async function sendCompanyRejectedEmail(recruiter, company) {
  await sendEmail({
    to: recruiter.email,
    subject: `Verification update for ${company.name}`,
    html: baseTemplate(`
      <div class="title" style="font-size:24px; font-weight:700; margin-bottom:12px; color:${TEXT};">Verification Update</div>
      <span class="badge badge-error" style="display:inline-block; padding:4px 14px; border-radius:20px; font-size:13px; font-weight:600; background:rgba(239,68,68,0.18); color:#F87171;">Not verified</span>
      <p class="text" style="color:${MUTED}; line-height:1.6; margin-bottom:16px; margin-top:16px">We reviewed your submission for <strong>${company.name}</strong> and were unable to verify it at this time.</p>
      ${company.verificationNote ? `
      <div style="background:rgba(255,255,255,0.03); border-radius:12px; padding:16px; margin:16px 0;">
        <p class="text" style="color:${MUTED}; line-height:1.6; margin-bottom:16px; margin:0; font-size:13px"><strong>Reason:</strong> ${company.verificationNote}</p>
      </div>` : ''}
      <p class="text" style="color:${MUTED}; line-height:1.6; margin-bottom:16px;">You can update your company details and resubmit for verification from your Settings.</p>
      <a href="${process.env.FRONTEND_URL}/recruiter/company/verify" class="btn" style="display:inline-block; background:${BRAND_COLOR}; color:#ffffff; text-decoration:none; padding:14px 28px; border-radius:12px; font-weight:600; font-size:15px; margin:8px 0; background:#8B8B9E">Resubmit for Verification →</a>
    `)
  })
}

// 21. Recruiter message to candidate (Part F)
async function sendRecruiterMessageEmail(user, company, messageBody, applicationId) {
  await sendEmail({
    to: user.email,
    subject: `Message from ${company.name} about your application`,
    html: baseTemplate(`
      <div class="title" style="font-size:24px; font-weight:700; margin-bottom:12px; color:${TEXT};">Message from ${company.name} 💬</div>
      <p class="text" style="color:${MUTED}; line-height:1.6; margin-bottom:16px;">You have a new message regarding your application:</p>
      <div style="background:rgba(255,255,255,0.03); border-radius:12px; padding:16px; margin:16px 0; border-left:3px solid ${BRAND_COLOR}">
        <p class="text" style="color:${MUTED}; line-height:1.6; margin-bottom:16px; margin:0; white-space:pre-wrap">${messageBody}</p>
      </div>
      <a href="${process.env.FRONTEND_URL}/dashboard" class="btn" style="display:inline-block; background:${BRAND_COLOR}; color:#ffffff; text-decoration:none; padding:14px 28px; border-radius:12px; font-weight:600; font-size:15px; margin:8px 0;">View Application →</a>
    `)
  })
}

async function sendRecruiterOtpEmail(user, otp, purpose) {
  const isLogin = purpose === 'login'
  const subject = isLogin
    ? 'Your Proeva recruiter login code'
    : 'Verify your recruiter account — Proeva'

  const title = isLogin
    ? `Your one-time login code, ${user.name.split(' ')[0]}`
    : `Verify your email, ${user.name.split(' ')[0]} 👋`

  const bodyText = isLogin
    ? 'Use the code below to complete your recruiter login. It expires in <strong>10 minutes</strong>.'
    : 'Enter this code to verify your email and activate your recruiter account. It expires in <strong>10 minutes</strong>.'

  const footerNote = isLogin
    ? "If you didn't attempt to log in, you can safely ignore this email and your account remains secure."
    : "If you didn't sign up for Proeva, you can safely ignore this email."

  await sendEmail({
    to: user.email,
    subject,
    html: baseTemplate(`
      <div class="title" style="font-size:24px; font-weight:700; margin-bottom:12px; color:${TEXT};">${title}</div>
      <p class="text" style="color:${MUTED}; line-height:1.6; margin-bottom:16px;">${bodyText}</p>

      <!-- OTP Box -->
      <div style="
        background: rgba(108,99,255,0.08);
        border: 1px solid rgba(108,99,255,0.25);
        border-radius: 16px;
        padding: 28px;
        text-align: center;
        margin: 24px 0;
      ">
        <p style="font-size:13px; color:#8B8B9E; margin-bottom:12px; text-transform:uppercase; letter-spacing:0.1em; font-weight:600;">
          ${isLogin ? 'Login Code' : 'Verification Code'}
        </p>
        <div style="
          font-size: 42px;
          font-weight: 800;
          letter-spacing: 10px;
          color: #6C63FF;
          font-family: 'Courier New', monospace;
        ">${otp}</div>
        <p style="font-size:12px; color:#8B8B9E; margin-top:12px;">
          ⏱ Valid for 10 minutes · Do not share this code
        </p>
      </div>

      <hr class="divider" style="border:none; border-top:1px solid rgba(255,255,255,0.07); margin:24px 0;">
      <p class="text" style="color:${MUTED}; line-height:1.6; margin-bottom:16px; font-size:13px;">${footerNote}</p>

      <div style="margin-top:16px; padding:12px 16px; background:rgba(255,255,255,0.03); border-radius:10px; border-left:3px solid #6C63FF;">
        <p style="font-size:12px; color:#8B8B9E; margin:0;">
          🔒 Proeva will never ask for your OTP via phone or chat. This code is for the Proeva website only.
        </p>
      </div>
    `)
  })
}


module.exports = {
  sendVerifyEmail,
  sendWelcomeEmail,
  sendPasswordResetEmail,
  sendEvaluationCompleteEmail,
  sendEvaluationFailedEmail,
  sendExamResultEmail,
  sendCertificateReadyEmail,
  sendPaymentConfirmedEmail,
  // recruiter pipeline
  sendApplicationReceivedEmail,
  sendScreeningRejectionEmail,
  sendShortlistedEmail,
  sendAssignmentEmail,
  sendAssignmentReminderEmail,
  sendExamUnlockedEmail,
  sendExamReminderEmail,
  sendSelectionEmail,
  sendRejectionEmail,
  sendJobMatchEmail,
  sendRecruiterDigestEmail,
  // company verification (Part B)
  sendCompanyVerifiedEmail,
  sendCompanyRejectedEmail,
  // recruiter messaging (Part F)
  sendRecruiterMessageEmail,
  sendRecruiterOtpEmail
}