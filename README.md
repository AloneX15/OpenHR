# OpenHR

Gestión de personas **open source y autoalojable**, pensada para grupos de empresas en España: varias sociedades con un mismo equipo de RR. HH., registro de jornada conforme al art. 34.9 del Estatuto de los Trabajadores y reparto de nóminas de la gestoría.

> Estado: **MVP piloto** (v0.1). Pensado para un primer grupo piloto antes de la V1 comercial. Ver [el alcance](#alcance-del-mvp-piloto).

## Qué incluye

| Módulo | Lo que hace |
| --- | --- |
| **Organización** | Varias sociedades (CIF, CCC), centros de trabajo con zona horaria, departamentos, festivos nacionales/autonómicos/locales, tipos de ausencia del ET editables. Una persona puede tener relaciones laborales en varias sociedades del grupo. |
| **Personas** | Alta individual o importación desde CSV o Excel (con validación previa y atómica), responsable directo, jornada teórica por día, invitación por email, baja, traspaso entre sociedades, checklists de alta, baja y traspaso, campos personalizados, anuncios, políticas, firma individual, registro retributivo, RGPD, canal de denuncias, almacenamiento S3/Azure Blob, despliegue en Azure con Terraform y migración desde Factorial por API. |
| **Control horario** | Fichaje web, instalable en el móvil como aplicación (entrada, pausa, salida) con la hora del servidor, idempotente. Fichajes **inmutables**: una corrección es un evento nuevo con motivo y autoría. Cadena de hashes por relación laboral, verificación de integridad y **sellos** enviados por email. Turnos que cruzan medianoche y cambios de hora resueltos por zona horaria del centro. |
| **Turnos** | Plantillas, cuadrante semanal con borradores y publicación, avisos de descanso entre jornadas, jornada máxima y descanso semanal (ET), bolsa de horas y exceso sobre jornada. |
| **Ausencias** | Vacaciones con saldo prorrateado y ajustes, permisos del ET, bajas médicas. Circuitos de aprobación de varios pasos por sociedad y tipo (responsable, su responsable, RR. HH. o una persona concreta) y delegación por fechas. Los motivos de salud no los ve el responsable. |
| **Comunicación y firma** | Anuncios con confirmación de lectura, políticas con aceptación por versión y firma electrónica simple con código por email y hoja de evidencias. |
| **Privacidad y cumplimiento** | Descarga de mis datos y solicitudes de derechos (RGPD), plazos de conservación con purga y anonimización, canal de denuncias anónimo y cifrado (Ley 2/2023). |
| **Nóminas** | Se sube el PDF de la gestoría; OpenHR detecta el DNI/NIE de cada página y propone a quién va. **Nada se publica sin revisión humana página a página.** Cada persona descarga la suya en «Mis documentos», con acuse de lectura. |
| **Informes** | Registro de jornada en CSV (por sociedad o por persona), variables de nómina mensuales para la gestoría y registro retributivo (RD 902/2020). Cada exportación queda auditada con su huella SHA-256. |
| **Seguridad** | Aislamiento entre organizaciones con Row Level Security de PostgreSQL, rol de base de datos sin privilegios, verificación en dos pasos (TOTP), sesiones revocables, auditoría de acciones, CSP y comprobación de origen. Ver [seguridad](docs/seguridad.md). |
| **Interfaz** | Azul marino con acentos celeste, tema Claro / Oscuro / Sistema e iconos animados de AnimateIcons. Ver [diseño](docs/diseno.md). |

## Documentación

Toda la documentación está en [docs/](docs/README.md): [guía de uso](docs/guia-de-uso.md), [despliegue](docs/despliegue.md), [arquitectura](docs/arquitectura.md), [base de datos](docs/base-de-datos.md), [API](docs/api.md), [seguridad](docs/seguridad.md), [diseño](docs/diseno.md) y [desarrollo](docs/desarrollo.md).

## Puesta en marcha con Docker Compose

Requisitos: Docker con Compose v2.

```bash
git clone https://github.com/AloneX15/OpenHR.git
cd OpenHR
cp .env.example .env
# Edita .env: cambia TODAS las contraseñas y secretos y define SETUP_TOKEN (ver docs/despliegue.md)
docker compose up -d --build
```

Abre <http://localhost:3000>: la primera vez verás la **configuración inicial**, donde se crea la organización, la primera sociedad y tu cuenta de administración. Los correos (invitaciones, avisos) se capturan en Mailpit, en <http://localhost:8025>, hasta que configures un SMTP real en `.env`.

Servicios:

| Servicio | Qué es |
| --- | --- |
| `db` | PostgreSQL 17 (volumen `db-data`). Expuesto solo en `127.0.0.1:5433`. |
| `migrate` | Aplica las migraciones con el rol propietario y termina. |
| `api` | API NestJS (`/api`), conectada con el rol `openhr_app`, sujeto a RLS. Ficheros en el volumen `storage`. |
| `web` | Next.js en el puerto 3000; reenvía `/api/*` a la API (mismo origen). |
| `mailpit` | SMTP de pruebas. Quítalo en producción. |

Para producción: pon OpenHR detrás de un proxy HTTPS (Caddy, Traefik, nginx), ajusta `PUBLIC_URL` a la URL pública exacta (las peticiones de otro origen se rechazan) y `SECURE_COOKIES=true`. Haz copia de seguridad de los volúmenes `db-data` y `storage`.

## Migrar desde Factorial

**Organización → Migrar desde Factorial** importa sociedades, centros, equipos, personas, contratos, ausencias y fichajes con la API de Factorial (simulación primero, repetible sin duplicar). Ver [migración desde Factorial](docs/migracion-factorial.md).

## Azure

`infra/azure` despliega OpenHR en Azure Container Apps con PostgreSQL privado y Blob Storage. Ver [despliegue en Azure](docs/despliegue-azure.md). GitHub Actions ejecuta los tests y publica las imágenes en GHCR en cada push a `main`.

## Desarrollo

```bash
npm install
docker compose -f docker-compose.test.yml up -d   # PostgreSQL de pruebas en el puerto 5434
npm test                                          # 89 tests: unitarios + integración contra PostgreSQL
```

Para trabajar en local con recarga en caliente, arranca solo la base de datos (`docker compose up -d db`), aplica migraciones (`MIGRATION_DATABASE_URL=... npm run db:migrate` tras `npm run build -w apps/api`) y lanza `npm run dev:api` y `npm run dev:web` con las variables de `.env.example`.

Estructura:

```
apps/api      API NestJS + PostgreSQL (SQL directo con pg, migraciones en apps/api/migrations)
apps/web      Interfaz Next.js (App Router)
docs/adr      Decisiones de arquitectura
```

## Alcance del MVP piloto

Criterio de salida: el grupo piloto ficha y pide vacaciones durante un mes completo y la gestoría cierra una nómina con la exportación de OpenHR.

V1.1 en curso: inicio de sesión con Microsoft 365, kiosco de fichaje, geolocalización y fichaje sin conexión hechos. Ya hecho de la V1: turnos con reglas de descanso, bolsa de horas, aprobaciones multinivel y delegación, checklists de alta, baja y traspaso, campos personalizados, anuncios, políticas, firma individual, registro retributivo, RGPD, canal de denuncias, almacenamiento S3/Azure Blob, despliegue en Azure con Terraform y migración desde Factorial por API. Para la V1.1: kiosco, geolocalización y el resto.

## Trabajo con agentes de IA

El repositorio incluye las [skills de Matt Pocock](https://github.com/mattpocock/skills) (MIT) en `.claude/skills/`, configuradas para este proyecto con `CLAUDE.md`, `GLOSSARY.md` (vocabulario del dominio) y `docs/agents/` (GitHub Issues y etiquetas de triaje). Ver [desarrollo](docs/desarrollo.md#agentes-de-ia).

## Licencia

Pendiente de decidir (AGPL-3.0 o Apache-2.0).
