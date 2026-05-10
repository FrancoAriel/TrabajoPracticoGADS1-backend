import { Router } from 'express'
import supabase from '../lib/supabase.js'
import { ok, created, notFound, badRequest, serverError } from '../lib/response.js'

const router = Router()

function normalizeTipoHorario(val) {
  const t = String(val ?? '').trim().toLowerCase()
  if (t === 'fijo') return 'Fijo'
  if (t === 'flexible') return 'Flexible'
  if (t === 'rotativo') return 'Rotativo'
  return String(val ?? '').trim()
}

function normalizeModoFlex(val) {
  const t = String(val ?? '').trim().toLowerCase()
  if (t === 'diaria') return 'Diaria'
  if (t === 'semanal') return 'Semanal'
  return String(val ?? '').trim()
}

/** Activo | Inactivo (columna estado en BD) */
function normalizeEstadoCatalogo(val) {
  if (val == null || val === '') return 'Activo'
  const s = String(val).trim()
  if (s === 'Activo' || s === 'Inactivo') return s
  const t = s.toLowerCase()
  if (t === 'activo') return 'Activo'
  if (t === 'inactivo') return 'Inactivo'
  return 'Activo'
}

// GET /schedules/overview
router.get('/overview', async (req, res) => {
  try {
    const {
      tab = 'horarios',
      search,
      page = 1,
      pageSize = 10,
      tipo,
      estado,
      assignmentKind,
      assignmentStatus,
    } = req.query
    const estFilter = typeof estado === 'string' ? estado.trim().toLowerCase() : ''
    const pNum = Math.max(1, Number(page) || 1)
    const psNum = Math.min(500, Math.max(1, Number(pageSize) || 10))
    const from = (pNum - 1) * psNum
    const to = from + psNum - 1
    const qsearch = typeof search === 'string' ? search.trim() : ''
    const today = new Date().toISOString().slice(0, 10)

    const [
      { count: schCount },
      { count: cycleCount },
      { count: asgCount }
    ] = await Promise.all([
      supabase.from('horario').select('*', { count: 'exact', head: true }).eq('estado', 'Activo'),
      supabase.from('ciclo_horario').select('*', { count: 'exact', head: true }).eq('estado', 'Activo'),
      supabase.from('asignacion_horario').select('*', { count: 'exact', head: true })
    ])

    const [{ count: empTotal }, ahLeg, ecLeg] = await Promise.all([
      supabase.from('empleado').select('*', { count: 'exact', head: true }),
      supabase.from('asignacion_horario').select('legajo').or(`fecha_hasta.is.null,fecha_hasta.gte.${today}`),
      supabase.from('empleado_ciclo').select('legajo').or(`fecha_fin.is.null,fecha_fin.gte.${today}`)
    ])
    const covered = new Set()
    for (const r of ahLeg.data ?? []) covered.add(String(r.legajo))
    for (const r of ecLeg.data ?? []) covered.add(String(r.legajo))
    const unassigned = Math.max(0, (empTotal ?? 0) - covered.size)

    let schedules = []
    let cycles = []
    let assignments = []
    let totalItems = 0

    if (tab === 'horarios') {
      let q = supabase.from('horario').select('*, horario_dia(*)', { count: 'exact' })
      if (qsearch) q = q.ilike('nombre', `%${qsearch}%`)
      if (tipo) q = q.eq('tipo', normalizeTipoHorario(tipo))
      if (estFilter === 'activo') q = q.eq('estado', 'Activo')
      if (estFilter === 'inactivo') q = q.eq('estado', 'Inactivo')
      const { data, count, error } = await q.order('id_horario').range(from, to)
      if (error) throw error
      totalItems = count ?? 0
      schedules = (data ?? []).map(h => ({
        id:                   h.id_horario,
        name:                 h.nombre,
        type:                 h.tipo,
        estado:               h.estado ?? 'Activo',
        entryToleranceMinutes: h.tolerancia_entrada_min,
        exitToleranceMinutes:  h.tolerancia_salida_min,
        breakMinutes:          h.descanso_minimo_min,
        flexMode:              h.modo_flexibilidad,
        targetDailyHours:      h.horas_objetivo_diarias,
        targetWeeklyHours:     h.horas_objetivo_semanales,
        weeklyBreakdown: (h.horario_dia ?? [])
          .slice()
          .sort((a, b) => a.dia_semana - b.dia_semana)
          .map(d => ({
            day:       d.dia_semana,
            start:     d.hora_entrada,
            end:       d.hora_salida,
            laborable: d.es_laborable,
          }))
      }))
    }

    if (tab === 'ciclos') {
      let q = supabase.from('ciclo_horario').select('*, ciclo_horario_detalle(*, horario(nombre))', { count: 'exact' })
      if (qsearch) q = q.ilike('nombre', `%${qsearch}%`)
      if (estFilter === 'activo') q = q.eq('estado', 'Activo')
      if (estFilter === 'inactivo') q = q.eq('estado', 'Inactivo')
      const { data, count, error } = await q.order('id_ciclo').range(from, to)
      if (error) throw error
      totalItems = count ?? 0
      cycles = (data ?? []).map(c => ({
        id:      c.id_ciclo,
        name:    c.nombre,
        days:    c.duracion_dias,
        estado:  c.estado ?? 'Activo',
        mapping: (c.ciclo_horario_detalle ?? [])
          .slice()
          .sort((a, b) => a.dia_ciclo - b.dia_ciclo)
          .map(d => ({
            day:        d.dia_ciclo,
            scheduleId: d.id_horario,
            label:      d.horario?.nombre ?? 'Libre'
          }))
      }))
    }

    if (tab === 'asignaciones') {
      const [{ data: hRows, error: eh }, { data: cRows, error: ecErr }] = await Promise.all([
        supabase
          .from('asignacion_horario')
          .select('id_asignacion, legajo, fecha_desde, fecha_hasta, empleado(nombre, apellido), horario(id_horario, nombre)')
          .order('id_asignacion', { ascending: false }),
        supabase
          .from('empleado_ciclo')
          .select('id, legajo, fecha_inicio, fecha_fin, empleado(nombre, apellido), ciclo_horario(id_ciclo, nombre)')
          .order('id', { ascending: false })
      ])
      if (eh) throw eh
      if (ecErr) throw ecErr

      const normH = (hRows ?? []).map(a => {
        const legajo = String(a.legajo).padStart(4, '0')
        const hid = a.horario?.id_horario
        const hname = a.horario?.nombre ?? ''
        return {
          sortKey: a.id_asignacion,
          kind: 'horario',
          id: String(a.id_asignacion),
          legajo,
          employeeId: a.legajo,
          employeeName: a.empleado ? `${a.empleado.nombre} ${a.empleado.apellido}` : null,
          resourceLabel: hid != null ? `H-${String(hid).padStart(3, '0')} · ${hname}` : (hname || '—'),
          fromDate: a.fecha_desde,
          toDate: a.fecha_hasta,
          status: !a.fecha_hasta || a.fecha_hasta >= today ? 'activa' : 'vencida'
        }
      })

      const normC = (cRows ?? []).map(a => {
        const legajo = String(a.legajo).padStart(4, '0')
        const cid = a.ciclo_horario?.id_ciclo
        const cname = a.ciclo_horario?.nombre ?? ''
        return {
          sortKey: 1_000_000 + (a.id ?? 0),
          kind: 'ciclo',
          id: `ec-${a.id}`,
          legajo,
          employeeId: a.legajo,
          employeeName: a.empleado ? `${a.empleado.nombre} ${a.empleado.apellido}` : null,
          resourceLabel: cid != null ? `C-${String(cid).padStart(3, '0')} · ${cname}` : (cname || '—'),
          fromDate: a.fecha_inicio,
          toDate: a.fecha_fin,
          status: !a.fecha_fin || a.fecha_fin >= today ? 'activa' : 'vencida'
        }
      })

      let merged = [...normH, ...normC].sort((a, b) => b.sortKey - a.sortKey)

      const ak = typeof assignmentKind === 'string' ? assignmentKind.trim().toLowerCase() : ''
      if (ak === 'horario') merged = merged.filter(x => x.kind === 'horario')
      if (ak === 'ciclo') merged = merged.filter(x => x.kind === 'ciclo')

      const ast = typeof assignmentStatus === 'string' ? assignmentStatus.trim().toLowerCase() : ''
      if (ast === 'activa' || ast === 'vencida') merged = merged.filter(x => x.status === ast)

      if (qsearch) {
        const ql = qsearch.toLowerCase()
        merged = merged.filter(
          x =>
            x.legajo.includes(ql) ||
            (x.employeeName && x.employeeName.toLowerCase().includes(ql)) ||
            (x.resourceLabel && x.resourceLabel.toLowerCase().includes(ql))
        )
      }

      totalItems = merged.length
      assignments = merged.slice(from, to).map(({ sortKey: _sk, ...rest }) => rest)
    }

    const totalPages = Math.max(1, Math.ceil((totalItems || 0) / psNum))

    return ok(
      res,
      {
        stats: {
          schedules: schCount ?? 0,
          cycles: cycleCount ?? 0,
          assignments: asgCount ?? 0,
          unassigned,
        },
        schedules,
        cycles,
        assignments,
      },
      { page: pNum, pageSize: psNum, totalItems, totalPages },
    )
  } catch (err) {
    serverError(res, err)
  }
})

