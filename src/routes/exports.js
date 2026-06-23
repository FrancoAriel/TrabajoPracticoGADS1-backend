import { Router } from 'express'
import supabase from '../lib/supabase.js'
import { badRequest, ok, serverError } from '../lib/response.js'

const router = Router()

const exportHistory = []
const exportFiles = new Map()

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

const REPORTS = [
  { key: 'punches', label: 'Fichadas', formatOptions: ['CSV'] },
  { key: 'news', label: 'Novedades', formatOptions: ['CSV'] },
  { key: 'employees', label: 'Empleados', formatOptions: ['CSV'] },
  { key: 'closure', label: 'Cierre mensual', formatOptions: ['CSV'] },
  { key: 'overtime', label: 'Horas extra', formatOptions: ['CSV'] },
  { key: 'assignments', label: 'Horarios asignados', formatOptions: ['CSV'] },
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

function periodOptions() {
  const now = new Date()
  return [-2, -1, 0].map((delta) => currentPeriodLabel(new Date(now.getFullYear(), now.getMonth() + delta, 1))).reverse()
}

function mapExportHistoryRow(row) {
  return {
    id: row.id_exportacion,
    exportId: row.id_exportacion,
    reportKey: row.reporte_key,
    report: row.reporte_label,
    period: row.periodo,
    format: row.formato,
    createdAt: row.fecha_creacion,
    date: row.fecha_creacion,
    user: row.usuario_nombre || 'Admin',
    downloadUrl: row.download_url,
  }
}

async function fetchPersistedExportHistory() {
  const { data, error } = await supabase
    .from('exportacion')
    .select('*')
    .order('fecha_creacion', { ascending: false })
    .limit(20)
  if (error) {
    console.warn('[exports] historial persistido no disponible:', error.message)
    return null
  }
  return (data ?? []).map(mapExportHistoryRow)
}

function csvEscape(value) {
  if (value == null) return ''
  const text = String(value)
  if (/[",\n\r;]/.test(text)) return `"${text.replace(/"/g, '""')}"`
  return text
}

function toCsv(rows, headers) {
  const lines = [headers.map(csvEscape).join(',')]
  for (const row of rows) {
    lines.push(headers.map((h) => csvEscape(row[h])).join(','))
  }
  return `${lines.join('\n')}\n`
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

function addBy(map, key, initial) {
  if (!map.has(key)) map.set(key, { ...initial })
  return map.get(key)
}

async function buildEmployeesCsv() {
  const { data, error } = await supabase
    .from('empleado')
    .select('legajo, nombre, apellido, dni, cuil, fecha_ingreso, categoria_laboral, convenio, tipo_jornada, estado, modalidad_fichada')
    .order('legajo')
  if (error) throw error
  const rows = (data ?? []).map((e) => ({
    Legajo: String(e.legajo).padStart(4, '0'),
    Nombre: `${e.nombre} ${e.apellido}`,
    DNI: e.dni,
    CUIL: e.cuil,
    Ingreso: e.fecha_ingreso,
    Categoria: e.categoria_laboral,
    Convenio: e.convenio,
    Jornada: e.tipo_jornada,
    Estado: e.estado,
    Fichada: e.modalidad_fichada,
  }))
  return toCsv(rows, ['Legajo', 'Nombre', 'DNI', 'CUIL', 'Ingreso', 'Categoria', 'Convenio', 'Jornada', 'Estado', 'Fichada'])
}

async function buildPunchesCsv(period) {
  const range = periodRange(period)
  if (!range) throw new Error('Período inválido')
  const { data, error } = await supabase
    .from('fichada')
    .select('id_fichada, legajo, fecha_hora, tipo, origen, es_correccion, empleado(nombre, apellido)')
    .gte('fecha_hora', `${range.desde}T00:00:00`)
    .lte('fecha_hora', `${range.hasta}T23:59:59.999`)
    .order('fecha_hora', { ascending: true })
  if (error) throw error
  const rows = (data ?? []).map((p) => ({
    ID: p.id_fichada,
    Legajo: String(p.legajo).padStart(4, '0'),
    Empleado: p.empleado ? `${p.empleado.nombre} ${p.empleado.apellido}` : '',
    FechaHora: p.fecha_hora,
    Tipo: p.tipo,
    Origen: p.origen,
    Correccion: p.es_correccion ? 'Si' : 'No',
  }))
  return toCsv(rows, ['ID', 'Legajo', 'Empleado', 'FechaHora', 'Tipo', 'Origen', 'Correccion'])
}

async function fetchNews(period, extra = {}) {
  const range = periodRange(period)
  if (!range) throw new Error('Período inválido')
  let q = supabase
    .from('novedad')
    .select('id_novedad, legajo, tipo, fecha_desde, fecha_hasta, cantidad, unidad, estado, origen, observacion, empleado(nombre, apellido)')
    .gte('fecha_desde', range.desde)
    .lte('fecha_desde', range.hasta)
  if (extra.estado) q = q.eq('estado', extra.estado)
  if (extra.tipos) q = q.in('tipo', extra.tipos)
  const { data, error } = await q.order('fecha_desde', { ascending: true })
  if (error) throw error
  return data ?? []
}

function newsRows(news) {
  return news.map((n) => ({
    ID: n.id_novedad,
    Legajo: String(n.legajo).padStart(4, '0'),
    Empleado: n.empleado ? `${n.empleado.nombre} ${n.empleado.apellido}` : '',
    Tipo: n.tipo,
    Desde: n.fecha_desde,
    Hasta: n.fecha_hasta,
    Cantidad: n.cantidad,
    Unidad: n.unidad,
    Estado: n.estado,
    Origen: n.origen,
    Observacion: n.observacion,
  }))
}

async function buildNewsCsv(period) {
  return toCsv(
    newsRows(await fetchNews(period)),
    ['ID', 'Legajo', 'Empleado', 'Tipo', 'Desde', 'Hasta', 'Cantidad', 'Unidad', 'Estado', 'Origen', 'Observacion'],
  )
}

async function buildOvertimeCsv(period) {
  return toCsv(
    newsRows(await fetchNews(period, { tipos: ['Horas_Extra_50', 'Horas_Extra_100'] })),
    ['ID', 'Legajo', 'Empleado', 'Tipo', 'Desde', 'Hasta', 'Cantidad', 'Unidad', 'Estado', 'Origen', 'Observacion'],
  )
}

async function buildAssignmentsCsv() {
  const { data, error } = await supabase
    .from('asignacion_horario')
    .select('id_asignacion, legajo, fecha_desde, fecha_hasta, empleado(nombre, apellido), horario(nombre, tipo)')
    .order('legajo')
  if (error) throw error
  const rows = (data ?? []).map((a) => ({
    ID: a.id_asignacion,
    Legajo: String(a.legajo).padStart(4, '0'),
    Empleado: a.empleado ? `${a.empleado.nombre} ${a.empleado.apellido}` : '',
    Horario: a.horario?.nombre,
    Tipo: a.horario?.tipo,
    Desde: a.fecha_desde,
    Hasta: a.fecha_hasta,
  }))
  return toCsv(rows, ['ID', 'Legajo', 'Empleado', 'Horario', 'Tipo', 'Desde', 'Hasta'])
}

async function buildClosureCsv(period) {
  const range = periodRange(period)
  if (!range) throw new Error('Período inválido')
  const [news, punches] = await Promise.all([
    fetchNews(period, { estado: 'Aprobada' }),
    supabase
      .from('fichada')
      .select('legajo, fecha_hora')
      .eq('tipo', 'Entrada')
      .gte('fecha_hora', `${range.desde}T00:00:00`)
      .lte('fecha_hora', `${range.hasta}T23:59:59.999`),
  ])
  if (punches.error) throw punches.error

  const worked = new Map()
  for (const punch of punches.data ?? []) {
    const legajo = Number(punch.legajo)
    if (!worked.has(legajo)) worked.set(legajo, new Set())
    worked.get(legajo).add(String(punch.fecha_hora).slice(0, 10))
  }

  const summary = new Map()
  for (const n of news) {
    const key = Number(n.legajo)
    const row = addBy(summary, key, {
      Legajo: String(key).padStart(4, '0'),
      Empleado: n.empleado ? `${n.empleado.nombre} ${n.empleado.apellido}` : '',
      DiasTrabajados: worked.get(key)?.size ?? 0,
      Ausencias: 0,
      Justificadas: 0,
      HE50Min: 0,
      HE100Min: 0,
      TardanzaMin: 0,
      NovedadesAprobadas: 0,
    })
    row.NovedadesAprobadas += 1
    if (n.tipo === 'Ausencia') row.Ausencias += Number(n.cantidad || 1)
    if (n.tipo === 'Justificacion') row.Justificadas += Number(n.cantidad || 1)
    if (n.tipo === 'Horas_Extra_50') row.HE50Min += Number(n.cantidad || 0)
    if (n.tipo === 'Horas_Extra_100') row.HE100Min += Number(n.cantidad || 0)
    if (n.tipo === 'Tardanza') row.TardanzaMin += Number(n.cantidad || 0)
  }

  for (const [legajo, days] of worked.entries()) {
    const row = addBy(summary, legajo, {
      Legajo: String(legajo).padStart(4, '0'),
      Empleado: '',
      DiasTrabajados: 0,
      Ausencias: 0,
      Justificadas: 0,
      HE50Min: 0,
      HE100Min: 0,
      TardanzaMin: 0,
      NovedadesAprobadas: 0,
    })
    row.DiasTrabajados = days.size
  }

  const rows = [...summary.values()].map((row) => ({
    Legajo: row.Legajo,
    Empleado: row.Empleado,
    DiasTrabajados: row.DiasTrabajados,
    AusenciasInjustificadas: row.Ausencias,
    AusenciasJustificadas: row.Justificadas,
    HorasExtra50: minutesToText(row.HE50Min),
    HorasExtra100: minutesToText(row.HE100Min),
    Tardanzas: minutesToText(row.TardanzaMin),
    NovedadesAprobadas: row.NovedadesAprobadas,
  }))
  return toCsv(rows, ['Legajo', 'Empleado', 'DiasTrabajados', 'AusenciasInjustificadas', 'AusenciasJustificadas', 'HorasExtra50', 'HorasExtra100', 'Tardanzas', 'NovedadesAprobadas'])
}

async function buildExport({ reportKey, period }) {
  if (reportKey === 'employees') return buildEmployeesCsv()
  if (reportKey === 'punches') return buildPunchesCsv(period)
  if (reportKey === 'news') return buildNewsCsv(period)
  if (reportKey === 'overtime') return buildOvertimeCsv(period)
  if (reportKey === 'assignments') return buildAssignmentsCsv()
  if (reportKey === 'closure') return buildClosureCsv(period)
  throw new Error(`Reporte no soportado: ${reportKey}`)
}

// GET /exports/options
router.get('/options', async (_req, res) => {
  try {
    const periods = periodOptions()
    const persistedHistory = await fetchPersistedExportHistory()
    const history = persistedHistory ?? exportHistory
    return ok(res, {
      stats: {
        today: history.filter((e) => String(e.createdAt).slice(0, 10) === new Date().toISOString().slice(0, 10)).length,
        csv: history.filter((e) => e.format === 'CSV').length,
        pdf: 0,
        xlsx: 0,
      },
      reports: REPORTS.map((r) => ({ ...r, periodOptions: periods })),
      history,
    })
  } catch (err) {
    serverError(res, err)
  }
})

// POST /exports
router.post('/', async (req, res) => {
  try {
    const { reportKey, period = currentPeriodLabel(), format = 'CSV' } = req.body ?? {}
    if (!reportKey) return badRequest(res, 'reportKey es requerido')
    if (String(format).toUpperCase() !== 'CSV') return badRequest(res, 'En esta versión operativa solo se exporta CSV')

    const csv = await buildExport({ reportKey, period })
    const exportId = `exp_${Date.now()}`
    const report = REPORTS.find((r) => r.key === reportKey)
    const entry = {
      id: exportId,
      exportId,
      reportKey,
      report: report?.label ?? reportKey,
      period,
      format: 'CSV',
      createdAt: new Date().toISOString(),
      date: new Date().toISOString(),
      user: 'Admin',
      downloadUrl: `/api/exports/${exportId}/download`,
    }
    exportHistory.unshift(entry)
    exportFiles.set(exportId, { csv, entry })
    const { error: persistErr } = await supabase.from('exportacion').insert({
      id_exportacion: exportId,
      reporte_key: reportKey,
      reporte_label: report?.label ?? reportKey,
      periodo: period,
      formato: 'CSV',
      fecha_creacion: entry.createdAt,
      id_usuario: req.user?.sub ? Number(req.user.sub) : null,
      usuario_nombre: req.user?.name ?? 'Admin',
      download_url: entry.downloadUrl,
    })
    if (persistErr) console.warn('[exports] no se pudo persistir historial:', persistErr.message)

    return res.status(201).json({ data: { exportId, downloadUrl: entry.downloadUrl, history: entry } })
  } catch (err) {
    serverError(res, err)
  }
})

// GET /exports/:id/download
router.get('/:id/download', async (req, res) => {
  try {
    let file = exportFiles.get(req.params.id)
    if (!file) {
      const { data } = await supabase
        .from('exportacion')
        .select('*')
        .eq('id_exportacion', req.params.id)
        .maybeSingle()
      if (data) {
        const entry = mapExportHistoryRow(data)
        const csv = await buildExport({ reportKey: entry.reportKey, period: entry.period })
        file = { csv, entry }
        exportFiles.set(req.params.id, file)
      }
    }
    if (!file) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Export no encontrado' } })

    const safePeriod = String(file.entry.period ?? 'export').replace(/\s+/g, '_')
    res.setHeader('Content-Disposition', `attachment; filename="${file.entry.reportKey}_${safePeriod}.csv"`)
    res.setHeader('Content-Type', 'text/csv; charset=utf-8')
    res.send(`\uFEFF${file.csv}`)
  } catch (err) {
    serverError(res, err)
  }
})

export default router
