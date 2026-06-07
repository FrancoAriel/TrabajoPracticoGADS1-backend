import { Router } from 'express'
import supabase from '../lib/supabase.js'
import { requireRole } from '../lib/auth.js'
import { ok, created, notFound, badRequest, serverError } from '../lib/response.js'

const router = Router()

// GET /news
router.get('/', async (req, res) => {
  try {
    const { search, status, type, page = 1, pageSize = 10 } = req.query
    const from = (page - 1) * pageSize
    const to   = from + Number(pageSize) - 1

    let query = supabase
      .from('novedad')
      .select('*, empleado(nombre, apellido)', { count: 'exact' })

    if (status) query = query.eq('estado', status)
    if (type)   query = query.eq('tipo', type)
    if (search) query = query.or(`empleado.nombre.ilike.%${search}%,empleado.apellido.ilike.%${search}%`)

    query = query.order('fecha_creacion', { ascending: false }).range(from, to)

    const { data, count, error } = await query
    if (error) throw error

    const [{ count: pending }, { count: approved }, { count: rejected }] = await Promise.all([
      supabase.from('novedad').select('*', { count: 'exact', head: true }).eq('estado', 'Pendiente'),
      supabase.from('novedad').select('*', { count: 'exact', head: true }).eq('estado', 'Aprobada'),
      supabase.from('novedad').select('*', { count: 'exact', head: true }).eq('estado', 'Rechazada')
    ])

    const items = (data ?? []).map(n => ({
      id:          n.id_novedad,
      employeeId:  n.legajo,
      employee:    n.empleado ? `${n.empleado.nombre} ${n.empleado.apellido}` : null,
      type:        n.tipo,
      date:        n.fecha_desde,
      status:      n.estado,
      quantity:    n.cantidad,
      unit:        n.unidad,
      origin:      n.origen,
      createdAt:   n.fecha_creacion,
      note:        n.observacion
    }))

    return ok(res,
      { stats: { pending: pending ?? 0, approved: approved ?? 0, rejected: rejected ?? 0 }, items },
      { page: Number(page), pageSize: Number(pageSize), totalItems: count ?? 0, totalPages: Math.ceil((count ?? 0) / pageSize) }
    )
  } catch (err) {
    serverError(res, err)
  }
})

// POST /news
router.post('/', requireRole('Admin'), async (req, res) => {
  try {
    const { legajo, tipo, fechaDesde, fechaHasta, cantidad, unidad, observacion, idUsuarioCreacion } = req.body
    if (!legajo || !tipo || !fechaDesde || !unidad)
      return badRequest(res, 'legajo, tipo, fechaDesde y unidad son requeridos')

    const { data, error } = await supabase
      .from('novedad')
      .insert({ legajo, tipo, fecha_desde: fechaDesde, fecha_hasta: fechaHasta, cantidad, unidad, estado: 'Pendiente', origen: 'Manual', observacion, fecha_creacion: new Date().toISOString(), id_usuario_creacion: idUsuarioCreacion ?? req.user?.sub ?? null })
      .select()
      .single()

    if (error) throw error
    return created(res, data)
  } catch (err) {
    serverError(res, err)
  }
})

// POST /news/:id/approve
router.post('/:id/approve', requireRole('Admin'), async (req, res) => {
  try {
    const { error } = await supabase
      .from('novedad')
      .update({ estado: 'Aprobada' })
      .eq('id_novedad', req.params.id)

    if (error) throw error
    return ok(res, { id: req.params.id, estado: 'Aprobada' })
  } catch (err) {
    serverError(res, err)
  }
})

// POST /news/:id/reject
router.post('/:id/reject', requireRole('Admin'), async (req, res) => {
  try {
    const { reason } = req.body
    const obs = reason ? `Rechazado: ${reason}` : 'Rechazado'

    const { data: current } = await supabase.from('novedad').select('observacion').eq('id_novedad', req.params.id).single()
    const { error } = await supabase
      .from('novedad')
      .update({ estado: 'Rechazada', observacion: [current?.observacion, obs].filter(Boolean).join(' | ') })
      .eq('id_novedad', req.params.id)

    if (error) throw error
    return ok(res, { id: req.params.id, estado: 'Rechazada' })
  } catch (err) {
    serverError(res, err)
  }
})

// DELETE /news/:id
router.delete('/:id', requireRole('Admin'), async (_req, res) => {
  return res.status(405).json({ error: { code: 'METHOD_NOT_ALLOWED', message: 'Las novedades no se eliminan; aprobá, rechazá o registrá una novedad correctiva.' } })
})

export default router
