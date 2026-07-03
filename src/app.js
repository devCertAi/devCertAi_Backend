const express = require('express')
const cors = require('cors')
const cookieParser = require('cookie-parser')
const helmet = require('helmet')
const morgan = require('morgan')
const { globalLimiter } = require('./middleware/rateLimiter')
const errorHandler = require('./middleware/errorHandler')

const app = express()

// ─── Security ─────────────────────────────────────────────────────────────────
app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }))

const corsOptions = {
  origin: process.env.FRONTEND_URL || 'http://localhost:5173',
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
}
app.use(cors(corsOptions))

// ─── Body parsing ─────────────────────────────────────────────────────────────
// Webhook needs raw body — must come BEFORE express.json()
app.use('/api/payments/webhook', express.raw({ type: 'application/json' }))
app.use(express.json({ limit: '10mb' }))
app.use(express.urlencoded({ extended: true, limit: '10mb' }))
app.use(cookieParser())

// ─── Logging ──────────────────────────────────────────────────────────────────
if (process.env.NODE_ENV !== 'test') {
  app.use(morgan('dev'))
}

// ─── Rate limiting ────────────────────────────────────────────────────────────
app.use('/api', globalLimiter)

// ─── Health check ─────────────────────────────────────────────────────────────
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString(), service: 'DevCert API' })
})

// ─── Routes ───────────────────────────────────────────────────────────────────
app.use('/api/auth',             require('./routes/auth'))
app.use('/api/auth/recruiter',   require('./routes/recruiterAuth'))
app.use('/api/users',            require('./routes/users'))
app.use('/api/projects',         require('./routes/projects'))
app.use('/api/exam',             require('./routes/exam'))
app.use('/api/certificates',     require('./routes/certificates'))
app.use('/api/notifications',    require('./routes/notifications'))
app.use('/api/payments',         require('./routes/payments'))
app.use('/api/credits',          require('./routes/credits'))
app.use('/api/companies',        require('./routes/companies'))
app.use('/api/admin',            require('./routes/admin'))
app.use('/api/testimonials',     require('./routes/testimonials'))
app.use('/api/skills',           require('./routes/skills'))
app.use('/api/recruiter',        require('./routes/recruiter'))
app.use('/api/recruiter/settings', require('./routes/recruiterSettings'))
app.use('/api/apply',            require('./routes/apply'))
app.use('/api/applications',     require('./routes/applications'))

// ─── 404 ──────────────────────────────────────────────────────────────────────
app.use((_req, res) => {
  res.status(404).json({ success: false, message: 'Route not found' })
})

// ─── Global error handler (must be last) ──────────────────────────────────────
app.use(errorHandler)

module.exports = app