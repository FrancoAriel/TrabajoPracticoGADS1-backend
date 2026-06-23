import { Router } from 'express'
import supabase from '../lib/supabase.js'
import { ok, created, badRequest, serverError } from '../lib/response.js'
import { nowLocalIso } from '../lib/pinFichada.js'
import { normalizeTipoFichada, normalizeOrigenFichada, insertPunch, evaluateAfterPunch } from './punchesShared.js'

const router = Router()

const MONTHS = [
  'Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
  'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre',
]

const YMD_RE = /^\d{4}-\d{2}-\d{2}$/

const EMPLOYEE_REQUEST_TYPES = new Set([
  'Licencia',
  'Vacaciones',
  'Permiso_especial',
  'Justificacion',
])

const TYPE_TO_UNIT = {
  Licencia: 'Dias',
  Vacaciones: 'Dias',
  Permiso_especial: 'Dias',
  Justificacion: 'Dias',
}

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

function resolveRange(query) {
  const base = currentMonthRange()
  const desde = query.desde && YMD_RE.test(String(query.desde)) ? String(query.desde) : base.desde
  const hasta = query.hasta && YMD_RE.test(String(query.hasta)) ? String(query.hasta) : base.hasta
  return { desde, hasta, periodo: base.periodo }
}

function legajoFromUser(req, res) {
  const legajo = Number(req.user?.legajo)
  if (!Number.isFinite(legajo) || legajo <= 0) {
    badRequest(res, 'Tu usuario no tiene un legajo asociado')
    return null
  }
  return legajo
}

function normalizeNewsStatusFilter(status) {
  const s = String(status ?? '').trim().toLowerCase()
  if (s === 'pendiente') return 'Pendiente'
  if (s === 'aprobada' || s === 'aprobado') return 'Aprobada'
  if (s === 'rechazada' || s === 'rechazado') return 'Rechazada'
  if (['Pendiente', 'Aprobada', 'Rechazada'].includes(String(status ?? '').trim())) return String(status).trim()
  return null
}

function normalizeNewsTypeFilter(type) {
  const s = String(type ?? '').trim()
  const map = {
    licencia: 'Licencia',
    vacaciones: 'Vacaciones',
    permiso_especial: 'Permiso_especial',
    justificacion: 'Justificacion',
    Licencia: 'Licencia',
    Vacaciones: 'Vacaciones',
    Permiso_especial: 'Permiso_especial',
    Justificacion: 'Justificacion',
  }
  return map[s] ?? map[s.toLowerCase()] ?? null
}

function normalizeTipoSolicitud(tipo) {
  const s = String(tipo ?? '').trim()
  const map = {
    licencia: 'Licencia',
    vacaciones: 'Vacaciones',
    permiso_especial: 'Permiso_especial',
    justificacion: 'Justificacion',
    Licencia: 'Licencia',
    Vacaciones: 'Vacaciones',
    Permiso_especial: 'Permiso_especial',
    Justificacion: 'Justificacion',
  }
  return map[s] ?? map[s.toLowerCase()] ?? null
}

