/** Solo dígitos del documento (DNI/CUIL parcial). */
export function normalizeDni(value) {
  if (value == null || value === '') return ''
  return String(value).replace(/\D/g, '')
}
