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

const app = express()

app.use(cors())
app.use(express.json())

app.use('/api/auth',      authRouter)
app.use('/api/dashboard', dashboardRouter)
app.use('/api/catalogs',  catalogsRouter)
app.use('/api/employees', employeesRouter)
app.use('/api/punches',   punchesRouter)
app.use('/api/schedules', schedulesRouter)
app.use('/api/news',      newsRouter)
app.use('/api/closures',  closuresRouter)
app.use('/api/exports',   exportsRouter)
app.use('/api/reasoning', reasoningRouter)

app.get('/health', (_req, res) => res.json({ status: 'ok' }))

const PORT = process.env.PORT ?? 3000
app.listen(PORT, () => console.log(`Labor Pulse API corriendo en http://localhost:${PORT}`))
