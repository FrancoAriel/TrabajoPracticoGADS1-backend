import { Router } from 'express'
import supabase from '../lib/supabase.js'
import { normalizeRole, signToken } from '../lib/auth.js'
import { normalizeDni } from '../lib/dni.js'
import { parseLegajo } from '../lib/pinFichada.js'
import { ok, badRequest, serverError } from '../lib/response.js'

const router = Router()

function employeeInitials(nombre, apellido) {
  const parts = `${nombre ?? ''} ${apellido ?? ''}`.trim().split(/\s+/).filter(Boolean)
  return parts.map((w) => w[0]).join('').toUpperCase().slice(0, 2) || 'EM'
}

function employeeSessionUser(empleado) {
  return {
    id: empleado.legajo,
    legajo: empleado.legajo,
    name: `${empleado.nombre} ${empleado.apellido}`.trim(),
    email: null,
    role: 'Empleado',
    initials: employeeInitials(empleado.nombre, empleado.apellido),
  }
}

async function tryEmployeeLogin(username, password) {
  const passDigits = normalizeDni(password)
  if (!passDigits) return null

  const userDigits = normalizeDni(username)
  let empleado = null

  if (userDigits) {
    if (userDigits !== passDigits) return null
    const { data, error } = await supabase
      .from('empleado')
      .select('legajo, nombre, apellido, dni, estado')
      .eq('dni', userDigits)
      .maybeSingle()
    if (error) throw error
    empleado = data
  } else {
    const legajo = parseLegajo(username)
    if (!legajo) return null
    const { data, error } = await supabase
      .from('empleado')
      .select('legajo, nombre, apellido, dni, estado')
      .eq('legajo', legajo)
      .maybeSingle()
    if (error) throw error
    if (!data || normalizeDni(data.dni) !== passDigits) return null
    empleado = data
  }

  if (!empleado || String(empleado.estado || '').toLowerCase() !== 'activo') return null
  return empleado
}

// POST /auth/login
router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body
    if (!username || !password)
      return badRequest(res, 'username y password son requeridos')

    if (username === 'admin' && password === 'admin') {
      const responseUser = {
        id: 1,
        legajo: null,
        name: 'Admin Sistema',
        email: 'admin@laborpulse.local',
        role: 'Admin',
        initials: 'AS',
      }

      return ok(res, {
        token: signToken(responseUser),
        user: responseUser,
      })
    }

    const empleado = await tryEmployeeLogin(username, password)
    if (empleado) {
      const responseUser = employeeSessionUser(empleado)
      return ok(res, {
        token: signToken(responseUser),
        user: responseUser,
      })
    }

    const { data: user, error } = await supabase
      .from('usuario')
      .select('id_usuario, legajo, nombre, email, rol, estado, password')
      .or(`email.eq.${username},nombre.eq.${username}`)
      .single()

    if (error || !user)
      return res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Credenciales inválidas' } })

    if (String(user.estado || '').toLowerCase() !== 'activo')
      return res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Usuario inactivo' } })

    // En producción comparar hash. Por ahora comparación directa para el TP.
    if (user.password !== password)
      return res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Credenciales inválidas' } })

    const initials = user.nombre.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2)

    const responseUser = {
      id: user.id_usuario,
      legajo: user.legajo,
      name: user.nombre,
      email: user.email,
      role: normalizeRole(user.rol),
      initials,
    }

    return ok(res, {
      token: signToken(responseUser),
      user: {
        ...responseUser,
      },
    })
  } catch (err) {
    serverError(res, err)
  }
})

export default router
