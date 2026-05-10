import { Router } from 'express'
import supabase from '../lib/supabase.js'
import { ok, created, notFound, badRequest, serverError } from '../lib/response.js'

const router = Router()

// GET /schedules/overview
router.get('/overview', async (req, res) => {
  try {
    const { tab = 'horarios', search, page = 1, pageSize = 10 } = req.query
    const from = (page - 1) * pageSize
    const to   = from + Number(pageSize) - 1

    const [
      { count: schCount },
      { count: cycleCount },
      { count: asgCount }
    ] = await Promise.all([
      supabase.from('horario').select('*', { count: 'exact', head: true }),
      supabase.from('ciclo_horario').select('*', { count: 'exact', head: true }),
      supabase.from('asignacion_horario').select('*', { count: 'exact', head: true })
    ])

    let schedules = [], cycles = [], assignments = []

    if (tab === 'horarios') {
      let q = supabase.from('horario').select('*, horario_dia(*)', { count: 'exact' })
      if (search) q = q.ilike('nombre', `%${search}%`)
      const { data } = await q.order('id_horario').range(from, to)
      schedules = (data ?? []).map(h => ({
        id:                   h.id_horario,
        name:                 h.nombre,
        type:                 h.tipo,
        entryToleranceMinutes: h.tolerancia_entrada_min,
        exitToleranceMinutes:  h.tolerancia_salida_min,
        breakMinutes:          h.descanso_minimo_min,
        flexMode:              h.modo_flexibilidad,
        targetDailyHours:      h.horas_objetivo_diarias,
        targetWeeklyHours:     h.horas_objetivo_semanales,
        weeklyBreakdown: (h.horario_dia ?? [])
          .filter(d => d.es_laborable)
          .map(d => ({ day: d.dia_semana, start: d.hora_entrada, end: d.hora_salida }))
      }))
    }

    if (tab === 'ciclos') {
      let q = supabase.from('ciclo_horario').select('*, ciclo_horario_detalle(*, horario(nombre))')
      if (search) q = q.ilike('nombre', `%${search}%`)
      const { data } = await q.order('id_ciclo').range(from, to)
      cycles = (data ?? []).map(c => ({
        id:      c.id_ciclo,
        name:    c.nombre,
        days:    c.duracion_dias,
        mapping: (c.ciclo_horario_detalle ?? []).map(d => ({
          day:        d.dia_ciclo,
          scheduleId: d.id_horario,
          label:      d.horario?.nombre ?? 'Libre'
        }))
      }))
    }

    if (tab === 'asignaciones') {
      let q = supabase.from('asignacion_horario').select('*, empleado(nombre, apellido), horario(nombre)', { count: 'exact' })
      if (search) q = q.or(`empleado.nombre.ilike.%${search}%,empleado.apellido.ilike.%${search}%`)
      const { data } = await q.order('id_asignacion').range(from, to)
      assignments = (data ?? []).map(a => ({
        id:            a.id_asignacion,
        legajo:        String(a.legajo).padStart(4, '0'),
        employeeId:    a.legajo,
        employeeName:  a.empleado ? `${a.empleado.nombre} ${a.empleado.apellido}` : null,
        resourceLabel: a.horario?.nombre ?? null,
        fromDate:      a.fecha_desde,
        toDate:        a.fecha_hasta,
        status:        a.fecha_hasta ? 'inactiva' : 'activa'
      }))
    }

    return ok(res, {
      stats: { schedules: schCount ?? 0, cycles: cycleCount ?? 0, assignments: asgCount ?? 0 },
      schedules,
      cycles,
      assignments
    })
  } catch (err) {
    serverError(res, err)
  }
})

// POST /schedules
router.post('/', async (req, res) => {
  try {
    const { nombre, tipo, toleranciaEntradaMin, toleranciaSalidaMin, descansoMinimoMin, umbralHorasExtraMin, modoFlexibilidad, horasObjetivoDiarias, horasObjetivoSemanales, dias = [] } = req.body
    if (!nombre || !tipo) return badRequest(res, 'nombre y tipo son requeridos')

    const { data: horario, error } = await supabase
      .from('horario')
      .insert({ nombre, tipo, tolerancia_entrada_min: toleranciaEntradaMin, tolerancia_salida_min: toleranciaSalidaMin, descanso_minimo_min: descansoMinimoMin, umbral_horas_extra_min: umbralHorasExtraMin, modo_flexibilidad: modoFlexibilidad, horas_objetivo_diarias: horasObjetivoDiarias, horas_objetivo_semanales: horasObjetivoSemanales })
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

// PATCH /schedules/:id
router.patch('/:id', async (req, res) => {
  try {
    const allowed = ['nombre', 'tolerancia_entrada_min', 'tolerancia_salida_min', 'descanso_minimo_min', 'umbral_horas_extra_min', 'modo_flexibilidad', 'horas_objetivo_diarias', 'horas_objetivo_semanales']
    const updates = {}
    for (const key of allowed) if (req.body[key] !== undefined) updates[key] = req.body[key]

    const { error } = await supabase.from('horario').update(updates).eq('id_horario', req.params.id)
    if (error) throw error

    const { data } = await supabase.from('horario').select().eq('id_horario', req.params.id).single()
    return ok(res, data)
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
    const { nombre, duracionDias, detalle = [] } = req.body
    if (!nombre || !duracionDias) return badRequest(res, 'nombre y duracionDias son requeridos')

    const { data: ciclo, error } = await supabase
      .from('ciclo_horario')
      .insert({ nombre, duracion_dias: duracionDias })
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
    const { nombre, duracionDias } = req.body
    const updates = {}
    if (nombre)       updates.nombre        = nombre
    if (duracionDias) updates.duracion_dias = duracionDias

    const { error } = await supabase.from('ciclo_horario').update(updates).eq('id_ciclo', req.params.id)
    if (error) throw error

    const { data } = await supabase.from('ciclo_horario').select().eq('id_ciclo', req.params.id).single()
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
