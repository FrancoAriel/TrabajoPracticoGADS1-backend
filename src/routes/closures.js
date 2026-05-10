import { Router } from 'express'
import supabase from '../lib/supabase.js'
import { ok, created, notFound, badRequest, serverError } from '../lib/response.js'

const router = Router()

// GET /closures/current
router.get('/current', async (_req, res) => {
  try {
    const { data: current } = await supabase
      .from('cierre_mensual')
      .select('*, usuario(nombre)')
      .eq('estado', 'Borrador')
      .order('fecha_cierre', { ascending: false })
      .limit(1)
      .maybeSingle()

    const { data: history } = await supabase
      .from('cierre_mensual')
      .select('id_cierre, periodo, fecha_cierre, estado')
      .eq('estado', 'Cerrado')
      .order('fecha_cierre', { ascending: false })
      .limit(6)

    const [{ count: liquidated }, { count: pending }] = await Promise.all([
      supabase.from('novedad').select('*', { count: 'exact', head: true }).eq('estado', 'Aprobada'),
      supabase.from('novedad').select('*', { count: 'exact', head: true }).eq('estado', 'Pendiente')
    ])

    return ok(res, {
      currentPeriod: current?.periodo ?? null,
      currentClosure: current ? {
        id:          current.id_cierre,
        periodo:     current.periodo,
        fechaCierre: current.fecha_cierre,
        estado:      current.estado,
        usuario:     current.usuario?.nombre
      } : null,
      stats: { liquidated: liquidated ?? 0, pending: pending ?? 0 },
      history: (history ?? []).map(h => ({ id: h.id_cierre, periodo: h.periodo, fechaCierre: h.fecha_cierre, estado: h.estado })),
      employeeBreakdown: [],
      checklist: []
    })
  } catch (err) {
    serverError(res, err)
  }
})

// POST /closures
router.post('/', async (req, res) => {
  try {
    const { periodo, fechaCierre, idUsuario, archivoExportado = '' } = req.body
    if (!periodo || !fechaCierre || !idUsuario)
      return badRequest(res, 'periodo, fechaCierre e idUsuario son requeridos')

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

// POST /closures/:id/run  (ejecuta el cierre → estado cerrado)
router.post('/:id/run', async (req, res) => {
  try {
    const { data: closure, error: fetchErr } = await supabase
      .from('cierre_mensual')
      .select('*')
      .eq('id_cierre', req.params.id)
      .single()

    if (fetchErr || !closure) return notFound(res, 'Cierre no encontrado')
    if (closure.estado === 'Cerrado')
      return badRequest(res, 'El cierre ya está en estado cerrado')

    // Snapshot de novedades aprobadas del período
    const { data: novedades } = await supabase
      .from('novedad')
      .select('*')
      .eq('estado', 'Aprobada')

    if ((novedades ?? []).length > 0) {
      const detalles = novedades.map(n => ({
        id_cierre:     closure.id_cierre,
        id_novedad:    n.id_novedad,
        legajo:        n.legajo,
        tipo_novedad:  n.tipo,
        fecha_desde:   n.fecha_desde,
        fecha_hasta:   n.fecha_hasta,
        cantidad:      n.cantidad,
        unidad:        n.unidad,
        observacion:   n.observacion,
        origen:        n.origen,
        fecha_creacion: n.fecha_creacion
      }))
      await supabase.from('cierre_mensual_detalle').insert(detalles)
    }

    const { error: updateErr } = await supabase
      .from('cierre_mensual')
      .update({ estado: 'Cerrado' })
      .eq('id_cierre', req.params.id)

    if (updateErr) throw updateErr

    return ok(res, { id: req.params.id, estado: 'Cerrado', novedadesIncluidas: (novedades ?? []).length })
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
