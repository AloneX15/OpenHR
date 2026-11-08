# Base de datos

OpenHR usa **PostgreSQL 17** con SQL directo (sin ORM). El esquema vive en `apps/api/migrations/*.sql`, que se aplican en orden alfabético con `apps/api/src/db/migrate.ts`.

## Roles de base de datos

| Rol | Para qué | Privilegios |
| --- | --- | --- |
| Propietario (`POSTGRES_OWNER_USER`, por defecto `openhr_owner`) | Ejecutar migraciones. | Dueño de tablas y funciones. En la imagen oficial de PostgreSQL es superusuario. |
| `openhr_app` | Conexión de la API. Lo crea `migrate.ts` con la contraseña `OPENHR_APP_DB_PASSWORD`. | `LOGIN NOSUPERUSER NOBYPASSRLS`. Lectura y escritura en tablas, salvo las append-only (solo lectura e inserción). Sujeto a RLS. |

## Aislamiento entre organizaciones (RLS)

- La función `app_tenant_id()` devuelve `current_setting('app.tenant_id')` como `uuid`, o `NULL` si no está fijado.
- `enable_tenant_rls(tabla)` activa RLS y crea la política `tenant_isolation`: `USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id())`.
- La API fija el contexto en cada transacción con `set_config('app.tenant_id', $1, true)` y `set_config('app.user_id', $2, true)` (`Db.tx()` en `apps/api/src/db/db.service.ts`).
- Un test de integración falla si alguna tabla con columna `tenant_id` no tiene RLS.

Más detalle en [ADR 0001](adr/0001-tenancy-rls.md).

## Diagrama entidad-relación

```mermaid
erDiagram
  tenant ||--o{ company : tiene
  company ||--o{ work_center : tiene
  company ||--o{ department : tiene
  tenant ||--o{ person : tiene
  person ||--o| app_user : "accede con"
  app_user ||--o{ role_assignment : tiene
  company |o--o{ role_assignment : "limita a"
  person ||--o{ employment : "trabaja en"
  company ||--o{ employment : emplea
  work_center |o--o{ employment : ubica
  department |o--o{ employment : agrupa
  employment |o--o{ employment : "responsable de"
  employment ||--o{ time_entry : ficha
  time_entry |o--o| time_entry : anula
  company ||--o{ time_chain_seal : sella
  employment ||--o{ absence_request : solicita
  absence_type ||--o{ absence_request : clasifica
  employment ||--o{ vacation_adjustment : ajusta
  person ||--o{ document : recibe
  stored_file ||--o{ document : contiene
  company ||--o{ payslip_batch : sube
  stored_file ||--o{ payslip_batch : original
  payslip_batch ||--o{ payslip_page : divide
  person |o--o{ payslip_page : "asignada a"
  company |o--o{ holiday : "festivo de"
  work_center |o--o{ holiday : "festivo de"
  app_user ||--o{ notification : recibe
```

## Tablas

Convenciones: claves primarias `uuid` generadas con `gen_random_uuid()` (salvo `audit_event` y `outbox`, `bigserial`); marcas de tiempo `timestamptz` en UTC; fechas civiles `date` (la API las devuelve como texto `AAAA-MM-DD`); toda tabla de negocio lleva `tenant_id` con RLS.

### Organización

#### `tenant`
Instalación lógica: normalmente un grupo de empresas. Solo se crea con `setup_create_tenant()`.

| Columna | Tipo | Notas |
| --- | --- | --- |
| `id` | uuid | PK |
| `name` | text | Nombre del grupo |
| `created_at` | timestamptz | |

RLS: política `tenant_self` (`id = app_tenant_id()`). La app no puede insertar ni borrar.

#### `company` — sociedad
| Columna | Tipo | Notas |
| --- | --- | --- |
| `id`, `tenant_id` | uuid | |
| `name` | text | Nombre corto |
| `legal_name` | text | Razón social |
| `tax_id` | text | CIF. Único por tenant |
| `ccc` | text? | Código de cuenta de cotización |
| `address` | text? | |

