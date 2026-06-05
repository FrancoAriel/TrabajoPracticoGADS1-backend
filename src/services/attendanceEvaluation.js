/**
 * Motor de reglas — Labor Pulse (V4).
 *
 * Reglas implementadas:
 *  1. Tardanza         (Fijo / Rotativo, lee tolerancia_entrada_min)
 *  2. Ausencia         (día laborable sin fichada de entrada)
 *  3. Salida anticipada (Fijo / Rotativo, lee tolerancia_salida_min)
 *  4. Horas extra      (lee umbral_horas_extra_min; 50% día hábil / 100% domingo o feriado)
 *  5. Doble fichada    (dos fichadas del mismo tipo dentro de la ventana global)
 *
 * Cada llamada a `evaluateEmployeeDay` retorna un array de resultados (uno por regla
 * que se intentó aplicar). Esto permite que un mismo día genere varias novedades
 * (ej: tardanza + horas extra).
 *
 * Las novedades automáticas persisten en `novedad` con origen='Automatica' y
 * estado='Pendiente'. El motor evita duplicar por (legajo, tipo, fecha, origen).
 */

import { isHoliday } from './holidays.js'
import { DOUBLE_PUNCH_WINDOW_MIN } from '../lib/constants.js'

/* ─────────────────────────────────────────────────────────
 *  Utilidades de fecha / hora
 * ───────────────────────────────────────────────────────── */

/** ISO-8601: Lunes=1 … Domingo=7 (alineado con horario_dia.dia_semana). */
export function isoWeekdayFromYmd(ymd) {
  const [y, m, d] = String(ymd).split('-').map(Number)
  if (!y || !m || !d) return null
  const dt = new Date(y, m - 1, d)
  const js = dt.getDay()
  return js === 0 ? 7 : js
}

export function calendarDaysBetweenYmd(fromYmd, toYmd) {
  const a = new Date(`${fromYmd}T12:00:00`)
  const b = new Date(`${toYmd}T12:00:00`)
  return Math.round((b - a) / 86400000)
}

/** Itera fechas YYYY-MM-DD inclusive entre dos extremos. */
export function* iterateDateRange(desdeYmd, hastaYmd) {
  const start = new Date(`${desdeYmd}T12:00:00`)
  const end = new Date(`${hastaYmd}T12:00:00`)
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    const y = d.getFullYear()
    const m = String(d.getMonth() + 1).padStart(2, '0')
    const day = String(d.getDate()).padStart(2, '0')
    yield `${y}-${m}-${day}`
  }
}

function timeStrToMinutes(t) {
  if (t == null) return null
  const s = String(t).slice(0, 8)
  const parts = s.split(':')
  const h = Number(parts[0])
  const m = Number(parts[1] ?? 0)
  if (!Number.isFinite(h) || !Number.isFinite(m)) return null
  return h * 60 + m
}

function minutesFromFichadaTimestamp(iso) {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  return d.getHours() * 60 + d.getMinutes()
}