// GET /me — resumen del empleado logueado
router.get('/', async (req, res) => {
  try {
    const legajo = legajoFromUser(req, res)
    if (!legajo) return

    const { data, error } = await supabase
      .from('empleado')
      .select('*, asignacion_horario(*, horario(nombre, tipo)), empleado_ciclo(*, ciclo_horario(nombre))')
      .eq('legajo', legajo)
      .single()

    if (error || !data) return badRequest(res, 'Empleado no encontrado')

    const asig = data.asignacion_horario?.find((a) => !a.fecha_hasta) ?? data.asignacion_horario?.[0]
    const ciclo = data.empleado_ciclo?.find((c) => !c.fecha_fin) ?? null

    const [{ data: punches }, { data: news }, { count: pendingNews }] = await Promise.all([
      supabase.from('fichada').select('id_fichada, fecha_hora, tipo, origen, es_correccion').eq('legajo', legajo).order('fecha_hora', { ascending: false }).limit(8),
      supabase.from('novedad').select('id_novedad, tipo, fecha_desde, fecha_hasta, cantidad, unidad, estado, origen, observacion, fecha_creacion').eq('legajo', legajo).order('fecha_creacion', { ascending: false }).limit(8),
      supabase.from('novedad').select('*', { count: 'exact', head: true }).eq('legajo', legajo).eq('estado', 'Pendiente'),
    ])

    const parcialHorasVal = data.horas_jornada_parcial != null ? Number(data.horas_jornada_parcial) : null

    return ok(res, {
      employee: {
        id: data.legajo,
        legajo: String(data.legajo).padStart(4, '0'),
        name: `${data.nombre} ${data.apellido}`,
        dni: data.dni,
        cuil: data.cuil,
        status: data.estado,
        category: data.categoria_laboral,
        convenio: data.convenio,
        jornada: data.tipo_jornada,
        parcialHoras: parcialHorasVal,
        fechaIngreso: data.fecha_ingreso,
        modalidadFichada: data.modalidad_fichada,
      },
      scheduleConfig: {
        schedule: asig?.horario?.nombre ?? null,
        cycle: ciclo?.ciclo_horario?.nombre ?? null,
        jornada: data.tipo_jornada,
      },
      stats: {
        pendingNews: pendingNews ?? 0,
        recentPunches: (punches ?? []).length,
      },
      recentPunches: (punches ?? []).map((p) => ({
        id: p.id_fichada,
        timestamp: p.fecha_hora,
        type: p.tipo,
        origin: p.origen,
        correction: p.es_correccion,
      })),
      recentNews: (news ?? []).map((n) => ({
        id: n.id_novedad,
        type: n.tipo,
        date: n.fecha_desde,
        dateTo: n.fecha_hasta,
        status: n.estado,
        quantity: n.cantidad,
        unit: n.unidad,
        origin: n.origen,
        note: n.observacion,
        createdAt: n.fecha_creacion,
      })),
      requestTypes: [...EMPLOYEE_REQUEST_TYPES],
    })
  } catch (err) {
    serverError(res, err)
  }
})

// GET /me/punches
router.get('/punches', async (req, res) => {
  try {
    const legajo = legajoFromUser(req, res)
    if (!legajo) return

    const { page = 1, pageSize = 15, date, type, origin, correction } = req.query
    const ps = Number(pageSize) || 15
    const from = (Number(page) - 1) * ps
    const to = from + ps - 1

    let query = supabase
      .from('fichada')
      .select('*', { count: 'exact' })
      .eq('legajo', legajo)
      .order('fecha_hora', { ascending: false })

    if (date) {
      query = query
        .gte('fecha_hora', `${date}T00:00:00`)
        .lte('fecha_hora', `${date}T23:59:59`)
    }

    const typeNorm = normalizeTipoFichada(type)
    if (type && ['Entrada', 'Salida'].includes(typeNorm)) query = query.eq('tipo', typeNorm)

    const originNorm = normalizeOrigenFichada(origin)
    if (origin && originNorm) query = query.eq('origen', originNorm)

    if (correction === 'true') query = query.eq('es_correccion', true)
    if (correction === 'false') query = query.eq('es_correccion', false)

    const { data, count, error } = await query.range(from, to)
    if (error) throw error

    const items = (data ?? []).map((p) => ({
      id: p.id_fichada,
      timestamp: p.fecha_hora,
      type: p.tipo,
      origin: p.origen,
      correction: p.es_correccion,
    }))

    return ok(res, { items }, {
      page: Number(page),
      pageSize: ps,
      totalItems: count ?? 0,
      totalPages: Math.ceil((count ?? 0) / ps) || 1,
    })
  } catch (err) {
    serverError(res, err)
  }
})

// POST /me/punches — fichada del empleado logueado (portal)
router.post('/punches', async (req, res) => {
  try {
    const legajo = legajoFromUser(req, res)
    if (!legajo) return

    const tipoNorm = normalizeTipoFichada(req.body?.tipo)
    if (!tipoNorm || !['Entrada', 'Salida'].includes(tipoNorm))
      return badRequest(res, 'tipo inválido (Entrada o Salida)')

    const { data: empleado, error: empErr } = await supabase
      .from('empleado')
      .select('legajo, nombre, apellido, estado')
      .eq('legajo', legajo)
      .maybeSingle()

    if (empErr) throw empErr
    if (!empleado) return badRequest(res, 'Empleado no encontrado')

    if (String(empleado.estado || '').toLowerCase() !== 'activo')
      return badRequest(res, 'Tu cuenta no está activa')

    const fechaHora = nowLocalIso()
    const { data } = await insertPunch({
      legajo,
      fechaHora,
      tipo: tipoNorm,
      origen: 'Api',
      idUsuarioRegistro: req.user?.sub ?? null,
    })

    const attendanceEvaluation = await evaluateAfterPunch(legajo, fechaHora)

    return created(res, {
      punch: {
        id: data.id_fichada,
        timestamp: data.fecha_hora,
        type: data.tipo,
        origin: data.origen,
        correction: data.es_correccion,
      },
      employee: {
        legajo: String(legajo).padStart(4, '0'),
        name: `${empleado.nombre} ${empleado.apellido}`.trim(),
      },
      attendanceEvaluation,
    })
  } catch (err) {
    if (err.statusCode === 400) return badRequest(res, err.message)
    serverError(res, err)
  }
})

