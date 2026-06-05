import { Router } from 'express'
import supabase from '../lib/supabase.js'
import { badRequest, ok, serverError } from '../lib/response.js'
import {
  evaluateAllEmployeesForDate,
  evaluateEmployeeDay,
  reprocessRange,
} from '../services/attendanceEvaluation.js'

const router = Router()

const YMD_RE = /^\d{4}-\d{2}-\d{2}$/

/**
 * Agrupa resultados por kind y por regla para facilitar lectura en el cliente.
 * Mantiene `results` completo para depuración.
 */
function summarize(results) {
  const byKind = { created: 0, ok: 0, skipped: 0, error: 0 }
  const byRule = {}
  const createdDetail = []
  for (const r of results) {
    byKind[r.kind] = (byKind[r.kind] ?? 0) + 1
    const rule = r.rule ?? 'unknown'
    byRule[rule] = byRule[rule] ?? { created: 0, ok: 0, skipped: 0, error: 0 }
    byRule[rule][r.kind] = (byRule[rule][r.kind] ?? 0) + 1
    if (r.kind === 'created') {
      createdDetail.push({
        legajo: r.legajo,
        fecha: r.fecha,
        rule: r.rule,
        tipo: r.details?.tipo,
        minutos: r.details?.minutos,
        pares: r.details?.pares,
        motivo: r.details?.motivo,
        dryRun: r.details?.dryRun,
        horario: r.details?.horario,
      })
    }
  }
  return { totals: byKind, byRule, results, createdSummary: createdDetail }
}

/**
 * POST /reasoning/evaluate-day
 * Body: { fecha: "YYYY-MM-DD", dryRun?: boolean, legajos?: number[] }
 * Evalúa las 5 reglas para esa fecha (todos los activos o solo los legajos indicados).
 */
router.post('/evaluate-day', async (req, res) => {
  try {
    const { fecha, dryRun, legajos } = req.body ?? {}
    if (!fecha || !YMD_RE.test(String(fecha))) {
      return badRequest(res, 'fecha es requerida en formato YYYY-MM-DD')
    }
    const dry = Boolean(dryRun)
    const lista =
      Array.isArray(legajos) && legajos.length
        ? legajos.map((x) => Number(x)).filter((n) => Number.isFinite(n) && n > 0)
        : null

    const all = []
    if (lista?.length) {
      for (const leg of lista) {
        try {
          const arr = await evaluateEmployeeDay(supabase, leg, String(fecha), { dryRun: dry })
          for (const r of arr) all.push({ ...r, fecha: String(fecha) })
        } catch (err) {
          all.push({
            rule: 'meta',
            kind: 'error',
            legajo: leg,
            fecha: String(fecha),
            details: { message: err.message },
          })
        }
      }
    } else {
      const arr = await evaluateAllEmployeesForDate(supabase, String(fecha), { dryRun: dry })
      for (const r of arr) all.push({ ...r, fecha: String(fecha) })
    }
    return ok(res, summarize(all))
  } catch (err) {
    serverError(res, err)
  }
})

/**
 * POST /reasoning/reprocess-range
 * Body: { desde: "YYYY-MM-DD", hasta: "YYYY-MM-DD", dryRun?: boolean, legajos?: number[] }
 *
 * Borra todas las novedades automáticas (origen='Automatica') del rango y reglas
 * conocidas, y vuelve a evaluar día por día. Útil cuando cambian horarios o se
 * corrigen fichadas históricas.
 */
router.post('/reprocess-range', async (req, res) => {
  try {
    const { desde, hasta, dryRun, legajos } = req.body ?? {}
    if (!desde || !YMD_RE.test(String(desde))) {
      return badRequest(res, 'desde es requerido en formato YYYY-MM-DD')
    }
    if (!hasta || !YMD_RE.test(String(hasta))) {
      return badRequest(res, 'hasta es requerido en formato YYYY-MM-DD')
    }
    if (String(hasta) < String(desde)) {
      return badRequest(res, 'hasta debe ser >= desde')
    }
    const dry = Boolean(dryRun)
    const lista =
      Array.isArray(legajos) && legajos.length
        ? legajos.map((x) => Number(x)).filter((n) => Number.isFinite(n) && n > 0)
        : null

    const all = await reprocessRange(supabase, String(desde), String(hasta), {
      legajos: lista,
      dryRun: dry,
    })

    const summary = summarize(all)
    return ok(res, {
      desde,
      hasta,
      legajos: lista,
      dryRun: dry,
      ...summary,
    })
  } catch (err) {
    serverError(res, err)
  }
})

export default router
