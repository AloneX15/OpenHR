# OpenHR

Gestión de RR. HH. open source y autoalojable para grupos de empresas en España. Monorepo de npm workspaces: `apps/api` (NestJS 11 + PostgreSQL con SQL directo) y `apps/web` (Next.js 16).

- Interfaz, mensajes, documentación y commits en **español**; identificadores de código en inglés.
- Antes de tocar algo, lee la documentación de `docs/` que le afecte: [arquitectura](docs/arquitectura.md), [base de datos](docs/base-de-datos.md), [API](docs/api.md), [seguridad](docs/seguridad.md), [diseño](docs/diseno.md) y [desarrollo](docs/desarrollo.md). Usa el vocabulario de [GLOSSARY.md](GLOSSARY.md).
- Tests: `docker compose -f docker-compose.test.yml up -d` y después `npm test`. Comprobación de tipos: `npm run typecheck -w apps/api` y `npm run typecheck -w apps/web`.

## Reglas que no se negocian

- Toda tabla con `tenant_id` lleva RLS: `SELECT enable_tenant_rls('tabla')` en su migración. Migración nueva por cambio; nunca editar una aplicada.
- Acceso a datos siempre dentro de `db.tx(tenantId, userId, fn)`. El pool directo solo para funciones `SECURITY DEFINER`.
- Permisos en el servicio con `apps/api/src/common/access.ts`, antes de leer o escribir.
- `time_entry` es inmutable: las correcciones son eventos nuevos (ver ADR 0002).
- Colores solo con variables CSS; iconos desde `apps/web/src/components/icons.tsx`.
- La instancia local de Docker del usuario (proyecto `openhr`) tiene datos reales: nunca `docker compose down -v` en ella; para pruebas usa `-p openhr-demo` con otros puertos.

## Agent skills

### Issue tracker

Las incidencias se gestionan en GitHub Issues de AloneX15/OpenHR con la CLI `gh`. See `docs/agents/issue-tracker.md`.

### Triage labels

Etiquetas por defecto: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: un `GLOSSARY.md` en la raíz y las decisiones en `docs/adr/`. See `docs/agents/domain.md`.
