import { Router } from 'express'
import supabase from '../lib/supabase.js'
import { ok, created, notFound, badRequest, serverError } from '../lib/response.js'
import { evaluateEmployeeDay } from '../services/attendanceEvaluation.js'

const router = Router()

/** Valores enum en BD: Entrada | Salida */
function normalizeTipoFichada(t) {
  const s = String(t ?? '').trim().toLowerCase()
  if (s === 'entrada') return 'Entrada'
  if (s === 'salida') return 'Salida'
  return String(t ?? '').trim()
}

function normalizeOrigenFichada(value) {
  const s = String(value ?? '').trim().toLowerCase()
  if (s === 'biometrico' || s === 'biométrico') return 'Biometrico'
  if (s === 'manual') return 'Manual'
  if (s === 'qr') return 'Qr'
  if (s === 'api') return 'Api'
  if (s === 'pin') return 'Pin'
  return String(value ?? '').trim()
}

async function evaluateAfterPunch(legajo, fechaHora) {
  const fecha = String(fechaHora).slice(0, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) return null
  try {
    return await evaluateEmployeeDay(supabase, legajo, fecha, { dryRun: false })
  } catch (e) {
    console.error('[attendanceEvaluation] post fichada', e)
    return [
      { rule: 'meta', kind: 'error', legajo, details: { message: e?.message ?? String(e) } },
    ]
  }
}

async function insertPunch({ legajo, fechaHora, tipo, origen, esCorreccion = false, idFichadaOriginal = null, idUsuarioRegistro = null }) {
  const legajoNum = typeof legajo === 'string' ? Number(legajo.replace(/\D/g, '')) : Number(legajo)
  if (!Number.isFinite(legajoNum)) {
    const err = new Error('legajo inválido')
    err.statusCode = 400
    throw err
  }

  const { data, error } = await supabase
    .from('fichada')
    .insert({
      legajo: legajoNum,
      fecha_hora: fechaHora,
      tipo: normalizeTipoFichada(tipo),
      origen: normalizeOrigenFichada(origen),
      es_correccion: esCorreccion,
      id_fichada_original: idFichadaOriginal,
      id_usuario_registro: idUsuarioRegistro,
    })
    .select()
    .single()

  if (error) throw error
  return { data, legajoNum }
}

/** Carga marcaciones referenciadas por `id_fichada_original` (el embed self-join suele venir vacío en PostgREST). */
async function originalsByIds(supabase, rows) {
  const ids = [
    ...new Set(
      (rows ?? [])
        .filter((r) => r.es_correccion && r.id_fichada_original != null)
        .map((r) => Number(r.id_fichada_original))
        .filter((id) => Number.isFinite(id) && id > 0),
    ),
  ]
  if (!ids.length) return new Map()
  const { data, error } = await supabase
    .from('fichada')
    .select('id_fichada, fecha_hora, tipo, origen')
    .in('id_fichada', ids)
  if (error) throw error
  const m = new Map()
  for (const o of data ?? []) m.set(o.id_fichada, o)
  return m
}

async function fetchOriginalRow(supabase, idFichadaOriginal) {
  if (idFichadaOriginal == null) return null
  const id = Number(idFichadaOriginal)
  if (!Number.isFinite(id) || id <= 0) return null
  const { data, error } = await supabase
    .from('fichada')
    .select('id_fichada, fecha_hora, tipo, origen')
    .eq('id_fichada', id)
    .maybeSingle()
  if (error) throw error
  return data ?? null
}

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

    const originalsMap = await originalsByIds(supabase, data ?? [])

    const items = (data ?? []).map((p) => {
      const orig = originalsMap.get(Number(p.id_fichada_original)) ?? null
      return {
        id:           p.id_fichada,
        employeeId:   p.legajo,
        legajo:       String(p.legajo).padStart(4, '0'),
        employeeName: p.empleado ? `${p.empleado.nombre} ${p.empleado.apellido}` : null,
        timestamp:    p.fecha_hora,
        type:         p.tipo,
        origin:       p.origen,
        correction:   p.es_correccion,
        originalId:   p.id_fichada_original ?? null,
        ...(orig
          ? {
              originalTimestamp: orig.fecha_hora,
              originalType: orig.tipo,
              originalOrigin: orig.origen,
            }
          : {}),
      }
    })

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

    const orig = await fetchOriginalRow(supabase, data.id_fichada_original)
    return ok(res, {
      id:           data.id_fichada,
      employeeId:   data.legajo,
      employeeName: data.empleado ? `${data.empleado.nombre} ${data.empleado.apellido}` : null,
      timestamp:    data.fecha_hora,
      type:         data.tipo,
      origin:       data.origen,
      correction:   data.es_correccion,
      originalId:   data.id_fichada_original ?? null,
      ...(orig
        ? {
            originalTimestamp: orig.fecha_hora,
            originalType: orig.tipo,
            originalOrigin: orig.origen,
          }
        : {}),
    })
  } catch (err) {
    serverError(res, err)
  }
})

// POST /punches
router.post('/', async (req, res) => {
  try {
    const { legajo, fechaHora, tipo, origen = 'Api', idUsuarioRegistro } = req.body
    if (!legajo || !fechaHora || !tipo)
      return badRequest(res, 'legajo, fechaHora y tipo son requeridos')

    const normalizedOrigin = normalizeOrigenFichada(origen)
    if (!['Biometrico', 'Manual', 'Qr', 'Api', 'Pin'].includes(normalizedOrigin))
      return badRequest(res, 'origen inválido')

    const { data, legajoNum } = await insertPunch({
      legajo,
      fechaHora,
      tipo,
      origen: normalizedOrigin,
      idUsuarioRegistro: idUsuarioRegistro ?? req.user?.sub ?? null,
    })
    const attendanceEvaluation = await evaluateAfterPunch(legajoNum, fechaHora)
    return created(res, { fichada: data, attendanceEvaluation })
  } catch (err) {
    if (err.statusCode === 400) return badRequest(res, err.message)
    serverError(res, err)
  }
})

// POST /punches/manual
router.post('/manual', async (req, res) => {
  try {
    const { legajo, fechaHora, tipo, idUsuarioRegistro } = req.body
    if (!legajo || !fechaHora || !tipo)
      return badRequest(res, 'legajo, fechaHora y tipo son requeridos')

    const { data, legajoNum } = await insertPunch({
      legajo,
      fechaHora,
      tipo,
      origen: 'Manual',
      idUsuarioRegistro: idUsuarioRegistro ?? req.user?.sub ?? null,
    })
    const attendanceEvaluation = await evaluateAfterPunch(legajoNum, fechaHora)

    return created(res, { fichada: data, attendanceEvaluation })
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

    const { data } = await insertPunch({
      legajo: original.legajo,
      fechaHora,
      tipo,
      origen: 'Manual',
      esCorreccion: true,
      idFichadaOriginal: Number(req.params.id),
      idUsuarioRegistro: idUsuarioRegistro ?? req.user?.sub ?? null,
    })
    return created(res, data)
  } catch (err) {
    serverError(res, err)
  }
})

// DELETE /punches/:id
router.delete('/:id', async (_req, res) => {
  return res.status(405).json({ error: { code: 'METHOD_NOT_ALLOWED', message: 'Las fichadas no se eliminan; registrá una corrección trazable.' } })
})

export default router