#### `work_center` — centro de trabajo
| Columna | Tipo | Notas |
| --- | --- | --- |
| `company_id` | uuid | FK `company` |
| `name` | text | |
| `timezone` | text | IANA, por defecto `Europe/Madrid`. Decide a qué día cuenta cada fichaje |
| `region` | text? | Comunidad autónoma (ISO 3166-2:ES) |
| `address` | text? | |

#### `department`
`company_id`, `name` (único por sociedad).

#### `holiday` — festivos
| Columna | Tipo | Notas |
| --- | --- | --- |
| `company_id` | uuid? | Festivo de una sociedad |
| `work_center_id` | uuid? | Festivo local de un centro |
| `date` | date | |
| `name` | text | |

Sin sociedad ni centro = festivo de todo el grupo (los nacionales se cargan solos para el año actual y el siguiente).

#### `absence_type` — tipos de ausencia
| Columna | Tipo | Notas |
| --- | --- | --- |
| `code` | text | Único por tenant (`VAC`, `AP`, `IT`, `MAT`, `FAM`, `FALL`, `MUD`, `DEB`, `NR` de partida) |
| `name` | text | |
| `paid` | boolean | Retribuido |
| `counts_as_vacation` | boolean | Descuenta del saldo de vacaciones |
| `requires_approval` | boolean | Si es `false`, queda aprobada al registrarla (p. ej. IT) |
| `day_unit` | text | `working` (laborables) o `calendar` (naturales) |
| `sensitive` | boolean | Dato de salud: el responsable no ve el tipo ni el comentario |
| `active` | boolean | |

### Personas y accesos

#### `person` — persona física
`first_name`, `last_name`, `national_id` (DNI/NIE, único por tenant), `email`, `phone`, `birth_date`. Una persona puede tener varias relaciones laborales en el grupo.

#### `app_user` — cuenta de acceso
| Columna | Tipo | Notas |
| --- | --- | --- |
| `person_id` | uuid? | FK `person` |
| `email` | text | Único en toda la instalación (`lower(email)`) para iniciar sesión sin elegir organización |
| `password_hash` | text? | bcrypt (coste 12). `NULL` hasta aceptar la invitación |
| `totp_secret` | text? | Secreto TOTP cifrado con AES-256-GCM (`ENCRYPTION_KEY`) |
| `totp_enabled` | boolean | |
| `is_active` | boolean | |
| `session_version` | integer | Se incrementa por trigger al cambiar contraseña, MFA, email o al desactivar: revoca las sesiones |
| `last_login_at` | timestamptz? | |

Columnas añadidas en la migración 019: `scim_external_id` (identificador en Entra ID, único por organización) y `updated_at`. Una cuenta creada por SCIM puede no tener `person_id` hasta que RR. HH. da de alta la ficha con el mismo email.

#### `scim_token`
Tokens de SCIM de la organización: `label`, `token_hash` (SHA-256), `last_used_at` y `revoked_at`.

#### `role_assignment`
| Columna | Tipo | Notas |
| --- | --- | --- |
| `user_id` | uuid | |
| `company_id` | uuid? | `NULL` = todo el tenant |
| `role` | text | `admin` o `hr` |

Ser empleado o responsable no necesita fila: se deriva de `employment`.

#### `employment` — relación laboral
| Columna | Tipo | Notas |
| --- | --- | --- |
| `person_id`, `company_id` | uuid | |
| `work_center_id`, `department_id` | uuid? | Deben ser de la misma sociedad (lo comprueba la API) |
| `manager_employment_id` | uuid? | Responsable directo (otra relación laboral) |
| `employee_number`, `job_title`, `contract_type` | text? | |
| `start_date`, `end_date` | date | `end_date` nula = vigente |
| `weekly_minutes` | integer | Jornada semanal |
| `schedule` | jsonb | Minutos de jornada teórica por día ISO: `{"1":480,…,"7":0}` |
| `vacation_days_per_year` | numeric(5,1) | Días laborables al año (prorrateados el primer y último año) |
| `time_chain_head`, `time_chain_seq` | text, bigint | Cabeza de la cadena de fichajes |

