import { Router } from 'express'
import supabase from '../lib/supabase.js'
import { ok, created, notFound, badRequest, serverError } from '../lib/response.js'

const router = Router()

/** Filtros de listado sobre la consulta de fichadas (con join empleado). */
function applyListFilters(q, { search, type, origin, date }) {
  let qq = q
  if (type) qq = qq.eq('tipo', type)
  if (origin) qq = qq.eq('origen', origin)
  if (date) {
    qq = qq
      .gte('fecha_hora', `${date}T00:00:00`)
      .lte('fecha_hora', `${date}T23:59:59`)
  }
  if (search) {
    const t = String(search).trim()
    if (/^\d+$/.test(t))
      qq = qq.eq('legajo', Number(t))
    else {
      const pat = `%${t}%`
      qq = qq.or(`nombre.ilike.${pat},apellido.ilike.${pat}`, { foreignTable: 'empleado' })
    }
  }
  return qq
}

// GET /punches
router.get('/', async (req, res) => {
  try {
    const { search, type, origin, date, page = 1, pageSize = 10 } = req.query
    const ps = Number(pageSize) || 10
    const from = (Number(page) - 1) * ps
    const to   = from + ps - 1

    const baseSelect = () =>
      applyListFilters(
        supabase.from('fichada').select('*, empleado(nombre, apellido)', { count: 'exact' }),
        { search, type, origin, date },
      )

    let query = baseSelect()
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

    let stats
    if (date) {
      const dayBegin = `${date}T00:00:00`
      const dayEnd   = `${date}T23:59:59`
      const dayScope = () =>
        supabase.from('fichada').select('*', { count: 'exact', head: true }).gte('fecha_hora', dayBegin).lte('fecha_hora', dayEnd)

      const [{ count: totalDelDía }, { count: entradas }, { count: salidas }, { count: porRevisar }] = await Promise.all([
        dayScope(),
        dayScope().eq('tipo', 'Entrada'),
        dayScope().eq('tipo', 'Salida'),
        dayScope().or('es_correccion.eq.true,origen.eq.Manual'),
      ])
      stats = {
        totalDelDía: totalDelDía ?? 0,
        entradas:    entradas ?? 0,
        salidas:     salidas ?? 0,
        porRevisar:  porRevisar ?? 0,
      }
    }

    return ok(res,
      { items, stats },
      { page: Number(page), pageSize: ps, totalItems: count ?? 0, totalPages: Math.ceil((count ?? 0) / ps) },
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

    const legajoNum =
      typeof legajo === 'string' ? Number(legajo.replace(/\D/g, '')) : Number(legajo)
    if (!Number.isFinite(legajoNum))
      return badRequest(res, 'legajo inválido')

    const { data, error } = await supabase
      .from('fichada')
      .insert({
        legajo: legajoNum,
        fecha_hora: fechaHora,
        tipo,
        origen: 'Manual',
        es_correccion: false,
        id_usuario_registro: idUsuarioRegistro,
      })
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
      .insert({
        legajo: original.legajo,
        fecha_hora: fechaHora,
        tipo,
        origen: 'Manual',
        es_correccion: true,
        id_fichada_original: Number(req.params.id),
        id_usuario_registro: idUsuarioRegistro,
      })
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
