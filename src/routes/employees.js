import { Router } from 'express'
import supabase from '../lib/supabase.js'
import { ok, created, notFound, badRequest, serverError } from '../lib/response.js'

/** Etiquetas de UI alta/edición ↔ enum origen_fichada en BD */
const FICHADA_UI_A_DB = {
  'Biométrico':    'Biometrico',
  'App móvil':     'Api',
  'PIN / Teclado': 'Pin',
  'QR':            'Qr',
  'Manual':        'Manual',
}
const FICHADA_DB_A_UI = Object.fromEntries(
  Object.entries(FICHADA_UI_A_DB).map(([ui, db]) => [db, ui]),
)

function fichadaUiToDb(label) {
  if (label == null || label === '') return null
  return FICHADA_UI_A_DB[label] ?? null
}

function fichadaDbToUi(value) {
  if (value == null || value === '') return ''
  return FICHADA_DB_A_UI[value] ?? String(value)
}

const router = Router()

// GET /employees
router.get('/', async (req, res) => {
  try {
    const { search, category, jornada, status, page = 1, pageSize = 10 } = req.query
    const from = (page - 1) * pageSize
    const to   = from + Number(pageSize) - 1

    let query = supabase.from('empleado').select('*, asignacion_horario(id_asignacion, id_horario, fecha_desde, fecha_hasta, horario(nombre))', { count: 'exact' })

    if (search)   query = query.or(`nombre.ilike.%${search}%,apellido.ilike.%${search}%,dni.ilike.%${search}%`)
    if (category) query = query.eq('categoria_laboral', category)
    if (jornada)  query = query.eq('tipo_jornada', jornada)
    if (status)   query = query.eq('estado', status)

    query = query.order('legajo').range(from, to)

    const { data, count, error } = await query
    if (error) throw error

    const [{ count: active }, { count: partial }, { count: fullTime }] = await Promise.all([
      supabase.from('empleado').select('*', { count: 'exact', head: true }).eq('estado', 'Activo'),
      supabase.from('empleado').select('*', { count: 'exact', head: true }).eq('tipo_jornada', 'Parcial'),
      supabase.from('empleado').select('*', { count: 'exact', head: true }).eq('tipo_jornada', 'Completa')
    ])

    const items = (data ?? []).map(e => {
      const asig = e.asignacion_horario?.find(a => !a.fecha_hasta) ?? e.asignacion_horario?.[0]
      const jornadaHoras =
        e.tipo_jornada === 'Parcial' && e.horas_jornada_parcial != null
          ? `${String(Number(e.horas_jornada_parcial)).replace(/\.0$/, '')}hs`
          : null
      return {
        id:       e.legajo,
        legajo:   String(e.legajo).padStart(4, '0'),
        name:     `${e.nombre} ${e.apellido}`,
        dni:      e.dni,
        category: e.categoria_laboral ?? null,
        convenio: e.convenio ?? null,
        jornada:  e.tipo_jornada,
        jornadaHoras,
        schedule: asig?.horario?.nombre ?? null,
        status:    e.estado,
        fichada:   fichadaDbToUi(e.modalidad_fichada) || null
      }
    })

    return ok(res,
      { items, stats: { active: active ?? 0, partial: partial ?? 0, jornadaCompleta: fullTime ?? 0, jornadaParcial: partial ?? 0 } },
      { page: Number(page), pageSize: Number(pageSize), totalItems: count ?? 0, totalPages: Math.ceil((count ?? 0) / pageSize) }
    )
  } catch (err) {
    serverError(res, err)
  }
})