### Ciclo de vida y campos personalizados

#### `checklist_template` y `checklist_template_item`
Plantillas de alta (`onboarding`), baja (`offboarding`) o traspaso (`transfer`), de una sociedad o generales (`company_id` nulo). Cada tarea tiene `title`, `description`, `assignee` (`hr`, `manager` o `employee`) y `due_offset_days` respecto a la fecha del alta, baja o traspaso.

#### `checklist` y `checklist_task`
Checklist de una relación laboral (`kind`, `name`, `reference_date`, `status` `open`/`done`/`cancelled`) y sus tareas (`due_date`, `done_at`, `done_by`, `note`). Se crean solos al dar de alta, dar de baja o traspasar si hay una plantilla activa (la de la sociedad o, si no, la general).

#### `custom_field`
Definición de un campo propio: `entity` (`person` o `employment`), `key` (única, `^[a-z][a-z0-9_]+$`), `label`, `type` (`text`, `number`, `date`, `boolean`, `select` con `options`), `required`, `visibility` (`hr`, `manager` o `employee`), `position`, `active`. Los valores se guardan en la columna `custom_values` (jsonb) de `person` o `employment`, validados por la API.

`employment.transferred_from_employment_id` enlaza la relación laboral nueva de un traspaso con la anterior.

### Registro de jornada

#### `time_entry` — fichajes (append-only)
| Columna | Tipo | Notas |
| --- | --- | --- |
| `employment_id` | uuid | |
| `seq` | bigint | Posición en la cadena. Único por relación laboral |
| `kind` | text | `in`, `out`, `break_start`, `break_end`, `void` |
| `occurred_at` | timestamptz | Hora del servidor (fichaje real) o declarada (manual) |
| `recorded_at` | timestamptz | Cuándo se registró |
| `device_time` | timestamptz? | Hora que decía el dispositivo (informativa) |
| `source` | text | `clock`, `manual`, `import` |
| `voids_entry_id` | uuid? | Fichaje que anula (solo `void`; un fichaje solo se anula una vez) |
| `reason` | text? | Obligatorio salvo `source = clock` |
| `created_by` | uuid | Usuario que lo registró |
| `idempotency_key` | text? | Único por tenant: reintentos sin duplicados |
| `content_digest`, `prev_hash`, `hash` | text | Cadena: `hash = sha256(prev_hash ‖ content_digest)` |

Protecciones: el rol `openhr_app` no tiene `UPDATE` ni `DELETE`, y los triggers `time_entry_no_update` y `time_entry_no_truncate` lo impiden incluso al propietario. Ver [ADR 0002](adr/0002-time-entry-hash-chain.md).

Columnas añadidas en la migración 015: `channel` (`web`, `kiosk`, `offline`, `import`), `kiosk_device_id`, `latitude`, `longitude`, `accuracy_m` e `inside_zone`. Cuando tienen valor entran en la huella del eslabón. `source` admite además `offline` (fichaje hecho sin conexión y enviado después). En `work_center`: `latitude`, `longitude`, `radius_m` y `geo_policy` (`off`, `record`, `require`); en `employment`: `remote_allowed`, `kiosk_code` y `kiosk_pin_hash` (bcrypt). Tabla `kiosk_device`: centro, nombre y hash del token del dispositivo.

#### `time_chain_seal` — sellos (append-only)
`company_id`, `sealed_at`, `heads` (jsonb `{employment_id: {seq, hash}}`), `digest` (SHA-256), `sent_to` (emails).

### Turnos y bolsa de horas

#### `shift_template` — plantilla de turno
`company_id`, `name` (único por sociedad), `start_time`, `end_time` (si es anterior o igual a la entrada, el turno acaba al día siguiente), `break_minutes`, `color` (`sky`, `navy`, `teal`, `amber`, `violet`, `rose`, `slate`), `active`.

