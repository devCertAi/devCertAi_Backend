const prisma = require('../config/database')
const { getIO } = require('../socket')

/**
 * Emit a real-time notification via Socket.io.
 * Room naming:  user:<id>  for regular users
 *               recruiter:<id>  for recruiters
 */
function _emit(id, isRecruiter, payload) {
  try {
    const io = getIO()
    if (!io) return
    const room = isRecruiter ? `recruiter:${id}` : `user:${id}`
    io.to(room).emit('notification', payload)
  } catch {
    // socket errors must never crash a request
  }
}

/**
 * Create a notification for a user OR recruiter.
 *
 * @param {string} recipientId
 * @param {{ type: string, title: string, message: string, data?: object }} payload
 * @param {{ isRecruiter?: boolean }} opts
 */
async function create(recipientId, { type, title, message, data }, { isRecruiter = false } = {}) {
  let notification

  if (isRecruiter) {
    notification = await prisma.recruiterNotification.create({
      data: { recruiterId: recipientId, type, title, message, data: data ?? undefined },
    })
  } else {
    notification = await prisma.notification.create({
      data: { userId: recipientId, type, title, message, data: data ?? undefined },
    })
  }

  _emit(recipientId, isRecruiter, notification)
  return notification
}

/**
 * Fetch all notifications for a user or recruiter (newest first).
 */
async function getAll(recipientId, { isRecruiter = false } = {}) {
  if (isRecruiter) {
    return prisma.recruiterNotification.findMany({
      where: { recruiterId: recipientId },
      orderBy: { createdAt: 'desc' },
    })
  }
  return prisma.notification.findMany({
    where: { userId: recipientId },
    orderBy: { createdAt: 'desc' },
  })
}

/**
 * Mark a single notification as read (ownership-checked).
 */
async function markRead(notificationId, recipientId, { isRecruiter = false } = {}) {
  if (isRecruiter) {
    await prisma.recruiterNotification.updateMany({
      where: { id: notificationId, recruiterId: recipientId },
      data: { isRead: true },
    })
  } else {
    await prisma.notification.updateMany({
      where: { id: notificationId, userId: recipientId },
      data: { isRead: true },
    })
  }
}

/**
 * Mark ALL notifications as read for the given recipient.
 */
async function markAllRead(recipientId, { isRecruiter = false } = {}) {
  if (isRecruiter) {
    await prisma.recruiterNotification.updateMany({
      where: { recruiterId: recipientId, isRead: false },
      data: { isRead: true },
    })
  } else {
    await prisma.notification.updateMany({
      where: { userId: recipientId, isRead: false },
      data: { isRead: true },
    })
  }
}

/**
 * Delete a single notification (ownership-checked).
 */
async function deleteOne(notificationId, recipientId, { isRecruiter = false } = {}) {
  if (isRecruiter) {
    await prisma.recruiterNotification.deleteMany({
      where: { id: notificationId, recruiterId: recipientId },
    })
  } else {
    await prisma.notification.deleteMany({
      where: { id: notificationId, userId: recipientId },
    })
  }
}

module.exports = { create, getAll, markRead, markAllRead, deleteOne }