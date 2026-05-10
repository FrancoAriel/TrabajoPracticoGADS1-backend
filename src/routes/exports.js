import { Router } from 'express'
import { ok, serverError } from '../lib/response.js'

const router = Router()

const exportHistory = []

// GET /exports/options
router.get('/options', (_req, res) => {
  try {
    return ok(res, {
      stats: { today: 0, csv: 0, pdf: 0, xlsx: 0 },
      reports: [
        { key: 'punches',   label: 'Fichadas',        periodOptions: [], formatOptions: ['CSV', 'PDF', 'XLSX'] },
        { key: 'news',      label: 'Novedades',       periodOptions: [], formatOptions: ['CSV', 'XLSX'] },
        { key: 'employees', label: 'Empleados',       periodOptions: [], formatOptions: ['CSV', 'XLSX'] },
        { key: 'closure',   label: 'Cierre mensual',  periodOptions: [], formatOptions: ['PDF', 'XLSX'] }
      ],
      history: exportHistory
    })
  } catch (err) {
    serverError(res, err)
  }
})

// POST /exports
router.post('/', (req, res) => {
  try {
    const { reportKey, period, format } = req.body
    const exportId = `exp_${Date.now()}`
    const entry = { exportId, reportKey, period, format, createdAt: new Date().toISOString(), downloadUrl: `/exports/${exportId}/download` }
    exportHistory.unshift(entry)

    return res.status(201).json({ data: { exportId: entry.exportId, downloadUrl: entry.downloadUrl } })
  } catch (err) {
    serverError(res, err)
  }
})

// GET /exports/:id/download
router.get('/:id/download', (req, res) => {
  const entry = exportHistory.find(e => e.exportId === req.params.id)
  if (!entry) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Export no encontrado' } })

  res.setHeader('Content-Disposition', `attachment; filename="${entry.reportKey}_${entry.period ?? 'export'}.${(entry.format ?? 'csv').toLowerCase()}"`)
  res.setHeader('Content-Type', 'text/plain')
  res.send(`Exportación de ${entry.reportKey} – ${entry.period} – formato ${entry.format}\n(datos reales pendientes de implementación)`)
})

export default router