#### `shift_assignment` — turno asignado
| Columna | Tipo | Notas |
| --- | --- | --- |
| `employment_id`, `date` | | Único por relación laboral y fecha (fecha local de inicio) |
| `shift_template_id` | uuid? | Plantilla de la que sale (o turno a medida) |
| `is_day_off` | boolean | Día libre planificado |
| `start_at`, `end_at` | timestamptz? | Obligatorios salvo día libre |
| `break_minutes` | integer | Pausa no computable |
| `published_at` | timestamptz? | `NULL` = borrador. Solo los publicados cuentan como jornada teórica y los ve la persona |

Un turno publicado sustituye a la jornada semanal ese día, aunque sea festivo.

#### `hour_bank_adjustment`
Movimientos manuales de la bolsa: `date`, `minutes` (positivo o negativo), `kind` (`opening` saldo inicial, `paid` horas pagadas en nómina, `adjustment`), `reason`.

Columnas añadidas: `employment.hour_bank_enabled` y `hour_bank_start`; `absence_type.consumes_hour_bank` (el tipo `COMP`, «Compensación de horas», viene creado); y en `company` las reglas de jornada: `min_rest_between_shifts_minutes` (720), `max_daily_ordinary_minutes` (540), `min_weekly_rest_minutes` (2160) y `max_yearly_overtime_minutes` (4800).

### Ausencias

#### `absence_request`
| Columna | Tipo | Notas |
| --- | --- | --- |
| `employment_id`, `absence_type_id` | uuid | |
| `start_date`, `end_date` | date | Inclusive |
| `days` | numeric(5,1) | Calculados al solicitar con la jornada y los festivos |
| `status` | text | `pending`, `approved`, `rejected`, `cancelled` |
| `comment`, `decision_comment` | text? | |
| `requested_by`, `decided_by`, `decided_at` | | |

#### `approval_flow` — circuito de aprobación
`company_id` y `absence_type_id` (ambos opcionales; único por combinación, con `NULLS NOT DISTINCT`) y `steps`: lista JSON de 1 a 5 pasos `{"kind": "manager" | "manager_of_manager" | "hr" | "admin" | "user", "userId"?}`. Se aplica el más específico; sin ninguno, un paso: el responsable directo. Las ausencias sensibles las aprueba siempre RR. HH.

#### `approval_step` — pasos de cada solicitud
| Columna | Tipo | Notas |
| --- | --- | --- |
| `request_id`, `step_index` | | Único por solicitud y posición |
| `kind`, `target_user_id` | | Copia del paso del circuito al crear la solicitud |
| `approver_user_ids` | uuid[] | Aprobadores resueltos al activar el paso (nunca quien solicita) |
| `status` | text | `waiting`, `pending` (paso actual), `approved`, `rejected`, `skipped` (sin aprobadores), `cancelled` |
| `decided_by`, `decided_as`, `decided_at`, `comment` | | `decided_as`: `approver`, `delegate` o `hr` (RR. HH. resuelve la solicitud entera) |

`absence_request.current_step` apunta al paso pendiente. Si ningún paso tiene aprobadores, se añade uno de RR. HH. y, en último caso, de administración.

#### `approval_delegation`
`from_user_id`, `to_user_id` (distintos), `start_date`, `end_date`, `reason`. Mientras está vigente, `to_user_id` puede resolver los pasos de `from_user_id` y recibe sus avisos.

#### `vacation_adjustment`
Ajustes manuales del saldo por año (`days` positivo o negativo, `reason` obligatorio).

### Documentos y nóminas

#### `stored_file`
Metadatos de un fichero guardado en el almacenamiento (disco en el MVP): `storage_key`, `filename`, `content_type`, `size_bytes`, `sha256` (se comprueba al leer).

#### `document` — «Mis documentos»
`person_id`, `company_id`, `file_id`, `category` (`payslip`, `contract`, `certificate`, `other`), `title`, `period` (`AAAA-MM`), `batch_id`, `published_at`, `first_read_at` (acuse de lectura: primera descarga de la propia persona).

