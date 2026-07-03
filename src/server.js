require('dotenv').config()
const http = require('http')
const { Server } = require('socket.io')
const app = require('./app')
const prisma = require('./config/database')
const { initSocket } = require('./socket')

const PORT = process.env.PORT || 5000

async function startServer() {
  try {
    // Test DB connection
    await prisma.$connect()
    console.log('✅ Database connected')

    const server = http.createServer(app)

    // Socket.io
    const io = new Server(server, {
      cors: {
        origin: process.env.FRONTEND_URL || 'http://localhost:5173',
        credentials: true
      }
    })
    initSocket(io)

    // Start workers
    require('./workers/projectWorker')
    require('./workers/examWorker')
    require('./workers/certificateWorker')
    require('./workers/emailWorker')

    // Recruiter hiring pipeline workers
    require('./workers/applicationWorker')
    require('./workers/matchWorker')
    require('./workers/reminderWorker')

    server.listen(PORT, () => {
      console.log(`🚀 DevCert server running on port ${PORT}`)
      console.log(`📡 AI Provider: ${process.env.AI_PROVIDER || 'groq'}`)
      console.log(`🌍 Environment: ${process.env.NODE_ENV || 'development'}`)
    })

    // Graceful shutdown
    process.on('SIGTERM', async () => {
      console.log('SIGTERM received. Shutting down gracefully...')
      await prisma.$disconnect()
      server.close(() => process.exit(0))
    })

    app.set('trust proxy', 1)

  } catch (err) {
    console.error('Failed to start server:', err)
    process.exit(1)
  }
}

startServer()
