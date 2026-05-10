export const ok = (res, data, meta, status = 200) =>
  res.status(status).json(meta ? { data, meta } : { data })

export const created = (res, data) => ok(res, data, null, 201)

export const noContent = (res) => res.status(204).send()

export const notFound = (res, message = 'Recurso no encontrado') =>
  res.status(404).json({ error: { code: 'NOT_FOUND', message } })

export const badRequest = (res, message, details = {}) =>
  res.status(400).json({ error: { code: 'VALIDATION_ERROR', message, details } })

export const serverError = (res, err) => {
  console.error(err)
  res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err?.message ?? 'Error interno del servidor' } })
}
