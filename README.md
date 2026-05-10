# TrabajoPracticoGADS1 – Backend

REST API para **Labor Pulse**, sistema de gestión laboral (empleados, horarios, fichadas, novedades y cierre mensual).

## Stack

- Node.js (ESM)
- Express 4
- Supabase JS v2 (service role)

## Setup

```bash
npm install
cp .env.example .env   # completar con las keys de Supabase
npm run dev            # desarrollo con hot-reload
npm start              # producción
```

## Variables de entorno

| Variable | Descripción |
|---|---|
| `SUPABASE_URL` | URL del proyecto Supabase |
| `SUPABASE_SERVICE_ROLE_KEY` | Service role key (bypasa RLS) |
| `PORT` | Puerto HTTP (default: 3000) |

## Endpoints

| Método | Ruta | Descripción |
|---|---|---|
| POST | `/auth/login` | Login |
| GET | `/dashboard` | Métricas del dashboard |
| GET | `/catalogs` | Diccionarios y listas |
| GET | `/employees` | Listado de empleados (paginado) |
| POST | `/employees` | Crear empleado |
| GET | `/employees/:id` | Detalle de empleado |
| PATCH | `/employees/:id` | Actualizar empleado |
| DELETE | `/employees/:id` | Eliminar empleado |
| POST | `/employees/:id/assignments` | Asignar horario/ciclo |
| POST | `/employees/:id/news` | Cargar novedad |
| POST | `/employees/:id/manual-punches` | Fichada manual |
| GET | `/punches` | Listado de fichadas (paginado) |
| GET | `/punches/:id` | Detalle de fichada |
| POST | `/punches/manual` | Alta fichada manual |
| POST | `/punches/:id/corrections` | Corrección de fichada |
| DELETE | `/punches/:id` | Eliminar fichada |
| GET | `/schedules/overview` | Horarios, ciclos y asignaciones |
| POST | `/schedules` | Crear horario |
| PATCH | `/schedules/:id` | Actualizar horario |
| DELETE | `/schedules/:id` | Eliminar horario |
| POST | `/schedules/cycles` | Crear ciclo rotativo |
| PATCH | `/schedules/cycles/:id` | Actualizar ciclo |
| DELETE | `/schedules/cycles/:id` | Eliminar ciclo |
| POST | `/schedules/assignments` | Crear asignación |
| PATCH | `/schedules/assignments/:id` | Actualizar asignación |
| DELETE | `/schedules/assignments/:id` | Eliminar asignación |
| GET | `/news` | Listado de novedades (paginado) |
| POST | `/news` | Crear novedad |
| POST | `/news/:id/approve` | Aprobar novedad |
| POST | `/news/:id/reject` | Rechazar novedad |
| DELETE | `/news/:id` | Eliminar novedad |
| GET | `/closures/current` | Cierre mensual actual |
| POST | `/closures` | Crear borrador de cierre |
| POST | `/closures/:id/run` | Ejecutar cierre |
| DELETE | `/closures/:id` | Eliminar borrador |
| GET | `/exports/options` | Opciones de exportación |
| POST | `/exports` | Generar exportación |
| GET | `/exports/:id/download` | Descargar exportación |
| GET | `/health` | Health check |

## Convenios de respuesta

```json
{ "data": {}, "meta": {} }
```

```json
{ "error": { "code": "VALIDATION_ERROR", "message": "...", "details": {} } }
```
