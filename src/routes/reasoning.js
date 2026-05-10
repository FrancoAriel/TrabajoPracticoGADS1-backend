import { Router } from 'express'
import supabase from '../lib/supabase.js'
import { badRequest, ok, serverError } from '../lib/response.js'
import {
  evaluateAllEmployeesForDate,
  evaluateEmployeeDay,
} from '../services/attendanceEvaluation.js'

const router = Router()

function summarize(results) {
  const byKind = { created: 0, ok: 0, skipped: 0, error: 0 }
  const createdDetail = []
  for (const r of results) {
    byKind[r.kind] = (byKind[r.kind] ?? 0) + 1
    if (r.kind === 'created') {
      createdDetail.push({
        legajo: r.legajo,
        tipo: r.details?.tipo,
        minutos: r.details?.minutos,
        dryRun: r.details?.dryRun,
        horario: r.details?.horario,
      })
    }
  }
  return {
    totals: byKind,
    results,
    createdSummary: createdDetail,
  }
}

/**
 * POST /reasoning/evaluate-day
 * Body: { fecha: "YYYY-MM-DD", dryRun?: boolean, legajos?: number[] }
 * Evalúa tardanza / ausencia automáticas para esa fecha (todos los activos o solo los legajos indicados).
 */
router.post('/evaluate-day', async (req, res) => {
  try {
    const { fecha, dryRun, legajos } = req.body ?? {}
    if (!fecha || !/^\d{4}-\d{2}-\d{2}$/.test(String(fecha))) {
      return badRequest(res, 'fecha es requerida en formato YYYY-MM-DD')
    }
    const dry = Boolean(dryRun)
    const lista =
      Array.isArray(legajos) && legajos.length
        ? legajos.map((x) => Number(x)).filter((n) => Number.isFinite(n) && n > 0)
        : null

    if (lista?.length) {
      const results = []
      for (const leg of lista) {
        try {
          const r = await evaluateEmployeeDay(supabase, leg, String(fecha), { dryRun: dry })
          results.push(r)
        } catch (err) {
          results.push({ kind: 'error', legajo: leg, details: { message: err.message } })
        }
      }
      return ok(res, summarize(results))
    }

    const results = await evaluateAllEmployeesForDate(supabase, String(fecha), { dryRun: dry })
    return ok(res, summarize(results))
  } catch (err) {
    serverError(res, err)
  }
})

export default router
