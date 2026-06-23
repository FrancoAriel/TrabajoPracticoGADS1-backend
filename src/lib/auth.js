import crypto from 'crypto'

const TOKEN_TTL_SECONDS = Number(process.env.JWT_TTL_SECONDS || 60 * 60 * 8)

function base64url(input) {
  return Buffer.from(input)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
}

function decodeBase64url(input) {
  const normalized = String(input).replace(/-/g, '+').replace(/_/g, '/')
  return Buffer.from(normalized, 'base64').toString('utf8')
}

function jwtSecret() {
  const secret = process.env.JWT_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!secret) throw new Error('Falta configurar JWT_SECRET o SUPABASE_SERVICE_ROLE_KEY')
  return secret
}

export function normalizeRole(role) {
  const value = String(role || '').trim().toLowerCase()
  if (value === 'admin') return 'Admin'
  if (value === 'empleado') return 'Empleado'
  if (value === 'contador') return 'Contador'
  return String(role || '').trim()
}

export function signToken(user) {
  const now = Math.floor(Date.now() / 1000)
  const header = { alg: 'HS256', typ: 'JWT' }
  const payload = {
    sub: String(user.id),
    name: user.name,
    email: user.email,
    role: normalizeRole(user.role),
    legajo: user.legajo ?? null,
    iat: now,
    exp: now + TOKEN_TTL_SECONDS,
  }
  const encodedHeader = base64url(JSON.stringify(header))
  const encodedPayload = base64url(JSON.stringify(payload))
  const signature = crypto
    .createHmac('sha256', jwtSecret())
    .update(`${encodedHeader}.${encodedPayload}`)
    .digest('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
  return `${encodedHeader}.${encodedPayload}.${signature}`
}

export function verifyToken(token) {
  try {
    const [encodedHeader, encodedPayload, signature] = String(token || '').split('.')
    if (!encodedHeader || !encodedPayload || !signature) return null
    const expected = crypto
      .createHmac('sha256', jwtSecret())
      .update(`${encodedHeader}.${encodedPayload}`)
      .digest('base64')
      .replace(/=/g, '')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')

    const actualBuffer = Buffer.from(signature)
    const expectedBuffer = Buffer.from(expected)
    if (actualBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(actualBuffer, expectedBuffer)) return null

    const payload = JSON.parse(decodeBase64url(encodedPayload))
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null
    return { ...payload, role: normalizeRole(payload.role) }
  } catch {
    return null
  }
}

export function requireAuth(req, res, next) {
  const header = req.headers.authorization || ''
  const token = header.startsWith('Bearer ') ? header.slice(7) : req.query.access_token
  const user = verifyToken(token)
  if (!user) {
    return res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Sesión inválida o expirada' } })
  }
  req.user = user
  return next()
}

export function requireRole(...roles) {
  const allowed = roles.map(normalizeRole)
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Sesión inválida o expirada' } })
    }
    if (!allowed.includes(normalizeRole(req.user.role))) {
      return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'No tenés permisos para esta acción' } })
    }
    return next()
  }
}
