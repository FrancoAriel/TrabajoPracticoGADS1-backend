import { Router } from 'express'
import supabase from '../lib/supabase.js'
import { ok, badRequest, serverError } from '../lib/response.js'

const router = Router()

// POST /auth/login
router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body
    if (!username || !password)
      return badRequest(res, 'username y password son requeridos')

    const { data: user, error } = await supabase
      .from('usuario')
      .select('id_usuario, nombre, email, rol, estado, password')
      .or(`email.eq.${username},nombre.eq.${username}`)
      .eq('estado', 'activo')
      .single()

    if (error || !user)
      return res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Credenciales inválidas' } })

    // En producción comparar hash. Por ahora comparación directa para el TP.
    if (user.password !== password)
      return res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Credenciales inválidas' } })

    const initials = user.nombre.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2)

    return ok(res, {
      token: `token_${user.id_usuario}_${Date.now()}`,
      user: {
        id: user.id_usuario,
        name: user.nombre,
        role: user.rol,
        initials
      }
    })
  } catch (err) {
    serverError(res, err)
  }
})

export default router
