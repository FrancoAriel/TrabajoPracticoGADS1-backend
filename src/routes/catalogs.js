import { Router } from 'express'
import supabase from '../lib/supabase.js'
import { ok, serverError } from '../lib/response.js'

const router = Router()

// GET /catalogs
router.get('/', async (_req, res) => {
  try {
    const { data: horarios } = await supabase
      .from('horario')
      .select('id_horario, nombre, tipo')
      .order('nombre')

    return ok(res, {
      tiposJornada:    ['completa', 'parcial'],
      estadosEmpleado: ['activo', 'inactivo', 'suspendido'],
      tiposHorario:    ['fijo', 'flexible', 'rotativo'],
      tiposFichada:    ['entrada', 'salida'],
      origenesFichada: ['biometrico', 'manual', 'qr', 'api', 'pin'],
      tiposNovedad:    [
        'tardanza', 'ausencia', 'horas_extra_50', 'horas_extra_100',
        'horas_faltantes', 'salida_anticipada', 'licencia', 'suspension',
        'vacaciones', 'permiso_especial', 'justificacion'
      ],
      estadosNovedad:  ['pendiente', 'aprobada', 'rechazada'],
      rolesUsuario:    ['admin', 'empleado', 'contador'],
      formatosExport:  ['CSV', 'PDF', 'XLSX'],
      horarios:        (horarios ?? []).map(h => ({ id: h.id_horario, nombre: h.nombre, tipo: h.tipo }))
    })
  } catch (err) {
    serverError(res, err)
  }
})

export default router