#### `payslip_batch`
Un PDF con las nóminas de una sociedad y un mes: `period`, `file_id`, `page_count`, `status` (`review`, `published`, `discarded`), `published_by`, `published_at`.

#### `payslip_page`
Una fila por página: `detected_ids` (DNI/NIE válidos encontrados), `suggested_person_id`, `person_id`, `review_status` (`pending`, `confirmed`, `skipped`). Una página confirmada debe tener persona; el lote no se publica con páginas pendientes.

### Retribución

#### `compensation`
Retribución anual pactada de una relación laboral desde `effective_from` (única por fecha): `base_annual` (salario base), `complements_annual` (complementos salariales) y `extra_salary_annual` (percepciones extrasalariales), brutos anuales a la jornada real. Dato salarial: solo RR. HH.; la auditoría registra los cambios sin importes.

Columnas añadidas: `person.sex` (`female`, `male`, `other` o nulo; lo ven RR. HH. y la persona), `employment.professional_group` (grupo, categoría o nivel del convenio) y `company.full_time_weekly_minutes` (jornada completa de referencia, 2400 por defecto).

### Gastos

#### `expense_category`
Categorías del grupo: `kind` `amount` (importe del ticket) o `mileage` (con `rate_cents_per_km`; 26 céntimos por defecto, el importe exento de IRPF), `limit_cents` (aviso, no bloquea), `requires_receipt` y `active`. Cada grupo empieza con Comidas, Transporte, Alojamiento, Kilometraje y Otros.

#### `expense`
Un gasto de una relación laboral: fecha, concepto, `amount_cents`, `km`, `receipt_file_id` (en `stored_file`), `status` (`pending`, `approved`, `rejected`, `paid`, `cancelled`) y `stage` (`manager` o `hr`, solo mientras está pendiente). Guarda quién decidió en cada paso, el comentario y el mes de nómina en que se abonó (`paid_period`).

### Encuestas

#### `survey`
Encuesta de una sociedad (o de todo el grupo si `company_id` es NULL): `title`, `description`, `anonymous`, `min_responses` (mínimo para enseñar resultados de una anónima), `status` (`draft`, `open`, `closed`) y `closes_on`.

#### `survey_question`
`position`, `kind` (`scale` 1–5, `enps` 0–10, `choice` con `options`, `text`) y `required`.

#### `survey_participation`
Quién ha respondido, para no responder dos veces. Sin hora ni enlace con la respuesta.

#### `survey_response`
`answers` (objeto pregunta → valor) y `submitted_on` (solo el día). `user_id` solo en las encuestas con nombre.

### Consultas a RR. HH.

#### `ticket_category`
Temas de consulta del grupo. Cada grupo empieza con Nómina, Contrato y documentos, Certificados, Vacaciones y ausencias, Datos personales y Otros.

#### `ticket`
`number` (correlativo), `company_id`, `requester_user_id`, `category_id`, `subject`, `status` (`open`, `in_progress`, `waiting`, `resolved`, `closed`), `priority` (`normal`, `high`), `assignee_user_id` y `resolved_at`.

#### `ticket_message`
Mensajes de la conversación con `internal` (nota solo para RR. HH.) y `file_id` opcional.

### Comunicación y firma

#### `announcement` y `announcement_read`
Anuncios de una sociedad o de todo el grupo (`company_id` nulo): `title`, `body`, `pinned`, `published_at`, `expires_at`, `archived`. `announcement_read` guarda quién lo leyó y cuándo.

#### `policy` y `policy_acceptance`
Políticas internas en PDF (`file_id`), por sociedad o del grupo. `series_id` agrupa las versiones de una misma política (`version` única por serie); publicar una versión archiva la anterior y obliga a aceptarla de nuevo. La aceptación guarda persona, usuario, fecha, IP, navegador y el SHA-256 del fichero aceptado.

