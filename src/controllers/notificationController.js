const { ApiResponse } = require('../utils/ApiResponse')
const asyncHandler = require('../utils/asyncHandler')
const notificationService = require('../services/notificationService')

const getAll = asyncHandler(async (req, res) => {
  const isRecruiter = req.user.role === 'recruiter'
  const notifications = await notificationService.getAll(req.user.id, { isRecruiter })
  const unreadCount = notifications.filter(n => !n.isRead).length
  return res.json(new ApiResponse(200, { notifications, unreadCount }))
})

const markRead = asyncHandler(async (req, res) => {
  const isRecruiter = req.user.role === 'recruiter'
  await notificationService.markRead(req.params.id, req.user.id, { isRecruiter })
  return res.json(new ApiResponse(200, {}, 'Marked as read'))
})

const markAllRead = asyncHandler(async (req, res) => {
  const isRecruiter = req.user.role === 'recruiter'
  await notificationService.markAllRead(req.user.id, { isRecruiter })
  return res.json(new ApiResponse(200, {}, 'All marked as read'))
})

const deleteOne = asyncHandler(async (req, res) => {
  const isRecruiter = req.user.role === 'recruiter'
  await notificationService.deleteOne(req.params.id, req.user.id, { isRecruiter })
  return res.json(new ApiResponse(200, {}, 'Notification deleted'))
})

module.exports = { getAll, markRead, markAllRead, deleteOne }