// GET /me/news
router.get('/news', async (req, res) => {
  try {
    const legajo = legajoFromUser(req, res)
    if (!legajo) return

    const { status, type, dateFrom, dateTo, page = 1, pageSize = 20 } = req.query
    const ps = Number(pageSize) || 20
    const from = (Number(page) - 1) * ps
    const to = from + ps - 1

    let query = supabase
      .from('novedad')
      .select('*', { count: 'exact' })
      .eq('legajo', legajo)
      .order('fecha_creacion', { ascending: false })

    const statusNorm = normalizeNewsStatusFilter(status)
    if (statusNorm) query = query.eq('estado', statusNorm)

    const typeNorm = normalizeNewsTypeFilter(type)
    if (typeNorm) query = query.eq('tipo', typeNorm)

    if (dateFrom) query = query.gte('fecha_desde', dateFrom)
    if (dateTo) query = query.lte('fecha_desde', dateTo)

    const { data, count, error } = await query.range(from, to)
    if (error) throw error

    const [{ count: pending }, { count: approved }, { count: rejected }] = await Promise.all([
      supabase.from('novedad').select('*', { count: 'exact', head: true }).eq('legajo', legajo).eq('estado', 'Pendiente'),
      supabase.from('novedad').select('*', { count: 'exact', head: true }).eq('legajo', legajo).eq('estado', 'Aprobada'),
      supabase.from('novedad').select('*', { count: 'exact', head: true }).eq('legajo', legajo).eq('estado', 'Rechazada'),
    ])

    const items = (data ?? []).map((n) => ({
      id: n.id_novedad,
      type: n.tipo,
      date: n.fecha_desde,
      dateTo: n.fecha_hasta,
      status: n.estado,
      quantity: n.cantidad,
      unit: n.unidad,
      origin: n.origen,
      note: n.observacion,
      createdAt: n.fecha_creacion,
    }))

    return ok(res, {
      stats: { pending: pending ?? 0, approved: approved ?? 0, rejected: rejected ?? 0 },
      items,
    }, {
      page: Number(page),
      pageSize: ps,
      totalItems: count ?? 0,
      totalPages: Math.ceil((count ?? 0) / ps) || 1,
    })
  } catch (err) {
    serverError(res, err)
  }
})

// POST /me/news — solicitud del empleado (queda Pendiente)
router.post('/news', async (req, res) => {
  try {
    const legajo = legajoFromUser(req, res)
    if (!legajo) return

    const { tipo, fechaDesde, fechaHasta, cantidad, observacion } = req.body
    const tipoNorm = normalizeTipoSolicitud(tipo)

    if (!tipoNorm || !EMPLOYEE_REQUEST_TYPES.has(tipoNorm))
      return badRequest(res, 'Tipo de solicitud no permitido para empleados')

    if (!fechaDesde)
      return badRequest(res, 'fechaDesde es requerida')

    const cant = cantidad == null || cantidad === '' ? 1 : Number(cantidad)
    if (!Number.isFinite(cant) || cant <= 0)
      return badRequest(res, 'cantidad inválida')

    const unidad = TYPE_TO_UNIT[tipoNorm] ?? 'Dias'

    const { data, error } = await supabase
      .from('novedad')
      .insert({
        legajo,
        tipo: tipoNorm,
        fecha_desde: fechaDesde,
        fecha_hasta: fechaHasta || fechaDesde,
        cantidad: cant,
        unidad,
        estado: 'Pendiente',
        origen: 'Manual',
        observacion: observacion || null,
        fecha_creacion: new Date().toISOString(),
        id_usuario_creacion: req.user?.sub ?? null,
      })
      .select()
      .single()

    if (error) throw error
    return created(res, data)
  } catch (err) {
    serverError(res, err)
  }
})

// GET /me/summary?desde=&hasta= — mini resumen del período (desde feature/maxi)
router.get('/summary', async (req, res) => {
  try {
    const legajo = legajoFromUser(req, res)
    if (!legajo) return

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