#### `signature_request`
Solicitud de firma de un PDF a una persona: `title`, `message`, `file_id`, `status` (`pending`, `signed`, `declined`, `cancelled`), `due_date`. El código de un solo uso se guarda como hash (`otp_hash`, `otp_expires_at`, `otp_attempts`, máximo 5). Al firmar: `signed_file_id` (PDF con hoja de evidencias), `document_id` (copia en «Mis documentos», categoría `signed`) y `evidence` (jsonb con firmante, DNI/NIE, email, fecha, IP, navegador, método, declaración y huellas del original y del firmado).

`document.category` admite además `policy` y `signed`.

### Privacidad y canal de denuncias

#### `privacy_request`
Solicitudes de derechos del RGPD: `kind` (`access`, `rectification`, `erasure`, `restriction`, `portability`, `objection`), `details`, `status` (`received`, `in_progress`, `completed`, `rejected`), `due_date` (un mes, ampliable dos), `response`, `handled_by`.

#### `retention_setting`, `retention_run` y `time_chain_checkpoint`
Plazos de conservación en días por categoría (`time_entries` ≥ 1461, `former_employees` ≥ 1461, `audit`, `notifications`, `outbox`) y registro de cada ejecución. Al purgar fichajes se guarda por relación laboral el último eslabón purgado (`seq`, `hash`) para que la cadena siga verificándose. `person.anonymized_at` marca a quien se ha anonimizado.

La purga de fichajes solo puede hacerla la función `retention_purge_time_entries(tenant, antes_de)` (`SECURITY DEFINER`): exige el tenant de la sesión y una fecha de al menos 4 años atrás, y el trigger de inmutabilidad solo admite el borrado durante esa función.

#### `wb_report` y `wb_message`
Canal interno de información (Ley 2/2023). Asunto, descripción, contacto, resolución y mensajes se guardan **cifrados** (AES-256-GCM con `ENCRYPTION_KEY`). El informante se identifica solo por el hash de su código de seguimiento (`code_hash`). Plazos: `ack_due` (7 días) y `resolution_due` (3 meses, ampliable a 6). `tenant.whistleblowing_token` es el identificador público del canal y `wb_tenant_by_token()` lo resuelve sin sesión. Rol nuevo en `role_assignment`: `compliance` (Responsable del Sistema).

### Migraciones

`migration_mapping` relaciona cada identificador externo (`source` = `factorial`, `entity`, `external_id`) con el de OpenHR para poder repetir la migración. `migration_job` guarda cada ejecución: opciones, estado, recuentos y registro (nunca la clave de API).

### Sistema

#### `audit_event` (append-only)
`actor_id`, `action` (p. ej. `employee.created`, `time.voided`, `export.time_register`), `entity`, `entity_id`, `data` (jsonb), `created_at`.

#### `notification`
Bandeja de cada usuario: `type`, `title`, `body`, `link`, `read_at`.

#### `push_subscription`
Un navegador o dispositivo con avisos push activados: `user_id`, `endpoint` (único por organización), claves `p256dh` y `auth`, `user_agent` y `last_used_at`.

#### `chat_webhook`
Canal de Slack o Teams: `provider`, `label`, `company_id` (NULL = todas), `url_enc` (URL del webhook cifrada con `ENCRYPTION_KEY`), `url_hint` (su dominio), `events`, `enabled`, `last_sent_at` y `last_error`.

#### `outbox`
Cola transaccional de emails: `type`, `payload`, `attempts`, `last_error`, `available_at`, `processed_at`. Al enviarse, el cuerpo se borra y solo quedan destinatario y asunto.

#### `schema_migrations`
`name`, `checksum`, `applied_at`. Una migración aplicada no puede cambiar (el checksum lo detecta).

## Funciones `SECURITY DEFINER`

Son las únicas puertas que cruzan organizaciones. Todas tienen `search_path` fijo y `EXECUTE` revocado a `PUBLIC`.

