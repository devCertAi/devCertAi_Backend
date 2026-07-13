/**
 * controllers/skillController.js — uses safeRedis
 */

const prisma = require('../config/database')
const { ApiError } = require('../utils/ApiError')
const { ApiResponse } = require('../utils/ApiResponse')
const asyncHandler = require('../utils/asyncHandler')
const { safeRedis } = require('../config/redis')   // ← safeRedis

// GET /skills?q= — autocomplete with Redis cache
const searchSkills = asyncHandler(async (req, res) => {
  const q = (req.query.q || '').trim()
  if (q.length < 1) return res.json(new ApiResponse(200, { skills: [] }))

  const lower = q.toLowerCase()
  const cacheKey = `skills:search:${lower}`

  // 1. Cache hit — null when Redis is down, no try/catch needed
  const cached = await safeRedis.get(cacheKey)
  if (cached) return res.json(new ApiResponse(200, { skills: JSON.parse(cached) }))

  // 2. DB query (always runs when Redis is unavailable)
  const raw = await prisma.skill.findMany({
    where: { name: { contains: q, mode: 'insensitive' } },
    orderBy: { name: 'asc' },
    take: 20,
    select: { id: true, name: true },
  })

  // 3. Rank: exact → starts-with → contains
  const skills = raw
    .sort((a, b) => {
      const aExact  = a.name.toLowerCase() === lower
      const bExact  = b.name.toLowerCase() === lower
      const aStarts = a.name.toLowerCase().startsWith(lower)
      const bStarts = b.name.toLowerCase().startsWith(lower)
      if (aExact  && !bExact)  return -1
      if (!aExact && bExact)   return  1
      if (aStarts && !bStarts) return -1
      if (!aStarts && bStarts) return  1
      return a.name.localeCompare(b.name)
    })
    .slice(0, 10)

  // 4. Best-effort cache write — silently skipped if Redis is down
  await safeRedis.set(cacheKey, JSON.stringify(skills), 'EX', 3600)

  return res.json(new ApiResponse(200, { skills }))
})

// POST /skills — creates a skill if it doesn't exist (case-insensitive dedupe)
const createSkill = asyncHandler(async (req, res) => {
  const { name } = req.body
  if (!name || !name.trim()) throw new ApiError(400, 'Skill name is required')

  const trimmed = name.trim()
  const existing = await prisma.skill.findFirst({
    where: { name: { equals: trimmed, mode: 'insensitive' } },
  })
  if (existing) return res.json(new ApiResponse(200, { skill: existing }))

  const skill = await prisma.skill.create({ data: { name: trimmed } })
  return res.status(201).json(new ApiResponse(201, { skill }))
})

module.exports = { searchSkills, createSkill }