function fmtHm(minutes) {
  const h = Math.floor(minutes / 60)
  const m = ((minutes % 60) + 60) % 60
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

/* ─────────────────────────────────────────────────────────
 *  Resolución de horario vigente
 * ───────────────────────────────────────────────────────── */

export async function resolveHorarioForDate(supabase, legajo, fecha) {
  const { data: asgRows, error: e1 } = await supabase
    .from('asignacion_horario')
    .select('id_horario, fecha_desde, fecha_hasta')
    .eq('legajo', legajo)
    .lte('fecha_desde', fecha)

  if (e1) throw e1

  const asgValid = (asgRows ?? [])
    .filter((r) => !r.fecha_hasta || String(r.fecha_hasta) >= fecha)
    .sort((a, b) => String(b.fecha_desde).localeCompare(String(a.fecha_desde)))

  if (asgValid.length) {
    return { idHorario: asgValid[0].id_horario, source: 'asignacion' }
  }

  const { data: cicloRows, error: e2 } = await supabase
    .from('empleado_ciclo')
    .select('id_ciclo, fecha_inicio, fecha_fin, ciclo_horario(duracion_dias)')
    .eq('legajo', legajo)
    .lte('fecha_inicio', fecha)

  if (e2) throw e2

  const cicloValid = (cicloRows ?? [])
    .filter((r) => !r.fecha_fin || String(r.fecha_fin) >= fecha)
    .sort((a, b) => String(b.fecha_inicio).localeCompare(String(a.fecha_inicio)))

  const ec = cicloValid[0]
  if (!ec) return null

  const dur = ec.ciclo_horario?.duracion_dias
  if (!dur || dur < 1) return null

  const diff = calendarDaysBetweenYmd(String(ec.fecha_inicio), fecha)
  if (diff < 0) return null

  const diaCiclo = (diff % dur) + 1

  const { data: det, error: e3 } = await supabase
    .from('ciclo_horario_detalle')
    .select('id_horario')
    .eq('id_ciclo', ec.id_ciclo)
    .eq('dia_ciclo', diaCiclo)
    .maybeSingle()

  if (e3) throw e3
  if (!det?.id_horario) return null

  return { idHorario: det.id_horario, source: 'ciclo', diaCiclo }
}

async function fetchHorarioMeta(supabase, idHorario) {
  const { data, error } = await supabase
    .from('horario')
    .select(
      'id_horario, nombre, tipo, tolerancia_entrada_min, tolerancia_salida_min, umbral_horas_extra_min',
    )
    .eq('id_horario', idHorario)
    .single()
  if (error) throw error
  return data
}

async function fetchHorarioDia(supabase, idHorario, diaSemana) {
  const { data, error } = await supabase
    .from('horario_dia')
    .select('hora_entrada, hora_salida, es_laborable')
    .eq('id_horario', idHorario)
    .eq('dia_semana', diaSemana)
    .maybeSingle()
  if (error) throw error
  return data
}

/* ─────────────────────────────────────────────────────────
 *  Lecturas de fichadas
 * ───────────────────────────────────────────────────────── */

async function firstEntradaOfDay(supabase, legajo, fecha) {
  const { data, error } = await supabase
    .from('fichada')
    .select('id_fichada, fecha_hora')
    .eq('legajo', legajo)
    .eq('tipo', 'Entrada')
    .eq('es_correccion', false)
    .gte('fecha_hora', `${fecha}T00:00:00`)
    .lte('fecha_hora', `${fecha}T23:59:59.999`)
    .order('fecha_hora', { ascending: true })
    .limit(1)
  if (error) throw error
  return (data ?? [])[0] ?? null
}

async function lastSalidaOfDay(supabase, legajo, fecha) {
  const { data, error } = await supabase
    .from('fichada')
    .select('id_fichada, fecha_hora')
    .eq('legajo', legajo)
    .eq('tipo', 'Salida')
    .eq('es_correccion', false)
    .gte('fecha_hora', `${fecha}T00:00:00`)
    .lte('fecha_hora', `${fecha}T23:59:59.999`)
    .order('fecha_hora', { ascending: false })
    .limit(1)
  if (error) throw error
  return (data ?? [])[0] ?? null
}

async function allFichadasOfDay(supabase, legajo, fecha) {
  const { data, error } = await supabase
    .from('fichada')
    .select('id_fichada, fecha_hora, tipo')
    .eq('legajo', legajo)
    .eq('es_correccion', false)
    .gte('fecha_hora', `${fecha}T00:00:00`)
    .lte('fecha_hora', `${fecha}T23:59:59.999`)
    .order('fecha_hora', { ascending: true })
  if (error) throw error
  return data ?? []
}

/* ─────────────────────────────────────────────────────────
 *  Anti-duplicación de novedades automáticas
 * ───────────────────────────────────────────────────────── */

async function hasAutomaticNovedad(supabase, legajo, tipo, fecha) {
  const { data, error } = await supabase
    .from('novedad')
    .select('id_novedad')
    .eq('legajo', legajo)
    .eq('tipo', tipo)
    .eq('fecha_desde', fecha)
    .eq('origen', 'Automatica')
    .maybeSingle()
  if (error) throw error
  return !!data
}

async function hasAusenciaCoveringDate(supabase, legajo, fecha) {
  const { data, error } = await supabase
    .from('novedad')
    .select('fecha_desde, fecha_hasta')
    .eq('legajo', legajo)
    .eq('tipo', 'Ausencia')
  if (error) throw error
  return (data ?? []).some((n) => {
    const desde = String(n.fecha_desde)
    if (fecha < desde) return false
    if (n.fecha_hasta == null) return true
    return fecha <= String(n.fecha_hasta)
  })
}

async function hasNovedadOnDate(supabase, legajo, tipo, fecha) {
  const { data, error } = await supabase
    .from('novedad')
    .select('id_novedad')
    .eq('legajo', legajo)
    .eq('tipo', tipo)
    .eq('fecha_desde', fecha)
    .limit(1)
  if (error) throw error
  return (data ?? []).length > 0
}

/* ─────────────────────────────────────────────────────────
 *  Helpers de inserción
 * ───────────────────────────────────────────────────────── */

function newNovedadRow({ legajo, tipo, fecha, cantidad, unidad, observacion }) {
  return {
    legajo,
    tipo,
    fecha_desde: fecha,
    fecha_hasta: fecha,
    cantidad,
    unidad,
    estado: 'Pendiente',
    origen: 'Automatica',
    observacion,
    fecha_creacion: new Date().toISOString(),
    id_usuario_creacion: null,
  }
}

async function insertNovedad(supabase, row, dryRun) {
  if (dryRun) return
  const { error } = await supabase.from('novedad').insert(row)
  if (error) throw error
}

function result(rule, kind, legajo, details) {
  return { rule, kind, legajo, details }
}

/* ─────────────────────────────────────────────────────────
 *  Evaluación por empleado / día
 * ───────────────────────────────────────────────────────── */

/**
 * Evalúa todas las reglas aplicables a un empleado en una fecha.
 * Retorna un array de resultados (uno por regla evaluada).
 *
 * @returns {Promise<Array<{rule:string, kind:'created'|'ok'|'skipped'|'error', legajo:number, details:object}>>}
 */
export async function evaluateEmployeeDay(supabase, legajo, fecha, { dryRun = false } = {}) {
  const dow = isoWeekdayFromYmd(fecha)
  if (!dow) {
    return [result('meta', 'skipped', legajo, { reason: 'fecha_invalida' })]
  }

  const { data: emp, error: empErr } = await supabase
    .from('empleado')
    .select('legajo, estado')
    .eq('legajo', legajo)
    .maybeSingle()
  if (empErr) throw empErr
  if (!emp || emp.estado !== 'Activo') {
    return [result('meta', 'skipped', legajo, { reason: 'empleado_inactivo' })]
  }

  const resolved = await resolveHorarioForDate(supabase, legajo, fecha)
  if (!resolved) {
    return [result('meta', 'skipped', legajo, { reason: 'sin_asignacion_horario' })]
  }

  const horario = await fetchHorarioMeta(supabase, resolved.idHorario)
  const hd = await fetchHorarioDia(supabase, resolved.idHorario, dow)
  const flexible = horario.tipo === 'Flexible'

  const evaluations = []

  // Regla 5 — Doble fichada: aplica siempre que haya fichadas, independientemente del tipo de día.
  evaluations.push(...(await evaluateDobleFichada(supabase, legajo, fecha, dryRun)))

  if (!hd?.es_laborable) {
    evaluations.push(
      result('meta', 'skipped', legajo, { reason: 'dia_no_laborable', horario: horario.nombre }),
    )
    return evaluations
  }

  const entrada = await firstEntradaOfDay(supabase, legajo, fecha)
  const salida = await lastSalidaOfDay(supabase, legajo, fecha)

  // Regla 2 — Ausencia
  if (!entrada) {
    evaluations.push(await evaluateAusencia(supabase, legajo, fecha, horario, dryRun))
    // Sin entrada no tiene sentido evaluar tardanza/salida/horas extra del día.
    return evaluations
  }

  // Regla 1 — Tardanza (solo Fijo / Rotativo)
  if (!flexible) {
    evaluations.push(
      await evaluateTardanza(supabase, legajo, fecha, horario, hd, entrada, dryRun),
    )
  } else {
    evaluations.push(
      result('tardanza', 'skipped', legajo, {
        reason: 'horario_flexible_sin_control_de_hora_fija',
      }),
    )
  }

  // Regla 3 — Salida anticipada (solo Fijo / Rotativo)
  if (!flexible) {
    evaluations.push(
      await evaluateSalidaAnticipada(supabase, legajo, fecha, horario, hd, salida, dryRun),
    )
  } else {
    evaluations.push(
      result('salida_anticipada', 'skipped', legajo, {
        reason: 'horario_flexible_sin_control_de_hora_fija',
      }),
    )
  }

  // Regla 4 — Horas extra (Fijo / Rotativo)
  if (!flexible) {
    evaluations.push(
      await evaluateHorasExtra(supabase, legajo, fecha, horario, hd, salida, dryRun),
    )
  } else {
    evaluations.push(
      result('horas_extra', 'skipped', legajo, {
        reason: 'horario_flexible_pendiente_v_futura',
      }),
    )
  }

  return evaluations
}

/* ─────────────────────────────────────────────────────────
 *  Reglas individuales
 * ───────────────────────────────────────────────────────── */

async function evaluateAusencia(supabase, legajo, fecha, horario, dryRun) {
  if (await hasAutomaticNovedad(supabase, legajo, 'Ausencia', fecha)) {
    return result('ausencia', 'skipped', legajo, { reason: 'ausencia_automatica_ya_registrada' })
  }
  if (await hasAusenciaCoveringDate(supabase, legajo, fecha)) {
    return result('ausencia', 'skipped', legajo, { reason: 'ausencia_manual_u_otra_ya_cubre' })
  }
  const row = newNovedadRow({
    legajo,
    tipo: 'Ausencia',
    fecha,
    cantidad: 1,
    unidad: 'Dias',
    observacion: `Ausencia automática: sin fichada de entrada (${fecha}).`,
  })
  await insertNovedad(supabase, row, dryRun)
  return result('ausencia', 'created', legajo, {
    tipo: 'Ausencia',
    dryRun,
    horario: horario.nombre,
  })
}

async function evaluateTardanza(supabase, legajo, fecha, horario, hd, entrada, dryRun) {
  const tol = Number(horario.tolerancia_entrada_min ?? 0) || 0
  const expectedMin = timeStrToMinutes(hd.hora_entrada)
  if (expectedMin == null) {
    return result('tardanza', 'skipped', legajo, { reason: 'sin_hora_entrada_configurada' })
  }
  const actualMin = minutesFromFichadaTimestamp(entrada.fecha_hora)
  if (actualMin == null) {
    return result('tardanza', 'skipped', legajo, { reason: 'fichada_sin_hora' })
  }
  const limite = expectedMin + tol
  if (actualMin <= limite) {
    return result('tardanza', 'ok', legajo, { reason: 'a_tiempo', entrada: entrada.fecha_hora })
  }
  if (await hasNovedadOnDate(supabase, legajo, 'Tardanza', fecha)) {
    return result('tardanza', 'skipped', legajo, { reason: 'tardanza_ya_registrada' })
  }
  const minutosTarde = actualMin - limite
  const row = newNovedadRow({
    legajo,
    tipo: 'Tardanza',
    fecha,
    cantidad: minutosTarde,
    unidad: 'Minutos',
    observacion:
      `Tardanza automática: entrada a las ${fmtHm(actualMin)}, ` +
      `esperada hasta ${fmtHm(limite)} (${fmtHm(expectedMin)} + ${tol} min tolerancia).`,
  })
  await insertNovedad(supabase, row, dryRun)
  return result('tardanza', 'created', legajo, {
    tipo: 'Tardanza',
    minutos: minutosTarde,
    dryRun,
    horario: horario.nombre,
  })
}

async function evaluateSalidaAnticipada(supabase, legajo, fecha, horario, hd, salida, dryRun) {
  if (!salida) {
    return result('salida_anticipada', 'skipped', legajo, { reason: 'sin_fichada_de_salida' })
  }
  const tol = Number(horario.tolerancia_salida_min ?? 0) || 0
  const expectedMin = timeStrToMinutes(hd.hora_salida)
  if (expectedMin == null) {
    return result('salida_anticipada', 'skipped', legajo, { reason: 'sin_hora_salida_configurada' })
  }
  const actualMin = minutesFromFichadaTimestamp(salida.fecha_hora)
  if (actualMin == null) {
    return result('salida_anticipada', 'skipped', legajo, { reason: 'fichada_sin_hora' })
  }
  const limite = expectedMin - tol
  if (actualMin >= limite) {
    return result('salida_anticipada', 'ok', legajo, {
      reason: 'salida_en_horario',
      salida: salida.fecha_hora,
    })
  }
  if (await hasNovedadOnDate(supabase, legajo, 'Salida_Anticipada', fecha)) {
    return result('salida_anticipada', 'skipped', legajo, {
      reason: 'salida_anticipada_ya_registrada',
    })
  }
  const minutosAnticipados = limite - actualMin
  const row = newNovedadRow({
    legajo,
    tipo: 'Salida_Anticipada',
    fecha,
    cantidad: minutosAnticipados,
    unidad: 'Minutos',
    observacion:
      `Salida anticipada automática: salida a las ${fmtHm(actualMin)}, ` +
      `mínima permitida ${fmtHm(limite)} (${fmtHm(expectedMin)} − ${tol} min tolerancia).`,
  })
  await insertNovedad(supabase, row, dryRun)
  return result('salida_anticipada', 'created', legajo, {
    tipo: 'Salida_Anticipada',
    minutos: minutosAnticipados,
    dryRun,
    horario: horario.nombre,
  })
}

async function evaluateHorasExtra(supabase, legajo, fecha, horario, hd, salida, dryRun) {
  if (!salida) {
    return result('horas_extra', 'skipped', legajo, { reason: 'sin_fichada_de_salida' })
  }
  const umbral = Number(horario.umbral_horas_extra_min ?? 0) || 0
  const expectedMin = timeStrToMinutes(hd.hora_salida)
  if (expectedMin == null) {
    return result('horas_extra', 'skipped', legajo, { reason: 'sin_hora_salida_configurada' })
  }
  const actualMin = minutesFromFichadaTimestamp(salida.fecha_hora)
  if (actualMin == null) {
    return result('horas_extra', 'skipped', legajo, { reason: 'fichada_sin_hora' })
  }
  const exceso = actualMin - expectedMin
  if (exceso <= umbral) {
    return result('horas_extra', 'ok', legajo, {
      reason: 'sin_exceso_significativo',
      excesoMin: Math.max(0, exceso),
      umbralMin: umbral,
    })
  }

  // Clasificación 50% / 100%: domingo (dow=7) o feriado nacional → 100%, resto → 50%
  const dow = isoWeekdayFromYmd(fecha)
  const esDomingo = dow === 7
  const esFeriado = await isHoliday(fecha)
  const tipoNovedad = esDomingo || esFeriado ? 'Horas_Extra_100' : 'Horas_Extra_50'

  if (await hasNovedadOnDate(supabase, legajo, tipoNovedad, fecha)) {
    return result('horas_extra', 'skipped', legajo, { reason: 'horas_extra_ya_registradas' })
  }

  const motivo = esDomingo
    ? 'domingo'
    : esFeriado
      ? 'feriado'
      : 'dia_habil'

  const row = newNovedadRow({
    legajo,
    tipo: tipoNovedad,
    fecha,
    cantidad: exceso,
    unidad: 'Minutos',
    observacion:
      `Horas extra automáticas (${motivo}): salida a las ${fmtHm(actualMin)} vs ` +
      `esperada ${fmtHm(expectedMin)} (umbral ${umbral} min). Exceso ${exceso} min.`,
  })
  await insertNovedad(supabase, row, dryRun)
  return result('horas_extra', 'created', legajo, {
    tipo: tipoNovedad,
    minutos: exceso,
    motivo,
    dryRun,
    horario: horario.nombre,
  })
}

async function evaluateDobleFichada(supabase, legajo, fecha, dryRun) {
  const fichadas = await allFichadasOfDay(supabase, legajo, fecha)
  if (fichadas.length < 2) {
    return [result('doble_fichada', 'ok', legajo, { reason: 'menos_de_dos_fichadas' })]
  }

  const ventanaMs = DOUBLE_PUNCH_WINDOW_MIN * 60 * 1000
  const dobles = []

  // Comparar pares consecutivos del mismo tipo dentro de la ventana
  const porTipo = { Entrada: [], Salida: [] }
  for (const f of fichadas) {
    if (porTipo[f.tipo]) porTipo[f.tipo].push(f)
  }

  for (const tipo of ['Entrada', 'Salida']) {
    const arr = porTipo[tipo]
    for (let i = 1; i < arr.length; i++) {
      const prev = new Date(arr[i - 1].fecha_hora).getTime()
      const curr = new Date(arr[i].fecha_hora).getTime()
      if (Number.isFinite(prev) && Number.isFinite(curr) && curr - prev <= ventanaMs) {
        dobles.push({ tipo, primera: arr[i - 1].fecha_hora, segunda: arr[i].fecha_hora })
      }
    }
  }

  if (!dobles.length) {
    return [result('doble_fichada', 'ok', legajo, { reason: 'sin_duplicidad_en_ventana' })]
  }

  if (await hasNovedadOnDate(supabase, legajo, 'Doble_Fichada', fecha)) {
    return [
      result('doble_fichada', 'skipped', legajo, {
        reason: 'doble_fichada_ya_registrada',
        detectadas: dobles.length,
      }),
    ]
  }

  const resumen = dobles
    .map((d) => `${d.tipo} ${String(d.primera).slice(11, 16)} ↔ ${String(d.segunda).slice(11, 16)}`)
    .join('; ')

  const row = newNovedadRow({
    legajo,
    tipo: 'Doble_Fichada',
    fecha,
    cantidad: dobles.length,
    unidad: 'Dias',
    observacion:
      `Doble fichada detectada (ventana ${DOUBLE_PUNCH_WINDOW_MIN} min). ` +
      `Día marcado para revisión. Pares: ${resumen}.`,
  })
  await insertNovedad(supabase, row, dryRun)
  return [
    result('doble_fichada', 'created', legajo, {
      tipo: 'Doble_Fichada',
      pares: dobles.length,
      dryRun,
    }),
  ]
}

/* ─────────────────────────────────────────────────────────
 *  Evaluación masiva
 * ───────────────────────────────────────────────────────── */

/**
 * Evalúa todos los empleados activos para una fecha.
 * Retorna un array plano de resultados (cada empleado puede aportar varios).
 */
export async function evaluateAllEmployeesForDate(supabase, fecha, options = {}) {
  const { data: empleados, error } = await supabase
    .from('empleado')
    .select('legajo')
    .eq('estado', 'Activo')
  if (error) throw error

  const results = []
  for (const e of empleados ?? []) {
    try {
      const arr = await evaluateEmployeeDay(supabase, e.legajo, fecha, options)
      results.push(...arr)
    } catch (err) {
      results.push(result('meta', 'error', e.legajo, { message: err.message }))
    }
  }
  return results
}

/**
 * Reproceso por rango: borra novedades automáticas previas en el rango
 * (para los legajos indicados o todos los activos) y vuelve a evaluar día por día.
 *
 * @param {object} supabase
 * @param {string} desde YYYY-MM-DD inclusive
 * @param {string} hasta YYYY-MM-DD inclusive
 * @param {object} options
 * @param {number[]=} options.legajos
 * @param {boolean=} options.dryRun
 */
export async function reprocessRange(supabase, desde, hasta, { legajos = null, dryRun = false } = {}) {
  const lista =
    Array.isArray(legajos) && legajos.length
      ? legajos.map((x) => Number(x)).filter((n) => Number.isFinite(n) && n > 0)
      : null

  const tiposAutomaticos = [
    'Tardanza',
    'Ausencia',
    'Salida_Anticipada',
    'Horas_Extra_50',
    'Horas_Extra_100',
    'Doble_Fichada',
  ]

  // 1. Limpiar novedades automáticas previas dentro del rango.
  if (!dryRun) {
    let q = supabase
      .from('novedad')
      .delete()
      .eq('origen', 'Automatica')
      .in('tipo', tiposAutomaticos)
      .gte('fecha_desde', desde)
      .lte('fecha_desde', hasta)
    if (lista?.length) q = q.in('legajo', lista)
    const { error } = await q
    if (error) throw error
  }

  // 2. Re-evaluar día por día.
  const results = []
  for (const fecha of iterateDateRange(desde, hasta)) {
    if (lista?.length) {
      for (const legajo of lista) {
        try {
          const arr = await evaluateEmployeeDay(supabase, legajo, fecha, { dryRun })
          for (const r of arr) results.push({ ...r, fecha })
        } catch (err) {
          results.push({
            rule: 'meta',
            kind: 'error',
            legajo,
            fecha,
            details: { message: err.message },
          })
        }
      }
    } else {
      const arr = await evaluateAllEmployeesForDate(supabase, fecha, { dryRun })
      for (const r of arr) results.push({ ...r, fecha })
    }
  }

  return results
}