// POST /schedules
router.post('/', async (req, res) => {
  try {
    const { nombre, tipo, toleranciaEntradaMin, toleranciaSalidaMin, descansoMinimoMin, umbralHorasExtraMin, modoFlexibilidad, horasObjetivoDiarias, horasObjetivoSemanales, dias = [], estado: estadoBody } = req.body
    if (!nombre || !tipo) return badRequest(res, 'nombre y tipo son requeridos')

    const tipoNorm = normalizeTipoHorario(tipo)
    const { data: horario, error } = await supabase
      .from('horario')
      .insert({
        nombre,
        tipo: tipoNorm,
        tolerancia_entrada_min: toleranciaEntradaMin,
        tolerancia_salida_min: toleranciaSalidaMin,
        descanso_minimo_min: descansoMinimoMin,
        umbral_horas_extra_min: umbralHorasExtraMin,
        modo_flexibilidad: modoFlexibilidad != null ? normalizeModoFlex(modoFlexibilidad) : modoFlexibilidad,
        horas_objetivo_diarias: horasObjetivoDiarias,
        horas_objetivo_semanales: horasObjetivoSemanales,
        estado: normalizeEstadoCatalogo(estadoBody),
      })
      .select()
      .single()

    if (error) throw error

    if (dias.length > 0) {
      const diaRows = dias.map(d => ({ id_horario: horario.id_horario, dia_semana: d.diaSemana, hora_entrada: d.horaEntrada, hora_salida: d.horaSalida, es_laborable: d.esLaborable ?? true }))
      const { error: diaErr } = await supabase.from('horario_dia').insert(diaRows)
      if (diaErr) throw diaErr
    }

    return created(res, { id: horario.id_horario, nombre: horario.nombre })
  } catch (err) {
    serverError(res, err)
  }
})

