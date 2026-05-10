import { Router } from 'express'
import supabase from '../lib/supabase.js'
import { ok, created, notFound, badRequest, serverError } from '../lib/response.js'

const router = Router()

// GET /punches
router.get('/', async (req, res) => {
  try {
    const { search, type, origin, date, page = 1, pageSize = 10 } = req.query
    const from = (page - 1) * pageSize
    const to   = from + Number(pageSize) - 1

    let query = supabase
      .from('fichada')
      .select('*, empleado(nombre, apellido)', { count: 'exact' })

    if (type)   query = query.eq('tipo', type)
    if (origin) query = query.eq('origen', origin)
    if (date)   query = query.gte('fecha_hora', `${date}T00:00:00`).lte('fecha_hora', `${date}T23:59:59`)
    if (search) query = query.or(`empleado.nombre.ilike.%${search}%,empleado.apellido.ilike.%${search}%`)

    query = query.order('fecha_hora', { ascending: false }).range(from, to)

    const { data, count, error } = await query
    if (error) throw error

    const items = (data ?? []).map(p => ({
      id:           p.id_fichada,
      employeeId:   p.legajo,
      legajo:       String(p.legajo).padStart(4, '0'),
      employeeName: p.empleado ? `${p.empleado.nombre} ${p.empleado.apellido}` : null,
      timestamp:    p.fecha_hora,
      type:         p.tipo,
      origin:       p.origen,
      correction:   p.es_correccion
    }))

    return ok(res,
      { items },
      { page: Number(page), pageSize: Number(pageSize), totalItems: count ?? 0, totalPages: Math.ceil((count ?? 0) / pageSize) }
    )
  } catch (err) {
    serverError(res, err)
  }
})

// GET /punches/:id
router.get('/:id', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('fichada')
      .select('*, empleado(nombre, apellido)')
      .eq('id_fichada', req.params.id)
      .single()

    if (error || !data) return notFound(res, 'Fichada no encontrada')

    return ok(res, {
      id:           data.id_fichada,
      employeeId:   data.legajo,
      employeeName: data.empleado ? `${data.empleado.nombre} ${data.empleado.apellido}` : null,
      timestamp:    data.fecha_hora,
      type:         data.tipo,
      origin:       data.origen,
      correction:   data.es_correccion,
      originalId:   data.id_fichada_original
    })
  } catch (err) {
    serverError(res, err)
  }
})

// POST /punches/manual
router.post('/manual', async (req, res) => {
  try {
    const { legajo, fechaHora, tipo, idUsuarioRegistro } = req.body
    if (!legajo || !fechaHora || !tipo)
      return badRequest(res, 'legajo, fechaHora y tipo son requeridos')

    const { data, error } = await supabase
      .from('fichada')
      .insert({ legajo, fecha_hora: fechaHora, tipo, origen: 'manual', es_correccion: false, id_usuario_registro: idUsuarioRegistro })
      .select()
      .single()

    if (error) throw error
    return created(res, data)
  } catch (err) {
    serverError(res, err)
  }
})

// POST /punches/:id/corrections
router.post('/:id/corrections', async (req, res) => {
  try {
    const { fechaHora, tipo, idUsuarioRegistro } = req.body
    if (!fechaHora || !tipo)
      return badRequest(res, 'fechaHora y tipo son requeridos')

    const { data: original, error: origErr } = await supabase
      .from('fichada')
      .select('legajo')
      .eq('id_fichada', req.params.id)
      .single()

    if (origErr || !original) return notFound(res, 'Fichada original no encontrada')

    const { data, error } = await supabase
      .from('fichada')
      .insert({ legajo: original.legajo, fecha_hora: fechaHora, tipo, origen: 'manual', es_correccion: true, id_fichada_original: Number(req.params.id), id_usuario_registro: idUsuarioRegistro })
      .select()
      .single()

    if (error) throw error
    return created(res, data)
  } catch (err) {
    serverError(res, err)
  }
})

// DELETE /punches/:id
router.delete('/:id', async (req, res) => {
  try {
    const { error } = await supabase.from('fichada').delete().eq('id_fichada', req.params.id)
    if (error) throw error
    return res.status(204).send()
  } catch (err) {
    serverError(res, err)
  }
})

export default router
