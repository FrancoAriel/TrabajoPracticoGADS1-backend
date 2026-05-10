import { Router } from 'express'
import supabase from '../lib/supabase.js'
import { ok, created, notFound, badRequest, serverError } from '../lib/response.js'

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

    const [{ count: active }, { count: partial }] = await Promise.all([
      supabase.from('empleado').select('*', { count: 'exact', head: true }).eq('estado', 'activo'),
      supabase.from('empleado').select('*', { count: 'exact', head: true }).eq('tipo_jornada', 'parcial')
    ])

    const items = (data ?? []).map(e => {
      const asig = e.asignacion_horario?.find(a => !a.fecha_hasta) ?? e.asignacion_horario?.[0]
      return {
        id:       e.legajo,
        legajo:   String(e.legajo).padStart(4, '0'),
        name:     `${e.nombre} ${e.apellido}`,
        category: e.categoria_laboral ?? null,
        convenio: e.convenio ?? null,
        jornada:  e.tipo_jornada,
        schedule: asig?.horario?.nombre ?? null,
        status:   e.estado
      }
    })

    return ok(res,
      { items, stats: { active: active ?? 0, partial: partial ?? 0 } },
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
        fechaIngreso: data.fecha_ingreso,
        fechaEgreso:  data.fecha_egreso
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
    const { nombre, apellido, dni, cuil, fechaIngreso, categoria, convenio, jornada, estado = 'activo' } = req.body
    if (!nombre || !apellido || !dni || !cuil || !fechaIngreso || !jornada)
      return badRequest(res, 'Faltan campos requeridos: nombre, apellido, dni, cuil, fechaIngreso, jornada')

    const { data, error } = await supabase
      .from('empleado')
      .insert({ nombre, apellido, dni, cuil, fecha_ingreso: fechaIngreso, categoria_laboral: categoria, convenio, tipo_jornada: jornada, estado })
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
    const allowed = ['nombre', 'apellido', 'dni', 'cuil', 'fecha_ingreso', 'fecha_egreso', 'categoria_laboral', 'convenio', 'tipo_jornada', 'estado']
    const updates = {}
    for (const key of allowed) {
      if (req.body[key] !== undefined) updates[key] = req.body[key]
    }
    // También aceptar camelCase del frontend
    if (req.body.fechaIngreso)   updates.fecha_ingreso    = req.body.fechaIngreso
    if (req.body.fechaEgreso)    updates.fecha_egreso     = req.body.fechaEgreso
    if (req.body.categoria)      updates.categoria_laboral = req.body.categoria
    if (req.body.jornada)        updates.tipo_jornada     = req.body.jornada

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
        cantidad, unidad, estado: 'pendiente', origen: 'manual',
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
      .insert({ legajo: req.params.id, fecha_hora: fechaHora, tipo, origen: 'manual', es_correccion: false, id_usuario_registro: idUsuarioRegistro })
      .select()
      .single()

    if (error) throw error
    return created(res, data)
  } catch (err) {
    serverError(res, err)
  }
})

export default router
