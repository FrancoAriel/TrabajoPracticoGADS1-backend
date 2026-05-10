import { Router } from 'express'
import supabase from '../lib/supabase.js'
import { ok, serverError } from '../lib/response.js'

const router = Router()

// GET /dashboard
router.get('/', async (_req, res) => {
  try {
    const [
      { count: activeEmployees },
      { count: pendingNews },
      { data: closure }
    ] = await Promise.all([
      supabase.from('empleado').select('*', { count: 'exact', head: true }).eq('estado', 'Activo'),
      supabase.from('novedad').select('*', { count: 'exact', head: true }).eq('estado', 'Pendiente'),
      supabase.from('cierre_mensual').select('periodo, estado').eq('estado', 'Borrador').order('fecha_cierre', { ascending: false }).limit(1).maybeSingle()
    ])

    return ok(res, {
      heroMetrics: [
        { key: 'activeEmployees', label: 'Empleados activos', value: activeEmployees ?? 0 },
        { key: 'pendingNews',     label: 'Novedades pendientes', value: pendingNews ?? 0 }
      ],
      currentClosure: closure
        ? { periodLabel: closure.periodo, status: closure.estado.toUpperCase() }
        : null,
      dailySummary: [],
      alerts: [],
      periodStatus: null,
      recentActivity: [],
      pendingNewsTable: []
    })
  } catch (err) {
    serverError(res, err)
  }
})

export default router
