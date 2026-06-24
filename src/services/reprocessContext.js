import { preloadHolidaysForRange } from './holidays.js'

const PAGE_SIZE = 1000

function calendarDaysBetweenYmd(fromYmd, toYmd) {
  const a = new Date(`${fromYmd}T12:00:00`)
  const b = new Date(`${toYmd}T12:00:00`)
  return Math.round((b - a) / 86400000)
}

function novedadKey(legajo, tipo, fecha) {
  return `${legajo}:${tipo}:${fecha}`
}

function fichadaDayKey(legajo, fecha) {
  return `${legajo}:${fecha}`
}

function horarioDiaKey(idHorario, dow) {
  return `${idHorario}:${dow}`
}

function cicloDetKey(idCiclo, diaCiclo) {
  return `${idCiclo}:${diaCiclo}`
}

async function fetchAllRows(queryFn) {
  let from = 0
  const rows = []
  while (true) {
    const { data, error } = await queryFn(from, from + PAGE_SIZE - 1)
    if (error) throw error
    if (!data?.length) break
    rows.push(...data)
    if (data.length < PAGE_SIZE) break
    from += PAGE_SIZE
  }
  return rows
}

export async function runInBatches(items, concurrency, fn) {
  for (let i = 0; i < items.length; i += concurrency) {
    const chunk = items.slice(i, i + concurrency)
    await Promise.all(chunk.map(fn))
  }
}

export function createResultAggregator() {
  const byKind = { created: 0, ok: 0, skipped: 0, error: 0 }
  const byRule = {}
  const createdSummary = []
  const errors = []

  return {
    add(r, fecha) {
      byKind[r.kind] = (byKind[r.kind] ?? 0) + 1
      const rule = r.rule ?? 'unknown'
      byRule[rule] ??= { created: 0, ok: 0, skipped: 0, error: 0 }
      byRule[rule][r.kind] = (byRule[rule][r.kind] ?? 0) + 1
      if (r.kind === 'created') {
        createdSummary.push({
          legajo: r.legajo,
          fecha,
          rule: r.rule,
          tipo: r.details?.tipo,
          minutos: r.details?.minutos,
          pares: r.details?.pares,
          motivo: r.details?.motivo,
          dryRun: r.details?.dryRun,
          horario: r.details?.horario,
        })
      }
      if (r.kind === 'error') {
        errors.push({ ...r, fecha })
      }
    },
    toSummary() {
      return { totals: byKind, byRule, createdSummary, errors }
    },
  }
}

