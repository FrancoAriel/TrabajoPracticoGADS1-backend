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

const app = express()

app.use(cors())
app.use(express.json())

app.use('/auth',      authRouter)
app.use('/dashboard', dashboardRouter)
app.use('/catalogs',  catalogsRouter)
app.use('/employees', employeesRouter)
app.use('/punches',   punchesRouter)
app.use('/schedules', schedulesRouter)
app.use('/news',      newsRouter)
app.use('/closures',  closuresRouter)
app.use('/exports',   exportsRouter)

app.get('/health', (_req, res) => res.json({ status: 'ok' }))

const PORT = process.env.PORT ?? 3000
app.listen(PORT, () => console.log(`Labor Pulse API corriendo en http://localhost:${PORT}`))
