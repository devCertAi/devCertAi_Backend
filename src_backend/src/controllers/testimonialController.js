const { PrismaClient } = require('@prisma/client')
const prisma = new PrismaClient()

// GET /api/testimonials — public, returns active testimonials ordered by `order`
const getTestimonials = async (req, res) => {
  try {
    const testimonials = await prisma.testimonial.findMany({
      where: { isActive: true },
      orderBy: { order: 'asc' },
      select: { id: true, name: true, role: true, text: true, stars: true, avatar: true },
    })
    res.json({ success: true, data: testimonials })
  } catch (err) {
    console.error('getTestimonials error:', err)
    res.status(500).json({ success: false, message: 'Failed to fetch testimonials' })
  }
}

// POST /api/admin/testimonials — admin only
const createTestimonial = async (req, res) => {
  try {
    const { name, role, text, stars = 5, avatar, order = 0 } = req.body
    if (!name || !role || !text) {
      return res.status(400).json({ success: false, message: 'name, role and text are required' })
    }
    const testimonial = await prisma.testimonial.create({
      data: { name, role, text, stars: Number(stars), avatar, order: Number(order) },
    })
    res.status(201).json({ success: true, data: testimonial })
  } catch (err) {
    console.error('createTestimonial error:', err)
    res.status(500).json({ success: false, message: 'Failed to create testimonial' })
  }
}

// PUT /api/admin/testimonials/:id — admin only
const updateTestimonial = async (req, res) => {
  try {
    const { id } = req.params
    const { name, role, text, stars, avatar, isActive, order } = req.body
    const testimonial = await prisma.testimonial.update({
      where: { id },
      data: {
        ...(name !== undefined && { name }),
        ...(role !== undefined && { role }),
        ...(text !== undefined && { text }),
        ...(stars !== undefined && { stars: Number(stars) }),
        ...(avatar !== undefined && { avatar }),
        ...(isActive !== undefined && { isActive }),
        ...(order !== undefined && { order: Number(order) }),
      },
    })
    res.json({ success: true, data: testimonial })
  } catch (err) {
    console.error('updateTestimonial error:', err)
    res.status(500).json({ success: false, message: 'Failed to update testimonial' })
  }
}

// DELETE /api/admin/testimonials/:id — admin only
const deleteTestimonial = async (req, res) => {
  try {
    await prisma.testimonial.delete({ where: { id: req.params.id } })
    res.json({ success: true, message: 'Testimonial deleted' })
  } catch (err) {
    console.error('deleteTestimonial error:', err)
    res.status(500).json({ success: false, message: 'Failed to delete testimonial' })
  }
}

module.exports = { getTestimonials, createTestimonial, updateTestimonial, deleteTestimonial }