export async function buildReprocessContext(supabase, desde, hasta, legajos) {
  const employees = new Map()
  const { data: emps, error: eEmp } = await supabase
    .from('empleado')
    .select('legajo, estado')
    .in('legajo', legajos)
  if (eEmp) throw eEmp
  for (const e of emps ?? []) employees.set(e.legajo, e)

  const asignacionesByLegajo = new Map()
  for (const l of legajos) asignacionesByLegajo.set(l, [])

  const asignRows = await fetchAllRows((from, to) =>
    supabase
      .from('asignacion_horario')
      .select('legajo, id_horario, fecha_desde, fecha_hasta')
      .in('legajo', legajos)
      .lte('fecha_desde', hasta)
      .range(from, to),
  )
  for (const r of asignRows) {
    asignacionesByLegajo.get(r.legajo)?.push(r)
  }

  const ciclosByLegajo = new Map()
  for (const l of legajos) ciclosByLegajo.set(l, [])

  const cicloRows = await fetchAllRows((from, to) =>
    supabase
      .from('empleado_ciclo')
      .select('legajo, id_ciclo, fecha_inicio, fecha_fin, ciclo_horario(duracion_dias)')
      .in('legajo', legajos)
      .lte('fecha_inicio', hasta)
      .range(from, to),
  )

  const cicloIds = new Set()
  for (const r of cicloRows) {
    ciclosByLegajo.get(r.legajo)?.push(r)
    if (r.id_ciclo) cicloIds.add(r.id_ciclo)
  }

  const cicloDetalle = new Map()
  if (cicloIds.size) {
    const detRows = await fetchAllRows((from, to) =>
      supabase
        .from('ciclo_horario_detalle')
        .select('id_ciclo, dia_ciclo, id_horario')
        .in('id_ciclo', [...cicloIds])
        .range(from, to),
    )
    for (const d of detRows) {
      cicloDetalle.set(cicloDetKey(d.id_ciclo, d.dia_ciclo), d.id_horario)
    }
  }

  const horarioIds = new Set()
  for (const rows of asignacionesByLegajo.values()) {
    for (const r of rows) if (r.id_horario) horarioIds.add(r.id_horario)
  }
  for (const id of cicloDetalle.values()) horarioIds.add(id)

  const horarios = new Map()
  const horarioDias = new Map()
  if (horarioIds.size) {
    const ids = [...horarioIds]
    const hRows = await fetchAllRows((from, to) =>
      supabase
        .from('horario')
        .select(
          'id_horario, nombre, tipo, tolerancia_entrada_min, tolerancia_salida_min, descanso_minimo_min, umbral_horas_extra_min',
        )
        .in('id_horario', ids)
        .range(from, to),
    )
    for (const h of hRows) horarios.set(h.id_horario, h)

    const hdRows = await fetchAllRows((from, to) =>
      supabase
        .from('horario_dia')
        .select('id_horario, dia_semana, hora_entrada, hora_salida, es_laborable')
        .in('id_horario', ids)
        .range(from, to),
    )
    for (const hd of hdRows) {
      horarioDias.set(horarioDiaKey(hd.id_horario, hd.dia_semana), hd)
    }
  }

  const fichadasByDay = new Map()
  const punchRows = await fetchAllRows((from, to) =>
    supabase
      .from('fichada')
      .select('legajo, id_fichada, fecha_hora, tipo')
      .in('legajo', legajos)
      .eq('es_correccion', false)
      .gte('fecha_hora', `${desde}T00:00:00`)
      .lte('fecha_hora', `${hasta}T23:59:59.999`)
      .order('fecha_hora', { ascending: true })
      .range(from, to),
  )
  for (const p of punchRows) {
    const fecha = String(p.fecha_hora).slice(0, 10)
    const key = fichadaDayKey(p.legajo, fecha)
    if (!fichadasByDay.has(key)) fichadasByDay.set(key, [])
    fichadasByDay.get(key).push(p)
  }

  const novedadOnDate = new Set()
  const autoNovedadOnDate = new Set()
  const ausenciasByLegajo = new Map()
  for (const l of legajos) ausenciasByLegajo.set(l, [])

  const novedadRows = await fetchAllRows((from, to) =>
    supabase
      .from('novedad')
      .select('legajo, tipo, fecha_desde, fecha_hasta, origen')
      .in('legajo', legajos)
      .lte('fecha_desde', hasta)
      .range(from, to),
  )
  for (const n of novedadRows) {
    const fd = String(n.fecha_desde)
    if (fd >= desde && fd <= hasta) {
      novedadOnDate.add(novedadKey(n.legajo, n.tipo, fd))
      if (n.origen === 'Automatica') {
        autoNovedadOnDate.add(novedadKey(n.legajo, n.tipo, fd))
      }
    }
    if (n.tipo === 'Ausencia') {
      ausenciasByLegajo.get(n.legajo)?.push(n)
    }
  }

  await preloadHolidaysForRange(desde, hasta)

  return {
    dryRun: false,
    pendingInserts: [],

    getEmployee(legajo) {
      return employees.get(legajo) ?? null
    },

    resolveHorario(legajo, fecha) {
      const asgValid = (asignacionesByLegajo.get(legajo) ?? [])
        .filter((r) => !r.fecha_hasta || String(r.fecha_hasta) >= fecha)
        .sort((a, b) => String(b.fecha_desde).localeCompare(String(a.fecha_desde)))
      if (asgValid.length) {
        return { idHorario: asgValid[0].id_horario, source: 'asignacion' }
      }

      const cicloValid = (ciclosByLegajo.get(legajo) ?? [])
        .filter((r) => !r.fecha_fin || String(r.fecha_fin) >= fecha)
        .sort((a, b) => String(b.fecha_inicio).localeCompare(String(a.fecha_inicio)))
      const ec = cicloValid[0]
      if (!ec) return null

      const dur = ec.ciclo_horario?.duracion_dias
      if (!dur || dur < 1) return null

      const diff = calendarDaysBetweenYmd(String(ec.fecha_inicio), fecha)
      if (diff < 0) return null

      const diaCiclo = (diff % dur) + 1
      const idHorario = cicloDetalle.get(cicloDetKey(ec.id_ciclo, diaCiclo))
      if (!idHorario) return null

      return { idHorario, source: 'ciclo', diaCiclo }
    },

    getHorarioMeta(idHorario) {
      return horarios.get(idHorario) ?? null
    },

    getHorarioDia(idHorario, dow) {
      return horarioDias.get(horarioDiaKey(idHorario, dow)) ?? null
    },

    getFichadas(legajo, fecha) {
      return fichadasByDay.get(fichadaDayKey(legajo, fecha)) ?? []
    },

    hasAutomaticNovedad(legajo, tipo, fecha) {
      return autoNovedadOnDate.has(novedadKey(legajo, tipo, fecha))
    },

    hasAusenciaCovering(legajo, fecha) {
      return (ausenciasByLegajo.get(legajo) ?? []).some((n) => {
        const desdeN = String(n.fecha_desde)
        if (fecha < desdeN) return false
        if (n.fecha_hasta == null) return true
        return fecha <= String(n.fecha_hasta)
      })
    },

    hasNovedadOnDate(legajo, tipo, fecha) {
      return novedadOnDate.has(novedadKey(legajo, tipo, fecha))
    },

    recordInsert(row, dryRun) {
      novedadOnDate.add(novedadKey(row.legajo, row.tipo, row.fecha_desde))
      if (row.origen === 'Automatica') {
        autoNovedadOnDate.add(novedadKey(row.legajo, row.tipo, row.fecha_desde))
      }
      if (row.tipo === 'Ausencia') {
        if (!ausenciasByLegajo.has(row.legajo)) ausenciasByLegajo.set(row.legajo, [])
        ausenciasByLegajo.get(row.legajo).push({
          fecha_desde: row.fecha_desde,
          fecha_hasta: row.fecha_hasta,
        })
      }
      if (!dryRun) this.pendingInserts.push(row)
    },

    async flushInserts(supabaseClient) {
      if (this.dryRun || !this.pendingInserts.length) return
      const BATCH = 200
      for (let i = 0; i < this.pendingInserts.length; i += BATCH) {
        const chunk = this.pendingInserts.slice(i, i + BATCH)
        const { error } = await supabaseClient.from('novedad').insert(chunk)
        if (error) throw error
      }
      this.pendingInserts = []
    },
  }
}

export function createContextStore(ctx) {
  return {
    async getEmployee(legajo) {
      return ctx.getEmployee(legajo)
    },
    async resolveHorario(legajo, fecha) {
      return ctx.resolveHorario(legajo, fecha)
    },
    async getHorarioMeta(idHorario) {
      return ctx.getHorarioMeta(idHorario)
    },
    async getHorarioDia(idHorario, dow) {
      return ctx.getHorarioDia(idHorario, dow)
    },
    async getFichadas(legajo, fecha) {
      return ctx.getFichadas(legajo, fecha)
    },
    async hasAutomaticNovedad(legajo, tipo, fecha) {
      return ctx.hasAutomaticNovedad(legajo, tipo, fecha)
    },
    async hasAusenciaCovering(legajo, fecha) {
      return ctx.hasAusenciaCovering(legajo, fecha)
    },
    async hasNovedadOnDate(legajo, tipo, fecha) {
      return ctx.hasNovedadOnDate(legajo, tipo, fecha)
    },
    async insertNovedad(row, dryRun) {
      ctx.recordInsert(row, dryRun)
    },
  }
}
