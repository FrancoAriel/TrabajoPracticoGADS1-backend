import 'dotenv/config'
import express from 'express'
import cors from 'cors'

import authRouter       from './routes/auth.js'
import dashboardRouter  from './routes/dashboard.js'
import catalogsRouter   from './routes/catalogs.js'
import employeesRouter  from './routes/employees.js'
import punchesRouter    from './routes/punches.js'
import schedulesRouter  from './routes/schedules.js'
import newsRouter       from './routes/news.js'
import closuresRouter   from './routes/closures.js'
import exportsRouter    from './routes/exports.js'
import reasoningRouter  from './routes/reasoning.js'
import meRouter         from './routes/me.js'
import { requireAuth, requireRole } from './lib/auth.js'

const app = express()

const defaultOrigins = [
  'https://francoariel.github.io',
  'http://localhost:5173',
  'http://localhost:3000',
  'http://localhost:4173',
  'http://127.0.0.1:5173',
]
const allowedOrigins = process.env.CORS_ORIGINS
  ? process.env.CORS_ORIGINS.split(',').map(s => s.trim()).filter(Boolean)
  : defaultOrigins

app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true)
    if (allowedOrigins.includes(origin)) return cb(null, true)
    return cb(new Error(`Origin ${origin} no permitido por CORS`))
  },
}))
app.use(express.json())

app.use('/api/auth',      authRouter)
app.use('/api/dashboard', requireAuth, requireRole('Admin', 'Contador', 'Empleado'), dashboardRouter)
app.use('/api/catalogs',  requireAuth, catalogsRouter)
app.use('/api/employees', requireAuth, requireRole('Admin'), employeesRouter)
app.use('/api/punches',   requireAuth, requireRole('Admin'), punchesRouter)
app.use('/api/schedules', requireAuth, requireRole('Admin'), schedulesRouter)
app.use('/api/news',      requireAuth, requireRole('Admin', 'Contador'), newsRouter)
app.use('/api/closures',  requireAuth, requireRole('Admin', 'Contador'), closuresRouter)
app.use('/api/exports',   requireAuth, requireRole('Admin', 'Contador'), exportsRouter)
app.use('/api/reasoning', requireAuth, requireRole('Admin'), reasoningRouter)
app.use('/api/me',        requireAuth, requireRole('Empleado', 'Admin'), meRouter)

app.get('/health', (_req, res) => res.json({ status: 'ok' }))

const PORT = process.env.PORT ?? 3000
app.listen(PORT, () => console.log(`Labor Pulse API corriendo en http://localhost:${PORT}`))
