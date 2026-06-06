import { Router } from 'express'
import supabase from '../lib/supabase.js'
import { ok, created, notFound, badRequest, serverError } from '../lib/response.js'

const router = Router()

const MONTHS = [
  'Enero',
  'Febrero',
  'Marzo',
  'Abril',
  'Mayo',
  'Junio',
  'Julio',
  'Agosto',
  'Septiembre',
  'Octubre',
  'Noviembre',
  'Diciembre',
]

function currentPeriodLabel(date = new Date()) {
  return `${MONTHS[date.getMonth()]} ${date.getFullYear()}`
}

function periodRange(periodo = currentPeriodLabel()) {
  const [monthLabel, yearText] = String(periodo).trim().split(/\s+/)
  const monthIndex = MONTHS.findIndex((m) => m.toLowerCase() === String(monthLabel).toLowerCase())
  const year = Number(yearText)
  if (monthIndex < 0 || !Number.isInteger(year)) return null
  const desde = new Date(year, monthIndex, 1)
  const hasta = new Date(year, monthIndex + 1, 0)
  return {
    desde: `${desde.getFullYear()}-${String(desde.getMonth() + 1).padStart(2, '0')}-01`,
    hasta: `${hasta.getFullYear()}-${String(hasta.getMonth() + 1).padStart(2, '0')}-${String(hasta.getDate()).padStart(2, '0')}`,
  }
}

function addMonths(date, delta) {
  return new Date(date.getFullYear(), date.getMonth() + delta, 1)
}

function minutesToText(minutes) {
  const total = Math.round(Number(minutes) || 0)
  if (total <= 0) return '0'
  const h = Math.floor(total / 60)
  const m = total % 60
  if (!h) return `${m}m`
  if (!m) return `${h}h`
  return `${h}h ${String(m).padStart(2, '0')}m`
}

