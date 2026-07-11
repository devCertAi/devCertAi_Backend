const jwt = require('jsonwebtoken')

let _io = null

function initSocket(io) {
  _io = io

  io.use((socket, next) => {
    const token = socket.handshake.auth?.token
    if (!token) return next(new Error('Authentication error'))

    try {
      // Single secret — both user and recruiter tokens are signed with JWT_SECRET
      // (see utils/tokenUtils.js: signAccessToken / signRecruiterAccessToken).
      // This MUST match, or every socket handshake fails auth silently and
      // no client ever joins its room — real-time delivery breaks entirely
      // even though the underlying REST action (e.g. sending a message)
      // still succeeds via the database/email path.
      const decoded = jwt.verify(token, process.env.JWT_SECRET)

      if (decoded.role === 'recruiter') {
        socket.recruiterId = decoded.recruiterId
        socket.role = 'recruiter'
      } else {
        socket.userId = decoded.userId
        socket.role = 'user'
      }
      next()
    } catch {
      next(new Error('Invalid token'))
    }
  })

  io.on('connection', (socket) => {
    if (socket.role === 'recruiter') {
      const room = `recruiter:${socket.recruiterId}`
      socket.join(room)
      console.log(`[Socket] Recruiter ${socket.recruiterId} connected → room ${room}`)
    } else {
      const room = `user:${socket.userId}`
      socket.join(room)
      console.log(`[Socket] User ${socket.userId} connected → room ${room}`)
    }

    socket.on('disconnect', () => {
      const id = socket.role === 'recruiter' ? socket.recruiterId : socket.userId
      console.log(`[Socket] ${socket.role} ${id} disconnected`)
    })

    // Exam heartbeat (users only)
    socket.on('exam:heartbeat', (data) => {
      if (socket.userId) {
        socket.to(`user:${socket.userId}`).emit('exam:heartbeat_ack', data)
      }
    })
  })

  console.log('✅ Socket.io initialized')
}

function getIO() {
  return _io
}

module.exports = { initSocket, getIO }