# Desarrollo

## Requisitos

- Node.js 22 o superior (se usa 24 en las imágenes de Docker).
- Docker, para PostgreSQL.
- Visual Studio Code con las extensiones recomendadas en `.vscode/extensions.json`.

## Puesta en marcha

```bash
npm install
docker compose up -d db mailpit          # PostgreSQL en 127.0.0.1:5433 y Mailpit en :8025
npm run build -w apps/api
```

Aplica las migraciones (usa los valores de tu `.env`):

```bash
MIGRATION_DATABASE_URL=postgres://openhr_owner:<contraseña>@localhost:5433/openhr OPENHR_APP_DB_PASSWORD=<contraseña-app> npm run db:migrate
```

Arranca API y web en dos terminales:

```bash
DATABASE_URL=postgres://openhr_app:<contraseña-app>@localhost:5433/openhr SMTP_HOST=localhost npm run dev:api
npm run dev:web
```

La web en <http://localhost:3000> reenvía `/api` a `http://localhost:3001` (variable `API_URL`).

## Tests

```bash
docker compose -f docker-compose.test.yml up -d   # PostgreSQL efímero en el puerto 5434
npm test
```

- **Unitarios** (`apps/api/src/**/*.test.ts`): DNI/NIE, TOTP (vectores de la RFC 6238), fechas y cambios de hora, resumen diario de fichajes, cadena de hashes, días de ausencia y prorrateo de vacaciones, extracción de PDF.
- **Integración** (`apps/api/test/integration.test.ts`): levanta la API completa contra PostgreSQL real y recorre la configuración inicial, permisos, sesiones, RLS, inmutabilidad, fichaje, ausencias, nóminas, exportaciones e importación. Borra y recrea el esquema `public` de la base de pruebas.

Comprobaciones de tipos y build:

```bash
npm run typecheck -w apps/api
npm run typecheck -w apps/web
npm run build
```

## Convenciones

- **Idioma**: interfaz, mensajes de error, documentación y commits en español; identificadores de código en inglés.
- **Base de datos**: una migración nueva por cambio (`apps/api/migrations/00N_nombre.sql`); nunca editar una aplicada. Toda tabla nueva con `tenant_id` y `SELECT enable_tenant_rls('tabla')`.
- **Acceso a datos**: siempre dentro de `db.tx(tenantId, userId, fn)`; nunca con el pool directamente salvo funciones `SECURITY DEFINER`.
- **Permisos**: en el servicio, con las funciones de `common/access.ts`, antes de leer o escribir.
- **Validación**: zod en el controlador con `parse(schema, body)`.
- **Fechas**: fechas civiles como texto `AAAA-MM-DD`; instantes en UTC; conversiones con la zona horaria del centro (`common/dates.ts`).
- **Efectos secundarios**: notificaciones y emails por `NotificationsService` dentro de la transacción (outbox).
- **Interfaz**: colores solo con variables CSS (`docs/diseno.md`), iconos de `components/icons.tsx`, textos en español claro.

## Estructura

```
apps/api/
  migrations/          SQL
  src/                 módulos NestJS (ver docs/arquitectura.md)
  test/                integración
apps/web/
  src/app/(public)/    acceso, configuración inicial, contraseñas
  src/app/(app)/       páginas con sesión
  src/app/api/         proxy hacia la API
  src/components/      interfaz compartida (AppShell, TimeSheet, iconos, tema…)
  src/lib/             cliente de la API, sesión, formato, tema
docs/                  documentación
```
