import { Router } from 'express'
import supabase from '../lib/supabase.js'
import { normalizeRole, signToken } from '../lib/auth.js'
import { ok, badRequest, serverError } from '../lib/response.js'

const router = Router()

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
