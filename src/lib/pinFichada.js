/** Normaliza legajo desde string o número. */
export function parseLegajo(value) {
  if (value == null || value === '') return null
  const legajoNum = typeof value === 'string' ? Number(value.replace(/\D/g, '')) : Number(value)
  return Number.isFinite(legajoNum) && legajoNum > 0 ? legajoNum : null
}

/** Valida y normaliza PIN de fichada (4–6 dígitos). */
export function normalizePinFichada(value) {
  if (value == null || value === '') return null
  const pin = String(value).trim()
  if (!/^\d{4,6}$/.test(pin)) return null
  return pin
}

/** Resuelve PIN explícito o, si modalidad Pin, últimos 4 del DNI. */
export function resolvePinFichada({ pinFichada, dni, modalidadFichada }) {
  const explicit = normalizePinFichada(pinFichada)
  if (explicit) return explicit
  if (modalidadFichada !== 'Pin' || !dni) return null
  const digits = String(dni).replace(/\D/g, '')
  if (digits.length < 4) return null
  return digits.slice(-4)
}

/** Timestamp local sin zona (compatible con fichadas existentes). */
export function nowLocalIso() {
  const d = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}
