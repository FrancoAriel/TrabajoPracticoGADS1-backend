import { Router } from 'express'
import supabase from '../lib/supabase.js'
import { ok, badRequest, serverError } from '../lib/response.js'

const router = Router()

const MONTHS = [
  'Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
  'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre',
]

const YMD_RE = /^\d{4}-\d{2}-\d{2}$/

/**
 * Rango del mes actual del servidor (YYYY-MM-DD .. YYYY-MM-DD), usado como
 * default cuando el cliente no manda `desde`/`hasta`. Decisión de diseño:
 * lo más simple y predecible para "MI PANEL". El cliente puede acotar con
 * ?desde=&hasta= (ambos en formato YYYY-MM-DD).
 */
function currentMonthRange(date = new Date()) {
  const y = date.getFullYear()
  const m = date.getMonth()
  const last = new Date(y, m + 1, 0)
  return {
    desde: `${y}-${String(m + 1).padStart(2, '0')}-01`,
    hasta: `${y}-${String(m + 1).padStart(2, '0')}-${String(last.getDate()).padStart(2, '0')}`,
    periodo: `${MONTHS[m]} ${y}`,
  }
}

/** Resuelve el rango pedido validando formato; cae al mes actual si falta. */
function resolveRange(query) {
  const base = currentMonthRange()
  const desde = query.desde && YMD_RE.test(String(query.desde)) ? String(query.desde) : base.desde
  const hasta = query.hasta && YMD_RE.test(String(query.hasta)) ? String(query.hasta) : base.hasta
  return { desde, hasta, periodo: base.periodo }
}

/**
 * Obtiene el legajo del usuario logueado EXCLUSIVAMENTE desde el token.
 * Nunca se lee de query/body, por lo que el cliente no puede sobreescribir
 * el scope. Devuelve null si el usuario no tiene legajo asociado (p. ej. Admin).
 */
function tokenLegajo(req) {
  const raw = req.user?.legajo
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? n : null
}

// GET /me/punches?desde=YYYY-MM-DD&hasta=YYYY-MM-DD
router.get('/punches', async (req, res) => {
  try {
    const legajo = tokenLegajo(req)
    if (legajo == null)
      return badRequest(res, 'El usuario logueado no tiene un legajo asociado')

    const { desde, hasta } = resolveRange(req.query)

    const { data, error } = await supabase
      .from('fichada')
      .select('id_fichada, legajo, fecha_hora, tipo, origen, es_correccion, id_fichada_original')
      .eq('legajo', legajo)
      .gte('fecha_hora', `${desde}T00:00:00`)
      .lte('fecha_hora', `${hasta}T23:59:59.999`)
      .order('fecha_hora', { ascending: false })
    if (error) throw error

    const items = (data ?? []).map((p) => ({
      id:         p.id_fichada,
      employeeId: p.legajo,
      legajo:     String(p.legajo).padStart(4, '0'),
      timestamp:  p.fecha_hora,
      type:       p.tipo,
      origin:     p.origen,
      correction: p.es_correccion,
      originalId: p.id_fichada_original ?? null,
    }))

    return ok(res, { range: { desde, hasta }, items })
  } catch (err) {
    serverError(res, err)
  }
})

// GET /me/news?status=&type=&desde=&hasta=
router.get('/news', async (req, res) => {
  try {
    const legajo = tokenLegajo(req)
    if (legajo == null)
      return badRequest(res, 'El usuario logueado no tiene un legajo asociado')

    const { status, type } = req.query
    const { desde, hasta } = resolveRange(req.query)

    let query = supabase
      .from('novedad')
      .select('id_novedad, legajo, tipo, fecha_desde, fecha_hasta, cantidad, unidad, estado, origen, observacion, fecha_creacion')
      .eq('legajo', legajo)
      .gte('fecha_desde', desde)
      .lte('fecha_desde', hasta)

    if (status) query = query.eq('estado', status)
    if (type)   query = query.eq('tipo', type)

    query = query.order('fecha_creacion', { ascending: false })

    const { data, error } = await query
    if (error) throw error

    const items = (data ?? []).map((n) => ({
      id:        n.id_novedad,
      employeeId: n.legajo,
      type:      n.tipo,
      date:      n.fecha_desde,
      dateTo:    n.fecha_hasta,
      status:    n.estado,
      quantity:  n.cantidad,
      unit:      n.unidad,
      origin:    n.origen,
      createdAt: n.fecha_creacion,
      note:      n.observacion,
    }))

    const stats = items.reduce(
      (acc, n) => {
        if (n.status === 'Pendiente') acc.pending += 1
        else if (n.status === 'Aprobada') acc.approved += 1
        else if (n.status === 'Rechazada') acc.rejected += 1
        return acc
      },
      { pending: 0, approved: 0, rejected: 0 },
    )

    return ok(res, { range: { desde, hasta }, stats, items })
  } catch (err) {
    serverError(res, err)
  }
})

// GET /me/summary?desde=&hasta=  — mini resumen propio del período
router.get('/summary', async (req, res) => {
  try {
    const legajo = tokenLegajo(req)
    if (legajo == null)
      return badRequest(res, 'El usuario logueado no tiene un legajo asociado')

    const { desde, hasta, periodo } = resolveRange(req.query)

    const [{ data: entradas, error: entErr }, { data: novedades, error: novErr }] = await Promise.all([
      supabase
        .from('fichada')
        .select('fecha_hora')
        .eq('legajo', legajo)
        .eq('tipo', 'Entrada')
        .gte('fecha_hora', `${desde}T00:00:00`)
        .lte('fecha_hora', `${hasta}T23:59:59.999`),
      supabase
        .from('novedad')
        .select('tipo, cantidad, estado')
        .eq('legajo', legajo)
        .gte('fecha_desde', desde)
        .lte('fecha_desde', hasta),
    ])
    if (entErr) throw entErr
    if (novErr) throw novErr

    const presentDays = new Set((entradas ?? []).map((e) => String(e.fecha_hora).slice(0, 10))).size

    let tardanzaMin = 0
    let he50Min = 0
    let he100Min = 0
    let ausencias = 0
    let pendingNews = 0
    for (const n of novedades ?? []) {
      const cant = Number(n.cantidad) || 0
      if (n.tipo === 'Tardanza') tardanzaMin += cant
      if (n.tipo === 'Horas_Extra_50') he50Min += cant
      if (n.tipo === 'Horas_Extra_100') he100Min += cant
      if (n.tipo === 'Ausencia') ausencias += cant || 1
      if (n.estado === 'Pendiente') pendingNews += 1
    }

    return ok(res, {
      periodo,
      range: { desde, hasta },
      presentDays,
      tardanzaMin,
      he50Min,
      he100Min,
      ausencias,
      pendingNews,
    })
  } catch (err) {
    serverError(res, err)
  }
})

export default router
