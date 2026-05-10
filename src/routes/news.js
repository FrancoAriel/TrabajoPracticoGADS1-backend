import { Router } from 'express'
import supabase from '../lib/supabase.js'
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
      supabase.from('novedad').select('*', { count: 'exact', head: true }).eq('estado', 'pendiente'),
      supabase.from('novedad').select('*', { count: 'exact', head: true }).eq('estado', 'aprobada'),
      supabase.from('novedad').select('*', { count: 'exact', head: true }).eq('estado', 'rechazada')
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
router.post('/', async (req, res) => {
  try {
    const { legajo, tipo, fechaDesde, fechaHasta, cantidad, unidad, observacion, idUsuarioCreacion } = req.body
    if (!legajo || !tipo || !fechaDesde || !unidad)
      return badRequest(res, 'legajo, tipo, fechaDesde y unidad son requeridos')

    const { data, error } = await supabase
      .from('novedad')
      .insert({ legajo, tipo, fecha_desde: fechaDesde, fecha_hasta: fechaHasta, cantidad, unidad, estado: 'pendiente', origen: 'manual', observacion, fecha_creacion: new Date().toISOString(), id_usuario_creacion: idUsuarioCreacion })
      .select()
      .single()

    if (error) throw error
    return created(res, data)
  } catch (err) {
    serverError(res, err)
  }
})

// POST /news/:id/approve
router.post('/:id/approve', async (req, res) => {
  try {
    const { error } = await supabase
      .from('novedad')
      .update({ estado: 'aprobada' })
      .eq('id_novedad', req.params.id)

    if (error) throw error
    return ok(res, { id: req.params.id, estado: 'aprobada' })
  } catch (err) {
    serverError(res, err)
  }
})

// POST /news/:id/reject
router.post('/:id/reject', async (req, res) => {
  try {
    const { reason } = req.body
    const obs = reason ? `Rechazado: ${reason}` : 'Rechazado'

    const { data: current } = await supabase.from('novedad').select('observacion').eq('id_novedad', req.params.id).single()
    const { error } = await supabase
      .from('novedad')
      .update({ estado: 'rechazada', observacion: [current?.observacion, obs].filter(Boolean).join(' | ') })
      .eq('id_novedad', req.params.id)

    if (error) throw error
    return ok(res, { id: req.params.id, estado: 'rechazada' })
  } catch (err) {
    serverError(res, err)
  }
})

// DELETE /news/:id
router.delete('/:id', async (req, res) => {
  try {
    const { error } = await supabase.from('novedad').delete().eq('id_novedad', req.params.id)
    if (error) throw error
    return res.status(204).send()
  } catch (err) {
    serverError(res, err)
  }
})

export default router
