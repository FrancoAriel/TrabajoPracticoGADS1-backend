/**
 * Servicio de feriados (Argentina) con caché en memoria.
 * Fuente: https://api.argentinadatos.com/v1/feriados/{year}
 *
 * Decisión de diseño documentada en el TP:
 * - No se persisten feriados en BD; se consultan vía API externa y se cachean en memoria.
 * - Se utilizan para clasificar horas extra al 100% (domingo o feriado).
 */

const API_BASE = 'https://api.argentinadatos.com/v1/feriados'

/** Cache: Map<year:number, Set<dateISO:string>> */
const cache = new Map()
/** Cache de promesas en vuelo, para evitar dobles fetch concurrentes del mismo año. */
const inflight = new Map()

/**
 * Carga feriados de un año desde la API externa.
 * Devuelve un Set de fechas en formato YYYY-MM-DD.
 */
async function loadYear(year) {
  if (cache.has(year)) return cache.get(year)
  if (inflight.has(year)) return inflight.get(year)

  const promise = (async () => {
    try {
      const res = await fetch(`${API_BASE}/${year}`, {
        headers: { Accept: 'application/json' },
      })
      if (!res.ok) {
        throw new Error(`Feriados API respondió ${res.status} para año ${year}`)
      }
      const arr = await res.json()
      const set = new Set(
        (Array.isArray(arr) ? arr : [])
          .map((f) => String(f?.fecha ?? '').slice(0, 10))
          .filter((s) => /^\d{4}-\d{2}-\d{2}$/.test(s)),
      )
      cache.set(year, set)
      return set
    } catch (err) {
      // En caso de fallo de red, cacheamos un set vacío por 5 min para no bloquear el motor.
      const empty = new Set()
      cache.set(year, empty)
      setTimeout(() => cache.delete(year), 5 * 60 * 1000)
      console.error(`[holidays] Error cargando feriados ${year}:`, err.message)
      return empty
    } finally {
      inflight.delete(year)
    }
  })()

  inflight.set(year, promise)
  return promise
}

/**
 * Indica si una fecha YYYY-MM-DD es feriado en Argentina.
 * @param {string} ymd Formato YYYY-MM-DD
 * @returns {Promise<boolean>}
 */
export async function isHoliday(ymd) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(ymd))) return false
  const year = Number(String(ymd).slice(0, 4))
  if (!Number.isFinite(year)) return false
  const set = await loadYear(year)
  return set.has(ymd)
}

/** Precarga feriados de todos los años que cubre un rango YYYY-MM-DD. */
export async function preloadHolidaysForRange(desde, hasta) {
  const y1 = Number(String(desde).slice(0, 4))
  const y2 = Number(String(hasta).slice(0, 4))
  if (!Number.isFinite(y1) || !Number.isFinite(y2)) return
  const years = []
  for (let y = Math.min(y1, y2); y <= Math.max(y1, y2); y += 1) years.push(y)
  await Promise.all(years.map((year) => loadYear(year)))
}

/**
 * Borra el caché (útil para tests o reprocesamiento forzado).
 */
export function clearHolidayCache() {
  cache.clear()
  inflight.clear()
}