// GET /employees/:id
router.get('/:id', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('empleado')
      .select('*, asignacion_horario(*, horario(nombre, tipo)), empleado_ciclo(*, ciclo_horario(nombre))')
      .eq('legajo', req.params.id)
      .single()

    if (error || !data) return notFound(res, 'Empleado no encontrado')

    const asig = data.asignacion_horario?.find(a => !a.fecha_hasta) ?? data.asignacion_horario?.[0]
    const ciclo = data.empleado_ciclo?.find(c => !c.fecha_fin) ?? null

    const { data: punches } = await supabase
      .from('fichada')
      .select('*')
      .eq('legajo', req.params.id)
      .order('fecha_hora', { ascending: false })
      .limit(10)

    const { data: news } = await supabase
      .from('novedad')
      .select('*')
      .eq('legajo', req.params.id)
      .order('fecha_creacion', { ascending: false })
      .limit(5)

    const parcialHorasVal =
      data.horas_jornada_parcial != null ? Number(data.horas_jornada_parcial) : null

    return ok(res, {
      employee: {
        id:       data.legajo,
        legajo:   String(data.legajo).padStart(4, '0'),
        name:     `${data.nombre} ${data.apellido}`,
        dni:      data.dni,
        cuil:     data.cuil,
        status:   data.estado,
        category: data.categoria_laboral,
        convenio: data.convenio,
        jornada:  data.tipo_jornada,
        parcialHoras: parcialHorasVal,
        fechaIngreso: data.fecha_ingreso,
        fechaEgreso:  data.fecha_egreso,
        modalidadFichada: fichadaDbToUi(data.modalidad_fichada) || null,
      },
      scheduleConfig: {
        schedule: asig?.horario?.nombre ?? null,
        cycle:    ciclo?.ciclo_horario?.nombre ?? null,
        jornada:  data.tipo_jornada
      },
      recentPunches: (punches ?? []).map(p => ({
        id:        p.id_fichada,
        timestamp: p.fecha_hora,
        type:      p.tipo,
        origin:    p.origen,
        correction: p.es_correccion
      })),
      recentNews: (news ?? []).map(n => ({
        id:       n.id_novedad,
        type:     n.tipo,
        date:     n.fecha_desde,
        status:   n.estado,
        quantity: n.cantidad,
        unit:     n.unidad,
        note:     n.observacion
      }))
    })
  } catch (err) {
    serverError(res, err)
  }
})

// POST /employees
router.post('/', async (req, res) => {
  try {
    const { nombre, apellido, dni, cuil, fechaIngreso, categoria, convenio, jornada, parcialHoras, fichada, estado = 'Activo' } = req.body
    if (!nombre || !apellido || !dni || !cuil || !fechaIngreso || !jornada)
      return badRequest(res, 'Faltan campos requeridos: nombre, apellido, dni, cuil, fechaIngreso, jornada')

    if (jornada === 'Parcial') {
      if (parcialHoras === undefined || parcialHoras === '' || parcialHoras === null || Number.isNaN(Number(parcialHoras)))
        return badRequest(res, 'Indicá las horas diarias para jornada parcial.')
    }

    const horas_jornada_parcial = jornada === 'Parcial' ? Number(parcialHoras) : null

    let modalidad_fichada = fichadaUiToDb(fichada)
    if (!modalidad_fichada && fichada) return badRequest(res, 'Modalidad de fichada no válida.')
    modalidad_fichada ??= 'Biometrico'

    const { data, error } = await supabase
      .from('empleado')
      .insert({
        nombre,
        apellido,
        dni,
        cuil,
        fecha_ingreso: fechaIngreso,
        categoria_laboral: categoria || null,
        convenio: convenio || null,
        tipo_jornada: jornada,
        estado,
        horas_jornada_parcial,
        modalidad_fichada,
      })
      .select('legajo')
      .single()

    if (error) throw error
    return created(res, { id: data.legajo, legajo: String(data.legajo).padStart(4, '0') })
  } catch (err) {
    serverError(res, err)
  }
})

