/**
 * Evaluación automática de asistencia: tardanza (entrada vs horario + tolerancia)
 * y ausencia (día laborable sin fichada de entrada).
 * Horarios fijos/rotativos (resueltos vía asignación o ciclo). Horario Flexible: sin tardanza fija; ausencia si no hay ninguna entrada ese día.
 */

/** ISO-8601: Lunes=1 … Domingo=7 (alineado con horario_dia.dia_semana en el esquema) */
export function isoWeekdayFromYmd(ymd) {
  const [y, m, d] = String(ymd).split('-').map(Number)
  if (!y || !m || !d) return null
  const dt = new Date(y, m - 1, d)
  const js = dt.getDay() // 0=Dom … 6=Sáb
  return js === 0 ? 7 : js
}

export function calendarDaysBetweenYmd(fromYmd, toYmd) {
  const a = new Date(`${fromYmd}T12:00:00`)
  const b = new Date(`${toYmd}T12:00:00`)
  return Math.round((b - a) / 86400000)
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
  const m = minutes % 60
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

/**
 * Resuelve id_horario vigente para un legajo en una fecha (solo asignación fija o ciclo rotativo).
 */
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
    .select('id_horario, nombre, tipo, tolerancia_entrada_min')
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

/** Evita duplicar: ya hay novedad automática de ese tipo para ese día. */
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

/** Cualquier ausencia (manual o automática) que cubra la fecha calendario. */
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

/** Tardanza ya registrada ese día (cualquier origen). */
async function hasTardanzaOnDate(supabase, legajo, fecha) {
  const { data, error } = await supabase
    .from('novedad')
    .select('id_novedad')
    .eq('legajo', legajo)
    .eq('tipo', 'Tardanza')
    .eq('fecha_desde', fecha)
    .limit(1)
  if (error) throw error
  return (data ?? []).length > 0
}

/**
 * @returns {Promise<{ kind: string, legajo: number, details?: object }>}
 */
export async function evaluateEmployeeDay(supabase, legajo, fecha, { dryRun = false } = {}) {
  const dow = isoWeekdayFromYmd(fecha)
  if (!dow) {
    return { kind: 'skipped', legajo, details: { reason: 'fecha_invalida' } }
  }

  const { data: emp, error: empErr } = await supabase
    .from('empleado')
    .select('legajo, estado')
    .eq('legajo', legajo)
    .maybeSingle()
  if (empErr) throw empErr
  if (!emp || emp.estado !== 'Activo') {
    return { kind: 'skipped', legajo, details: { reason: 'empleado_inactivo' } }
  }

  const resolved = await resolveHorarioForDate(supabase, legajo, fecha)
  if (!resolved) {
    return { kind: 'skipped', legajo, details: { reason: 'sin_asignacion_horario' } }
  }

  const horario = await fetchHorarioMeta(supabase, resolved.idHorario)
  const hd = await fetchHorarioDia(supabase, resolved.idHorario, dow)

  if (!hd?.es_laborable) {
    return { kind: 'skipped', legajo, details: { reason: 'dia_no_laborable' } }
  }

  const tol = Number(horario.tolerancia_entrada_min ?? 0) || 0
  const entrada = await firstEntradaOfDay(supabase, legajo, fecha)
  const flexible = horario.tipo === 'Flexible'

  /* Ausencia: sin entrada en día laborable */
  if (!entrada) {
    const existsAuto = await hasAutomaticNovedad(supabase, legajo, 'Ausencia', fecha)
    if (existsAuto) {
      return { kind: 'skipped', legajo, details: { reason: 'ausencia_automatica_ya_registrada' } }
    }
    const cubierta = await hasAusenciaCoveringDate(supabase, legajo, fecha)
    if (cubierta) {
      return { kind: 'skipped', legajo, details: { reason: 'ausencia_manual_u_otra_ya_cubre' } }
    }
    const row = {
      legajo,
      tipo: 'Ausencia',
      fecha_desde: fecha,
      fecha_hasta: fecha,
      cantidad: 1,
      unidad: 'Dias',
      estado: 'Pendiente',
      origen: 'Automatica',
      observacion: `Ausencia automática: sin fichada de entrada (${fecha}).`,
      fecha_creacion: new Date().toISOString(),
      id_usuario_creacion: null,
    }
    if (!dryRun) {
      const { error } = await supabase.from('novedad').insert(row)
      if (error) throw error
    }
    return { kind: 'created', legajo, details: { tipo: 'Ausencia', dryRun, horario: horario.nombre } }
  }

  /* Horario flexible: hay entrada; no aplica comparación con hora fija de ingreso. */
  if (flexible) {
    return {
      kind: 'ok',
      legajo,
      details: { reason: 'entrada_registrada_sin_control_horario_fijo', entrada: entrada.fecha_hora },
    }
  }

  /* Tardanza: Fijo / Rotativo con hora de entrada configurada. */

  const expectedMin = timeStrToMinutes(hd.hora_entrada)
  if (expectedMin == null) {
    return { kind: 'skipped', legajo, details: { reason: 'sin_hora_entrada_configurada' } }
  }

  const actualMin = minutesFromFichadaTimestamp(entrada.fecha_hora)
  if (actualMin == null) {
    return { kind: 'skipped', legajo, details: { reason: 'fichada_sin_hora' } }
  }

  const limite = expectedMin + tol
  if (actualMin <= limite) {
    return { kind: 'ok', legajo, details: { reason: 'a_tiempo', entrada: entrada.fecha_hora } }
  }

  const minutosTarde = actualMin - limite

  const existsT = await hasTardanzaOnDate(supabase, legajo, fecha)
  if (existsT) {
    return { kind: 'skipped', legajo, details: { reason: 'tardanza_ya_registrada' } }
  }

  const row = {
    legajo,
    tipo: 'Tardanza',
    fecha_desde: fecha,
    fecha_hasta: fecha,
    cantidad: minutosTarde,
    unidad: 'Minutos',
    estado: 'Pendiente',
    origen: 'Automatica',
    observacion:
      `Tardanza automática: entrada a las ${fmtHm(actualMin)}, ` +
      `esperada hasta ${fmtHm(limite)} (${fmtHm(expectedMin)} + ${tol} min tolerancia).`,
    fecha_creacion: new Date().toISOString(),
    id_usuario_creacion: null,
  }
  if (!dryRun) {
    const { error } = await supabase.from('novedad').insert(row)
    if (error) throw error
  }
  return {
    kind: 'created',
    legajo,
    details: {
      tipo: 'Tardanza',
      minutos: minutosTarde,
      dryRun,
      horario: horario.nombre,
    },
  }
}

/**
 * Evalúa todos los empleados activos para una fecha calendario.
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
      const r = await evaluateEmployeeDay(supabase, e.legajo, fecha, options)
      results.push(r)
    } catch (err) {
      results.push({ kind: 'error', legajo: e.legajo, details: { message: err.message } })
    }
  }
  return results
}