function pickHorarioPatch(body) {
  const u = {}
  if (body.nombre !== undefined) u.nombre = body.nombre
  if (body.tipo !== undefined) u.tipo = normalizeTipoHorario(body.tipo)
  const pick = (camel, snake) => {
    if (body[camel] !== undefined) u[snake] = body[camel]
    else if (body[snake] !== undefined) u[snake] = body[snake]
  }
  pick('toleranciaEntradaMin', 'tolerancia_entrada_min')
  pick('toleranciaSalidaMin', 'tolerancia_salida_min')
  pick('descansoMinimoMin', 'descanso_minimo_min')
  pick('umbralHorasExtraMin', 'umbral_horas_extra_min')
  if (body.modoFlexibilidad !== undefined) u.modo_flexibilidad = normalizeModoFlex(body.modoFlexibilidad)
  else if (body.modo_flexibilidad !== undefined) u.modo_flexibilidad = normalizeModoFlex(body.modo_flexibilidad)
  pick('horasObjetivoDiarias', 'horas_objetivo_diarias')
  pick('horasObjetivoSemanales', 'horas_objetivo_semanales')
  if (body.estado !== undefined) u.estado = normalizeEstadoCatalogo(body.estado)
  return u
}

// PATCH /schedules/:id
router.patch('/:id', async (req, res) => {
  try {
    const id = req.params.id
    const updates = pickHorarioPatch(req.body)
    if (Object.keys(updates).length > 0) {
      const { error } = await supabase.from('horario').update(updates).eq('id_horario', id)
      if (error) throw error
    }

    if (Array.isArray(req.body.dias)) {
      const { error: delErr } = await supabase.from('horario_dia').delete().eq('id_horario', id)
      if (delErr) throw delErr
      if (req.body.dias.length > 0) {
        const diaRows = req.body.dias.map(d => ({
          id_horario: Number(id),
          dia_semana: d.diaSemana,
          hora_entrada: d.horaEntrada,
          hora_salida: d.horaSalida,
          es_laborable: d.esLaborable ?? true,
        }))
        const { error: diaErr } = await supabase.from('horario_dia').insert(diaRows)
        if (diaErr) throw diaErr
      }
    }

    const { data: h } = await supabase.from('horario').select('*, horario_dia(*)').eq('id_horario', id).single()
    return ok(res, h)
  } catch (err) {
    serverError(res, err)
  }
})

// DELETE /schedules/:id
router.delete('/:id', async (req, res) => {
  try {
    const { error } = await supabase.from('horario').delete().eq('id_horario', req.params.id)
    if (error) throw error
    return res.status(204).send()
  } catch (err) {
    serverError(res, err)
  }
})

// POST /cycles
router.post('/cycles', async (req, res) => {
  try {
    const { nombre, duracionDias, detalle = [], estado: estadoBody } = req.body
    if (!nombre || !duracionDias) return badRequest(res, 'nombre y duracionDias son requeridos')

    const { data: ciclo, error } = await supabase
      .from('ciclo_horario')
      .insert({ nombre, duracion_dias: duracionDias, estado: normalizeEstadoCatalogo(estadoBody) })
      .select()
      .single()

    if (error) throw error

    if (detalle.length > 0) {
      const rows = detalle.map(d => ({ id_ciclo: ciclo.id_ciclo, dia_ciclo: d.diaCiclo, id_horario: d.idHorario }))
      const { error: detErr } = await supabase.from('ciclo_horario_detalle').insert(rows)
      if (detErr) throw detErr
    }

    return created(res, { id: ciclo.id_ciclo, nombre: ciclo.nombre })
  } catch (err) {
    serverError(res, err)
  }
})