function numeric(value) {
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

function summarizeEmployeeBreakdown({ employees = [], novedades = [], workedDaysByLegajo = new Map(), pendingByLegajo = new Map() }) {
  const byLegajo = new Map()
  for (const e of employees) {
    byLegajo.set(Number(e.legajo), {
      id: e.legajo,
      legajo: String(e.legajo).padStart(4, '0'),
      name: `${e.nombre} ${e.apellido}`,
      workedDays: workedDaysByLegajo.get(Number(e.legajo)) ?? 0,
      he50Minutes: 0,
      he100Minutes: 0,
      unjustifiedAbsences: 0,
      justifiedAbsences: 0,
      lateMinutes: 0,
      approvedNews: 0,
      pendingNews: pendingByLegajo.get(Number(e.legajo)) ?? 0,
    })
  }

  for (const n of novedades) {
    const legajo = Number(n.legajo)
    if (!byLegajo.has(legajo)) {
      byLegajo.set(legajo, {
        id: legajo,
        legajo: String(legajo).padStart(4, '0'),
        name: n.empleado ? `${n.empleado.nombre} ${n.empleado.apellido}` : `Legajo ${legajo}`,
        workedDays: workedDaysByLegajo.get(legajo) ?? 0,
        he50Minutes: 0,
        he100Minutes: 0,
        unjustifiedAbsences: 0,
        justifiedAbsences: 0,
        lateMinutes: 0,
        approvedNews: 0,
        pendingNews: pendingByLegajo.get(legajo) ?? 0,
      })
    }
    const row = byLegajo.get(legajo)
    row.approvedNews += 1
    if (n.tipo === 'Horas_Extra_50') row.he50Minutes += numeric(n.cantidad)
    if (n.tipo === 'Horas_Extra_100') row.he100Minutes += numeric(n.cantidad)
    if (n.tipo === 'Tardanza') row.lateMinutes += numeric(n.cantidad)
    if (n.tipo === 'Ausencia') row.unjustifiedAbsences += numeric(n.cantidad || 1)
    if (n.tipo === 'Justificacion') row.justifiedAbsences += numeric(n.cantidad || 1)
  }

  return [...byLegajo.values()]
    .map((row) => ({
      ...row,
      normal: `${row.workedDays} día${row.workedDays === 1 ? '' : 's'}`,
      he50: minutesToText(row.he50Minutes),
      he100: minutesToText(row.he100Minutes),
      tardanzas: minutesToText(row.lateMinutes),
      ausencias: String(row.unjustifiedAbsences),
      estado: row.pendingNews > 0 ? 'Pendiente' : 'OK',
    }))
    .sort((a, b) => Number(a.legajo) - Number(b.legajo))
}

async function getWorkedDaysByLegajo(range) {
  const { data, error } = await supabase
    .from('fichada')
    .select('legajo, fecha_hora')
    .eq('tipo', 'Entrada')
    .gte('fecha_hora', `${range.desde}T00:00:00`)
    .lte('fecha_hora', `${range.hasta}T23:59:59.999`)

  if (error) throw error
  const days = new Map()
  for (const punch of data ?? []) {
    const legajo = Number(punch.legajo)
    if (!days.has(legajo)) days.set(legajo, new Set())
    days.get(legajo).add(String(punch.fecha_hora).slice(0, 10))
  }
  return new Map([...days.entries()].map(([legajo, set]) => [legajo, set.size]))
}

async function getPeriodData(periodo) {
  const range = periodRange(periodo)
  if (!range) throw new Error('Período inválido. Usá formato "Junio 2025".')

  const [{ data: employees, error: empErr }, { data: approvedNews, error: approvedErr }, { data: pendingNews, error: pendingErr }] =
    await Promise.all([
      supabase.from('empleado').select('legajo, nombre, apellido').eq('estado', 'Activo').order('legajo'),
      supabase
        .from('novedad')
        .select('*, empleado(nombre, apellido)')
        .eq('estado', 'Aprobada')
        .gte('fecha_desde', range.desde)
        .lte('fecha_desde', range.hasta),
      supabase
        .from('novedad')
        .select('legajo')
        .eq('estado', 'Pendiente')
        .gte('fecha_desde', range.desde)
        .lte('fecha_desde', range.hasta),
    ])

  if (empErr) throw empErr
  if (approvedErr) throw approvedErr
  if (pendingErr) throw pendingErr

  const pendingByLegajo = new Map()
  for (const n of pendingNews ?? []) {
    const legajo = Number(n.legajo)
    pendingByLegajo.set(legajo, (pendingByLegajo.get(legajo) ?? 0) + 1)
  }
  const workedDaysByLegajo = await getWorkedDaysByLegajo(range)
  const employeeBreakdown = summarizeEmployeeBreakdown({
    employees: employees ?? [],
    novedades: approvedNews ?? [],
    workedDaysByLegajo,
    pendingByLegajo,
  })

  const totals = employeeBreakdown.reduce(
    (acc, row) => {
      acc.he50Minutes += row.he50Minutes
      acc.he100Minutes += row.he100Minutes
      acc.unjustifiedAbsences += row.unjustifiedAbsences
      acc.justifiedAbsences += row.justifiedAbsences
      acc.lateMinutes += row.lateMinutes
      acc.approvedNews += row.approvedNews
      acc.pendingNews += row.pendingNews
      return acc
    },
    { he50Minutes: 0, he100Minutes: 0, unjustifiedAbsences: 0, justifiedAbsences: 0, lateMinutes: 0, approvedNews: 0, pendingNews: 0 },
  )

  return {
    range,
    approvedNews: approvedNews ?? [],
    pendingNews: pendingNews ?? [],
    employeeBreakdown,
    totals: {
      ...totals,
      he50: minutesToText(totals.he50Minutes),
      he100: minutesToText(totals.he100Minutes),
      tardanzas: minutesToText(totals.lateMinutes),
    },
  }
}

function buildPeriodCards(currentPeriod, history) {
  const now = new Date()
  const prev = currentPeriodLabel(addMonths(now, -1))
  const next = currentPeriodLabel(addMonths(now, 1))
  const closed = new Set((history ?? []).map((h) => h.periodo))
  return [
    { id: prev.toLowerCase().replace(/\s+/g, '-'), label: prev, status: closed.has(prev) ? 'Cerrado' : 'Pendiente' },
    { id: currentPeriod.toLowerCase().replace(/\s+/g, '-'), label: currentPeriod, status: closed.has(currentPeriod) ? 'Cerrado' : 'En progreso' },
    { id: next.toLowerCase().replace(/\s+/g, '-'), label: next, status: 'Futuro' },
  ]
}

// GET /closures/current
router.get('/current', async (req, res) => {
  try {
    const requestedPeriod = req.query.periodo ? String(req.query.periodo) : null
    const { data: currentDraft, error: currentDraftErr } = await supabase
      .from('cierre_mensual')
      .select('*, usuario(nombre)')
      .eq('estado', 'Borrador')
      .order('fecha_cierre', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (currentDraftErr) throw currentDraftErr

    const currentPeriod = requestedPeriod || currentDraft?.periodo || currentPeriodLabel()
    const periodData = await getPeriodData(currentPeriod)

    const { data: currentPeriodClosure, error: currentPeriodClosureErr } = await supabase
      .from('cierre_mensual')
      .select('*, usuario(nombre)')
      .eq('periodo', currentPeriod)
      .order('fecha_cierre', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (currentPeriodClosureErr) throw currentPeriodClosureErr

    const { data: history, error: historyErr } = await supabase
      .from('cierre_mensual')
      .select('id_cierre, periodo, fecha_cierre, estado, archivo_exportado')
      .eq('estado', 'Cerrado')
      .order('fecha_cierre', { ascending: false })
      .limit(6)
    if (historyErr) throw historyErr

    const currentClosure = currentDraft?.periodo === currentPeriod
      ? currentDraft
      : currentPeriodClosure

    const checklist = [
      {
        key: 'review-pending-news',
        title: 'Aprobar novedades pendientes',
        sub: periodData.totals.pendingNews
          ? `${periodData.totals.pendingNews} novedades esperando revisión`
          : 'Sin novedades pendientes',
        done: periodData.totals.pendingNews === 0,
      },
      {
        key: 'validate-summary',
        title: 'Validar totales por empleado',
        sub: `${periodData.employeeBreakdown.length} empleados incluidos en el resumen`,
        done: periodData.employeeBreakdown.length > 0,
      },
      {
        key: 'export-accountant',
        title: 'Exportar resumen al contador',
        sub: currentClosure?.estado === 'Cerrado'
          ? currentClosure.archivo_exportado
            ? `Archivo generado: ${currentClosure.archivo_exportado}`
            : 'Período cerrado y listo para exportar'
          : 'Disponible cuando el cierre esté cerrado',
        done: currentClosure?.estado === 'Cerrado',
      },
    ]

    return ok(res, {
      currentPeriod,
      currentClosure: currentClosure ? {
        id: currentClosure.id_cierre,
        periodo: currentClosure.periodo,
        fechaCierre: currentClosure.fecha_cierre,
        estado: currentClosure.estado,
        usuario: currentClosure.usuario?.nombre,
        archivoExportado: currentClosure.archivo_exportado,
      } : null,
      stats: {
        liquidated: periodData.totals.approvedNews,
        pending: periodData.totals.pendingNews,
        he50: periodData.totals.he50,
        he100: periodData.totals.he100,
        tardanzas: periodData.totals.tardanzas,
        ausencias: periodData.totals.unjustifiedAbsences,
      },
      periodCards: buildPeriodCards(currentPeriod, history ?? []),
      history: (history ?? []).map((h) => ({
        id: h.id_cierre,
        periodo: h.periodo,
        fechaCierre: h.fecha_cierre,
        estado: h.estado,
        archivoExportado: h.archivo_exportado,
      })),
      employeeBreakdown: periodData.employeeBreakdown,
      checklist,
    })
  } catch (err) {
    serverError(res, err)
  }
})

// POST /closures
router.post('/', async (req, res) => {
  try {
    const { periodo = currentPeriodLabel(), fechaCierre = new Date().toISOString().slice(0, 10), idUsuario = 1, archivoExportado = '' } = req.body
    if (!periodRange(periodo)) return badRequest(res, 'periodo debe tener formato "Junio 2025"')

    const { data, error } = await supabase
      .from('cierre_mensual')
      .insert({ periodo, fecha_cierre: fechaCierre, estado: 'Borrador', id_usuario: idUsuario, archivo_exportado: archivoExportado })
      .select()
      .single()

    if (error) throw error
    return created(res, data)
  } catch (err) {
    serverError(res, err)
  }
})

// POST /closures/:id/run
router.post('/:id/run', async (req, res) => {
  try {
    const { force = false, archivoExportado = '' } = req.body ?? {}
    const { data: closure, error: fetchErr } = await supabase
      .from('cierre_mensual')
      .select('*')
      .eq('id_cierre', req.params.id)
      .single()

    if (fetchErr || !closure) return notFound(res, 'Cierre no encontrado')
    if (closure.estado === 'Cerrado') return badRequest(res, 'El cierre ya está en estado cerrado')

    const periodData = await getPeriodData(closure.periodo)
    if (periodData.totals.pendingNews > 0 && !force) {
      return badRequest(res, 'No se puede cerrar con novedades pendientes', {
        pendingNews: periodData.totals.pendingNews,
      })
    }

    if (periodData.approvedNews.length > 0) {
      const detalles = periodData.approvedNews.map((n) => ({
        id_cierre: closure.id_cierre,
        id_novedad: n.id_novedad,
        legajo: n.legajo,
        tipo_novedad: n.tipo,
        fecha_desde: n.fecha_desde,
        fecha_hasta: n.fecha_hasta,
        cantidad: n.cantidad,
        unidad: n.unidad,
        observacion: n.observacion,
        origen: n.origen,
        fecha_creacion: n.fecha_creacion,
      }))
      const { error: insertErr } = await supabase.from('cierre_mensual_detalle').insert(detalles)
      if (insertErr) throw insertErr
    }

    const { error: updateErr } = await supabase
      .from('cierre_mensual')
      .update({
        estado: 'Cerrado',
        archivo_exportado: archivoExportado || closure.archivo_exportado || `cierre_${closure.periodo.replace(/\s+/g, '_')}.csv`,
      })
      .eq('id_cierre', req.params.id)

    if (updateErr) throw updateErr

    return ok(res, {
      id: Number(req.params.id),
      estado: 'Cerrado',
      periodo: closure.periodo,
      novedadesIncluidas: periodData.approvedNews.length,
      employeeBreakdown: periodData.employeeBreakdown,
      totals: periodData.totals,
    })
  } catch (err) {
    serverError(res, err)
  }
})

// DELETE /closures/:id
router.delete('/:id', async (req, res) => {
  try {
    const { error } = await supabase.from('cierre_mensual').delete().eq('id_cierre', req.params.id)
    if (error) throw error
    return res.status(204).send()
  } catch (err) {
    serverError(res, err)
  }
})

export default router
