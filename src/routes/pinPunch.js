import { Router } from 'express'
import supabase from '../lib/supabase.js'
import { created, badRequest, notFound, serverError } from '../lib/response.js'
import { nowLocalIso, parseLegajo } from '../lib/pinFichada.js'
import { normalizeTipoFichada, insertPunch, evaluateAfterPunch } from './punchesShared.js'

const router = Router()

// POST /api/punches/pin — público (terminal: legajo + entrada/salida)
router.post('/', async (req, res) => {
  try {
    const { legajo, tipo } = req.body
    const legajoNum = parseLegajo(legajo)
    const tipoNorm = normalizeTipoFichada(tipo)

    if (!legajoNum || !tipoNorm)
      return badRequest(res, 'legajo y tipo (Entrada o Salida) son requeridos')

    if (!['Entrada', 'Salida'].includes(tipoNorm))
      return badRequest(res, 'tipo inválido')

    const { data: empleado, error: empErr } = await supabase
      .from('empleado')
      .select('legajo, nombre, apellido, estado')
      .eq('legajo', legajoNum)
      .maybeSingle()

    if (empErr) throw empErr
    if (!empleado) return notFound(res, 'Legajo no encontrado')

    if (String(empleado.estado || '').toLowerCase() !== 'activo')
      return badRequest(res, 'El empleado no está activo')

    const fechaHora = nowLocalIso()
    const { data } = await insertPunch({
      legajo: legajoNum,
      fechaHora,
      tipo: tipoNorm,
      origen: 'Pin',
      idUsuarioRegistro: null,
    })

    const attendanceEvaluation = await evaluateAfterPunch(legajoNum, fechaHora)

    return created(res, {
      fichada: data,
      empleado: {
        legajo: String(legajoNum).padStart(4, '0'),
        nombre: empleado.nombre,
        apellido: empleado.apellido,
      },
      attendanceEvaluation,
    })
  } catch (err) {
    if (err.statusCode === 400) return badRequest(res, err.message)
    serverError(res, err)
  }
})

export default router