// PATCH /cycles/:id
router.patch('/cycles/:id', async (req, res) => {
  try {
    const cid = req.params.id
    const updates = {}
    if (req.body.nombre !== undefined && req.body.nombre !== '') updates.nombre = req.body.nombre
    const dur =
      req.body.duracionDias !== undefined ? Number(req.body.duracionDias)
        : req.body.duracion_dias !== undefined ? Number(req.body.duracion_dias)
          : undefined
    if (dur !== undefined && !Number.isNaN(dur)) updates.duracion_dias = dur
    if (req.body.estado !== undefined) updates.estado = normalizeEstadoCatalogo(req.body.estado)

    if (Object.keys(updates).length > 0) {
      const { error } = await supabase.from('ciclo_horario').update(updates).eq('id_ciclo', cid)
      if (error) throw error
    }

    if (Array.isArray(req.body.detalle)) {
      const { error: delErr } = await supabase.from('ciclo_horario_detalle').delete().eq('id_ciclo', cid)
      if (delErr) throw delErr
      const rows = req.body.detalle
        .filter(d => d.idHorario != null && d.idHorario !== '')
        .map(d => ({
          id_ciclo: Number(cid),
          dia_ciclo: Number(d.diaCiclo),
          id_horario: Number(d.idHorario),
        }))
      if (rows.length > 0) {
        const { error: insErr } = await supabase.from('ciclo_horario_detalle').insert(rows)
        if (insErr) throw insErr
      }
    }

    const { data } = await supabase.from('ciclo_horario').select().eq('id_ciclo', cid).single()
    return ok(res, data)
  } catch (err) {
    serverError(res, err)
  }
})

// DELETE /cycles/:id
router.delete('/cycles/:id', async (req, res) => {
  try {
    const { error } = await supabase.from('ciclo_horario').delete().eq('id_ciclo', req.params.id)
    if (error) throw error
    return res.status(204).send()
  } catch (err) {
    serverError(res, err)
  }
})

// PATCH /cycle-assignments/:id  (fila empleado_ciclo)
router.patch('/cycle-assignments/:id', async (req, res) => {
  try {
    const rid = Number(req.params.id)
    if (!Number.isFinite(rid)) return badRequest(res, 'id inválido')
    const { fechaInicio, fechaFin } = req.body
    const updates = {}
    if (fechaInicio !== undefined) updates.fecha_inicio = fechaInicio
    if (fechaFin !== undefined) updates.fecha_fin = fechaFin === '' || fechaFin === null ? null : fechaFin
    if (Object.keys(updates).length === 0) return badRequest(res, 'Sin cambios')

    const { error } = await supabase.from('empleado_ciclo').update(updates).eq('id', rid)
    if (error) throw error
    const { data } = await supabase.from('empleado_ciclo').select().eq('id', rid).single()
    return ok(res, data)
  } catch (err) {
    serverError(res, err)
  }
})

// POST /assignments
router.post('/assignments', async (req, res) => {
  try {
    const { legajo, idHorario, fechaDesde, fechaHasta } = req.body
    if (!legajo || !idHorario || !fechaDesde) return badRequest(res, 'legajo, idHorario y fechaDesde son requeridos')

    const { data, error } = await supabase
      .from('asignacion_horario')
      .insert({ legajo, id_horario: idHorario, fecha_desde: fechaDesde, fecha_hasta: fechaHasta })
      .select()
      .single()

    if (error) throw error
    return created(res, data)
  } catch (err) {
    serverError(res, err)
  }
})

// PATCH /assignments/:id
router.patch('/assignments/:id', async (req, res) => {
  try {
    const { fechaHasta } = req.body
    const { error } = await supabase
      .from('asignacion_horario')
      .update({ fecha_hasta: fechaHasta })
      .eq('id_asignacion', req.params.id)

    if (error) throw error
    const { data } = await supabase.from('asignacion_horario').select().eq('id_asignacion', req.params.id).single()
    return ok(res, data)
  } catch (err) {
    serverError(res, err)
  }
})

// DELETE /assignments/:id
router.delete('/assignments/:id', async (req, res) => {
  try {
    const { error } = await supabase.from('asignacion_horario').delete().eq('id_asignacion', req.params.id)
    if (error) throw error
    return res.status(204).send()
  } catch (err) {
    serverError(res, err)
  }
})

export default router