// PATCH /employees/:id
router.patch('/:id', async (req, res) => {
  try {
    const allowed = ['nombre', 'apellido', 'dni', 'cuil', 'fecha_ingreso', 'fecha_egreso', 'categoria_laboral', 'convenio', 'tipo_jornada', 'estado', 'horas_jornada_parcial', 'modalidad_fichada']
    const updates = {}
    for (const key of allowed) {
      if (req.body[key] !== undefined) updates[key] = req.body[key]
    }
    // También aceptar camelCase del frontend
    if (req.body.fechaIngreso !== undefined) updates.fecha_ingreso     = req.body.fechaIngreso || null
    if (req.body.fechaEgreso  !== undefined) updates.fecha_egreso      = req.body.fechaEgreso  || null
    if (req.body.categoria    !== undefined) updates.categoria_laboral = req.body.categoria    || null
    if (req.body.jornada      !== undefined) updates.tipo_jornada      = req.body.jornada      || null
    // convenio vacío → NULL
    if ('convenio' in updates) updates.convenio = updates.convenio || null

    if (req.body.parcialHoras !== undefined) {
      const v = req.body.parcialHoras
      updates.horas_jornada_parcial =
        v === '' || v === null ? null : Number(v)
    }
    if (updates.tipo_jornada === 'Completa') updates.horas_jornada_parcial = null

    if (req.body.fichada !== undefined) {
      const m = fichadaUiToDb(req.body.fichada)
      updates.modalidad_fichada = req.body.fichada === '' || req.body.fichada == null
        ? null
        : m
      if (req.body.fichada !== '' && req.body.fichada != null && !m)
        return badRequest(res, 'Modalidad de fichada no válida.')
    }

    const { error } = await supabase.from('empleado').update(updates).eq('legajo', req.params.id)
    if (error) throw error

    const { data } = await supabase.from('empleado').select().eq('legajo', req.params.id).single()
    return ok(res, data)
  } catch (err) {
    serverError(res, err)
  }
})

// DELETE /employees/:id
router.delete('/:id', async (req, res) => {
  try {
    const { error } = await supabase.from('empleado').delete().eq('legajo', req.params.id)
    if (error) throw error
    return res.status(204).send()
  } catch (err) {
    serverError(res, err)
  }
})

// POST /employees/:id/assignments
router.post('/:id/assignments', async (req, res) => {
  try {
    const { type, targetId, fechaDesde } = req.body
    if (!targetId || !fechaDesde)
      return badRequest(res, 'targetId y fechaDesde son requeridos')

    if (type === 'ciclo') {
      const { data, error } = await supabase
        .from('empleado_ciclo')
        .insert({ legajo: req.params.id, id_ciclo: targetId, fecha_inicio: fechaDesde })
        .select()
        .single()
      if (error) throw error
      return created(res, data)
    }

    const { data, error } = await supabase
      .from('asignacion_horario')
      .insert({ legajo: req.params.id, id_horario: targetId, fecha_desde: fechaDesde })
      .select()
      .single()
    if (error) throw error
    return created(res, data)
  } catch (err) {
    serverError(res, err)
  }
})

// POST /employees/:id/news
router.post('/:id/news', async (req, res) => {
  try {
    const { tipo, fechaDesde, fechaHasta, cantidad, unidad, observacion, idUsuarioCreacion } = req.body
    if (!tipo || !fechaDesde || !unidad)
      return badRequest(res, 'tipo, fechaDesde y unidad son requeridos')

    const { data, error } = await supabase
      .from('novedad')
      .insert({
        legajo: req.params.id, tipo, fecha_desde: fechaDesde, fecha_hasta: fechaHasta,
        cantidad, unidad, estado: 'Pendiente', origen: 'Manual',
        observacion, fecha_creacion: new Date().toISOString(), id_usuario_creacion: idUsuarioCreacion
      })
      .select()
      .single()

    if (error) throw error
    return created(res, data)
  } catch (err) {
    serverError(res, err)
  }
})

// POST /employees/:id/manual-punches
router.post('/:id/manual-punches', async (req, res) => {
  try {
    const { fechaHora, tipo, idUsuarioRegistro } = req.body
    if (!fechaHora || !tipo)
      return badRequest(res, 'fechaHora y tipo son requeridos')

    const { data, error } = await supabase
      .from('fichada')
      .insert({ legajo: req.params.id, fecha_hora: fechaHora, tipo, origen: 'Manual', es_correccion: false, id_usuario_registro: idUsuarioRegistro })
      .select()
      .single()

    if (error) throw error
    return created(res, data)
  } catch (err) {
    serverError(res, err)
  }
})

export default router