| Función | Uso |
| --- | --- |
| `auth_find_user(email)` | Inicio de sesión y recuperación de contraseña |
| `auth_session_check(user_id, tenant_id)` | Validar en cada petición que la cuenta está activa y la versión de sesión |
| `setup_create_tenant(name)` | Configuración inicial; falla si ya existe algún tenant |
| `setup_is_done()` | ¿Está configurada la instalación? |
| `outbox_claim(limit)` | Reservar emails pendientes (`FOR UPDATE SKIP LOCKED`, arrendamiento de 5 min) |
| `outbox_finish(id, error)` | Marcar enviado (y borrar el cuerpo) o programar reintento con espera exponencial |
| `oidc_provider_by_domain(domain)` | Proveedor OpenID Connect activo para el dominio de un email, antes de iniciar sesión |
| `kiosk_by_token_hash(hash)` | Organización y kiosco de un token de dispositivo activo |
| `scim_token_lookup(hash)` | Organización de un token de SCIM no revocado, antes de tener contexto de tenant |

## Migraciones

| Fichero | Contenido |
| --- | --- |
| `001_core.sql` | Tenant, sociedades, centros, departamentos, personas, usuarios, roles, relaciones laborales, festivos, auditoría, notificaciones, outbox |
| `002_time_tracking.sql` | Fichajes inmutables y sellos |
| `003_absences.sql` | Tipos y solicitudes de ausencia, ajustes de vacaciones |
| `004_documents.sql` | Ficheros, documentos, lotes y páginas de nómina |
| `005_security.sql` | RLS, permisos del rol de aplicación y funciones definer |
| `006_session_hardening.sql` | Versión de sesión, comprobación de sesión y borrado del cuerpo de los emails enviados |
| `007_shifts_hour_bank.sql` | Turnos, reglas de descanso por sociedad y bolsa de horas |
| `008_approvals.sql` | Circuitos de aprobación, pasos por solicitud y delegaciones |
| `009_lifecycle_custom_fields.sql` | Checklists de alta, baja y traspaso, traspasos y campos personalizados |
| `010_communication_signature.sql` | Anuncios, políticas con aceptación y firma individual |
| `011_pay_register.sql` | Sexo, grupo profesional, jornada completa de referencia y retribuciones |
| `012_privacy_whistleblowing.sql` | Derechos RGPD, conservación y purga de fichajes con punto de control, canal de denuncias cifrado |
| `013_migration_jobs.sql` | Correspondencias y ejecuciones de migraciones desde otros sistemas |
| `014_oidc.sql` | Proveedor OpenID Connect por organización (`oidc_provider`, secreto cifrado) y `oidc_provider_by_domain()` |
| `015_kiosk_geo_offline.sql` | Kioscos, PIN y código de kiosco, zona de fichaje por centro, teletrabajo permitido y contexto del fichaje (canal, kiosco, posición) |
| `016_expenses.sql` | Categorías de gasto (con las de partida para cada grupo) y gastos con justificante y aprobación |
| `017_web_push.sql` | Suscripciones push por navegador y redacción del outbox también para los push enviados |
| `018_chat_webhooks.sql` | Canales de Slack y Teams (`chat_webhook`) con la URL cifrada |
| `019_scim.sql` | Tokens de SCIM, `app_user.scim_external_id` y `updated_at`, y `scim_token_lookup()` |
| `020_surveys.sql` | Encuestas, preguntas, participación y respuestas (anónimas o con nombre) |
| `021_tickets.sql` | Consultas a RR. HH.: temas (con los de partida), consultas y mensajes |

Para añadir una tabla: crea `00N_nombre.sql`, incluye `tenant_id uuid NOT NULL REFERENCES tenant(id)` y llama a `SELECT enable_tenant_rls('nombre')`. Nunca edites una migración ya aplicada.

## Retención (pendiente para la V1)

El registro de jornada se conserva 4 años. La purga por periodos sellados y la anonimización se describen en [ADR 0002](adr/0002-time-entry-hash-chain.md).
