import supabase from '../lib/supabase.js'
import { evaluateEmployeeDay } from '../services/attendanceEvaluation.js'

/** Valores enum en BD: Entrada | Salida */
export function normalizeTipoFichada(t) {
  const s = String(t ?? '').trim().toLowerCase()
  if (s === 'entrada') return 'Entrada'
  if (s === 'salida') return 'Salida'
  return String(t ?? '').trim()
}

export function normalizeOrigenFichada(value) {
  const s = String(value ?? '').trim().toLowerCase()
  if (s === 'biometrico' || s === 'biométrico') return 'Biometrico'
  if (s === 'manual') return 'Manual'
  if (s === 'qr') return 'Qr'
  if (s === 'api') return 'Api'
  if (s === 'pin') return 'Pin'
  return String(value ?? '').trim()
}

export async function evaluateAfterPunch(legajo, fechaHora) {
  const fecha = String(fechaHora).slice(0, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) return null
  try {
    return await evaluateEmployeeDay(supabase, legajo, fecha, { dryRun: false })
  } catch (e) {
    console.error('[attendanceEvaluation] post fichada', e)
    return [
      { rule: 'meta', kind: 'error', legajo, details: { message: e?.message ?? String(e) } },
    ]
  }
}

export async function insertPunch({ legajo, fechaHora, tipo, origen, esCorreccion = false, idFichadaOriginal = null, idUsuarioRegistro = null }) {
  const legajoNum = typeof legajo === 'string' ? Number(legajo.replace(/\D/g, '')) : Number(legajo)
  if (!Number.isFinite(legajoNum)) {
    const err = new Error('legajo inválido')
    err.statusCode = 400
    throw err
  }

  const { data, error } = await supabase
    .from('fichada')
    .insert({
      legajo: legajoNum,
      fecha_hora: fechaHora,
      tipo: normalizeTipoFichada(tipo),
      origen: normalizeOrigenFichada(origen),
      es_correccion: esCorreccion,
      id_fichada_original: idFichadaOriginal,
      id_usuario_registro: idUsuarioRegistro,
    })
    .select()
    .single()

  if (error) throw error
  return { data, legajoNum }
}
