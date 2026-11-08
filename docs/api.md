# API REST

Todas las rutas cuelgan de `/api`. La web las llama en su mismo origen (Next.js reenvía `/api/*` a la API), así que la cookie de sesión funciona sin CORS.

## Convenciones

- **Autenticación:** cookie `openhr_session` (JWT HS256, `HttpOnly`, `SameSite=Lax`, `Secure` con HTTPS). Salvo las marcadas como públicas, toda ruta exige sesión. En cada petición se comprueba que la cuenta sigue activa y que la sesión no se ha revocado.
- **Origen:** las peticiones que modifican datos y traen cabecera `Origin` deben venir de `PUBLIC_URL`; si no, responden `403`.
- **Cuerpos:** JSON (`Content-Type: application/json`), salvo las subidas de ficheros (`multipart/form-data`, campo `file`). Los campos desconocidos se ignoran.
- **Fechas:** `AAAA-MM-DD` (fecha civil), `AAAA-MM` (periodo), ISO 8601 para instantes.
- **Errores:** `{ "message": "…", "issues"?: [{ "path", "message" }] }`. Códigos: `400` datos no válidos, `401` sin sesión, `403` sin permiso, `404`, `409` conflicto (duplicado, estado), `429` demasiados intentos.

## Permisos

| Rol | Cómo se obtiene | Alcance |
| --- | --- | --- |
| Empleado/a | Tener una relación laboral | Sus propios datos |
| Responsable | Ser `manager_employment_id` de otra relación | Sus reportes directos (lectura, aprobar ausencias no sensibles) |
| RR. HH. | `role_assignment` `hr`, en una sociedad o en todas | Personas, fichajes, ausencias, documentos y exportaciones de esas sociedades |
| Administración | `role_assignment` `admin` | Todo el tenant, sociedades, permisos y auditoría |

En la tabla: **P** = pública, **S** = cualquier sesión, **E** = la propia persona, **R** = responsable, **H** = RR. HH. de la sociedad, **A** = administración.

## Sistema y acceso

| Método y ruta | Quién | Descripción |
| --- | --- | --- |
| `GET /health` | P | Estado de la API y de la base de datos |
| `GET /setup/status` | P | `{ done, tokenRequired }` |
| `POST /setup` | P (solo si no está configurada) | Crea organización, primera sociedad, centro y cuenta de administración. Si hay `SETUP_TOKEN`, exige `setupToken` |
| `POST /auth/login` | P | `{ email, password }` → cookie, o `{ mfaRequired, challenge }` |
| `POST /auth/mfa` | P | `{ challenge, code }` → cookie |
| `POST /auth/logout` | P | Borra la cookie |
| `POST /auth/forgot` | P | `{ email }`. Siempre responde `ok` (no revela si existe) |
| `POST /auth/set-password` | P | `{ token, password }` para invitación o recuperación; un solo uso |
| `POST /auth/oidc/lookup` | P | `{ email }` → `{ sso, label?, enforce? }` |
| `GET /auth/oidc/start?email=` | P | Redirige al proveedor (código de autorización con PKCE, `state` y `nonce` en cookie firmada de 10 min) |
| `GET /auth/oidc/callback` | P | Valida el ID token (firma JWKS, emisor, audiencia, caducidad, nonce, dominio) y abre sesión en la cuenta con ese email |
| `GET /auth/oidc/config`, `PUT /auth/oidc/config` | A | `{ label, issuer, clientId, clientSecret?, domains, enabled, enforce }` |
| `GET /auth/me` | S | Perfil, roles y relaciones laborales vigentes |
| `POST /auth/password` | S | `{ current, next }`. Revoca las demás sesiones |
| `POST /auth/mfa/setup` | S | Genera secreto TOTP y URL `otpauth://` |
| `POST /auth/mfa/enable` | S | `{ code }` |
| `POST /auth/mfa/disable` | S | `{ password }` |
| `GET /notifications` | S | Últimas 50 notificaciones |
| `POST /notifications/:id/read`, `POST /notifications/read-all` | S | Marcar como leídas |

## Avisos push

| Método y ruta | Quién | Descripción |
| --- | --- | --- |
| `GET /notifications/push` | Todos | `{ enabled, publicKey, devices }`: si el servidor tiene claves VAPID y mis dispositivos suscritos |
| `POST /notifications/push/subscriptions` | Todos | La suscripción del navegador (`{ endpoint, keys: { p256dh, auth } }`). Solo servicios de push conocidos |
| `DELETE /notifications/push/subscriptions` | Todos | `{ endpoint? }`: quita ese navegador (o todos los míos) |

Cada aviso de la bandeja se envía también a los dispositivos suscritos a través del outbox. Si el servicio responde 404 o 410, la suscripción se borra.

## SCIM 2.0 (`/scim/v2`)

Para el directorio de la empresa (Microsoft Entra ID), con `Authorization: Bearer <token SCIM>` y `application/scim+json`. Detalle en [SCIM con Entra ID](scim.md).

| Método y ruta | Descripción |
| --- | --- |
| `GET /scim/v2/ServiceProviderConfig`, `GET /scim/v2/ResourceTypes` | Capacidades del servidor (públicos) |
| `GET /scim/v2/Users?filter=&startIndex=&count=` | Filtros `userName eq` y `externalId eq` |
| `GET /scim/v2/Users/:id`, `POST /scim/v2/Users`, `PUT /scim/v2/Users/:id`, `PATCH /scim/v2/Users/:id` | Cuenta de acceso (`userName` = email, `active`, `externalId`, `name`) |
| `DELETE /scim/v2/Users/:id` | Desactiva la cuenta (204) |
| `GET /scim/v2/Groups` | Siempre vacío |
| `GET /scim-tokens`, `POST /scim-tokens`, `DELETE /scim-tokens/:id` | Administración (con sesión): tokens; el token se devuelve una sola vez |

## Slack y Teams (`/integrations/chat`)

Solo administración.

| Método y ruta | Descripción |
| --- | --- |
| `GET /integrations/chat` | Canales conectados (sin la URL: solo su dominio en `url_hint`), último envío y último error |
| `POST /integrations/chat`, `PATCH /integrations/chat/:id` | `{ provider: slack \| teams, label, url?, companyId?, events: [announcement, absence, welcome], enabled }`. La URL debe ser de `hooks.slack.com` o de un flujo de trabajo de Teams (`logic.azure.com`, `api.powerplatform.com`); se guarda cifrada |
| `DELETE /integrations/chat/:id` | Desconecta el canal |
| `POST /integrations/chat/:id/test` | Envía un mensaje de prueba |

Eventos: `announcement` (cada anuncio), `absence` (ausencia aprobada: nombre, tipo y fechas; nunca los tipos con datos de salud) y `welcome` (alta con incorporación desde hace una semana o futura). Se envían por el outbox, con reintentos.

## Organización (`/org`)

| Método y ruta | Quién | Descripción |
| --- | --- | --- |
| `GET /org/companies` | S | Sociedades |
| `POST /org/companies`, `PATCH /org/companies/:id` | A | Alta o edición (`name`, `legalName`, `taxId`, `ccc`, `address`). El alta crea «Sede central» |
| `GET /org/work-centers?companyId=` | S | Centros |
| `POST /org/work-centers`, `PATCH /org/work-centers/:id` | H | `name`, `timezone` (IANA), `region`, `address` |
| `GET /org/departments?companyId=`, `POST /org/departments` | S / H | |
| `GET /org/holidays?year=` | S | Festivos del año |
| `POST /org/holidays` | H (sociedad o centro) / A (grupo) | `{ date, name, companyId?, workCenterId? }` |
| `POST /org/holidays/national/:year` | A | Carga los nacionales del año |
| `DELETE /org/holidays/:id` | H / A | |
| `GET /org/absence-types` | S | |
| `POST /org/absence-types`, `PATCH /org/absence-types/:id` | A | `code`, `name`, `paid`, `countsAsVacation`, `requiresApproval`, `dayUnit`, `sensitive`, `active` |
| `GET /org/employees?companyId=&q=&includeInactive=` | R / H | RR. HH. ve sus sociedades; un responsable, sus reportes |
| `GET /org/employees/:id` | E / R / H | El responsable no recibe DNI, teléfono ni fecha de nacimiento |
| `POST /org/employees` | H | Alta: persona (se reutiliza por DNI o email) + relación laboral + invitación opcional |
| `PATCH /org/employees/:id` | H | Datos personales y laborales |
| `POST /org/employees/:id/terminate` | H | `{ endDate }`. Si no le queda ninguna relación vigente, desactiva la cuenta |
| `POST /org/employees/:id/invite` | H | Crea la cuenta si falta y (re)envía la invitación |
| `PUT /org/users/:userId/roles` | A | `{ admin, hrAll, hrCompanyIds }`. Siempre queda al menos un admin |
| `GET /org/audit?entity=&entityId=` | A | Últimos 200 eventos de auditoría |

## Ciclo de vida y campos personalizados

| Método y ruta | Quién | Descripción |
| --- | --- | --- |
| `GET /checklists/templates` | S | Plantillas con sus tareas |
| `POST /checklists/templates`, `PUT /checklists/templates/:id` | H (sociedad) / A o RR. HH. del grupo (generales) | `{ companyId?, kind, name, active, items: [{ title, description?, assignee, dueOffsetDays }] }` |
| `GET /checklists/tasks` | S | Mis tareas abiertas (como RR. HH., responsable o persona) |
| `POST /checklists/tasks/:id` | Quien tenga asignada la tarea / H | `{ done, note? }`. Al completar la última, el checklist queda hecho |
| `GET /org/employees/:id/checklists` | E / R / H | Checklists de la persona (la persona solo ve sus tareas) |
| `POST /org/employees/:id/checklists` | H | Inicia uno a mano: `{ templateId, referenceDate }` |
| `POST /org/employees/:id/transfer` | H de ambas sociedades | `{ companyId, effectiveDate, workCenterId?, departmentId?, managerEmploymentId?, jobTitle? }`. Cierra la relación laboral el día anterior y crea otra; sus reportes pasan a la nueva |
| `GET /org/custom-fields` | S | Definiciones |
| `POST /org/custom-fields`, `PATCH /org/custom-fields/:id` | A | La clave y la entidad no cambian una vez creadas |
| `PUT /org/employees/:id/custom-values` | H | `{ person?: { clave: valor }, employment?: { clave: valor } }`, validado por tipo |

`GET /org/employees/:id` incluye `custom_fields`: los campos que quien consulta puede ver, con su valor.

## Control horario (`/time`)

| Método y ruta | Quién | Descripción |
| --- | --- | --- |
| `GET /time/status` | S | Estado (`out`, `working`, `break`) de cada relación laboral propia |
| `POST /time/clock` | E | `{ idempotencyKey, kind?, employmentId?, deviceTime?, location?: { latitude, longitude, accuracy }, offlineAt? }`. Con `offlineAt` (fichaje hecho sin conexión, hasta 72 h antes) vale esa hora y queda como `offline`. Si el centro exige zona, se rechaza fuera de ella salvo teletrabajo permitido. Sin `kind` alterna entrada/salida. Repetir la clave devuelve el mismo fichaje (`replayed: true`) |
| `GET /kiosk/devices`, `POST /kiosk/devices`, `DELETE /kiosk/devices/:id` | H | Kioscos de un centro; al crearlo se devuelve el token una sola vez |
| `GET /kiosk/me`, `PUT /kiosk/pin`, `GET /kiosk/qr` | E | Mi código y PIN del kiosco; QR personal firmado que caduca en 60 s |
| `GET /kiosk/device`, `POST /kiosk/device/clock` | Dispositivo (cabecera `x-kiosk-token`) | Información del kiosco; fichar con `{ code, pin }` o `{ qr }` (alterna entrada y salida). 5 intentos de PIN por código cada 15 min |
| `POST /time/entries` | E / H | Fichaje olvidado: `{ employmentId, kind, date, time, reason }` (hora local del centro, no futura) |
| `POST /time/entries/:id/void` | E / H | Anula un fichaje: `{ reason }` |
| `GET /time/employments/:id?from=&to=` | E / R / H | Fichajes y resumen diario (trabajado, pausas, teórico, festivo, ausencia, incidencias). Máximo un año |
| `GET /time/employments/:id/verify` | E / R / H | Verifica la cadena de hashes |
| `GET /time/team` | R / H | Quién está trabajando ahora |
| `POST /time/seal` | H | `{ companyId }`: sella y envía la huella por email |
| `GET /time/seals?companyId=` | H | Sellos anteriores |

## Turnos y bolsa de horas

| Método y ruta | Quién | Descripción |
| --- | --- | --- |
| `GET /shifts/templates?companyId=` | S | Plantillas de turno |
| `POST /shifts/templates`, `PATCH /shifts/templates/:id` | H | `companyId`, `name`, `start`, `end` (HH:MM), `breakMinutes`, `color`, `active` |
| `GET /shifts?from=&to=&companyId=` | R / H | Cuadrante: personas que puedo planificar, turnos (también borradores) e incumplimientos de las reglas de descanso. Máximo dos meses |
| `GET /shifts/mine?from=&to=` | S | Mis turnos publicados |
| `PUT /shifts` | R / H | `{ items: [{ employmentId, date, templateId? \| start, end, breakMinutes? \| dayOff \| clear }] }`. Todo cambio vuelve a borrador |
| `POST /shifts/publish` | R / H | `{ from, to, companyId? }`: publica los borradores y avisa a cada persona |
| `PATCH /org/companies/:id/work-rules` | H | Reglas de jornada de la sociedad (minutos): descanso entre jornadas, máximo diario, descanso semanal, máximo anual de horas extra |
| `GET /time/employments/:id/hour-bank?year=` | E / R / H | Saldo de la bolsa, exceso sobre jornada por mes y del año, límite anual y movimientos |
| `POST /time/hour-bank/adjustments` | H | `{ employmentId, date, minutes, kind: opening \| paid \| adjustment, reason }` |

Las reglas comprobadas son las del Estatuto de los Trabajadores por defecto: 12 h entre jornadas (art. 34.3), 9 h de trabajo efectivo al día (art. 34.3) y día y medio de descanso semanal, acumulable en 14 días (art. 37.1). Son avisos: se puede publicar igualmente.

## Ausencias (`/absences`)

| Método y ruta | Quién | Descripción |
| --- | --- | --- |
| `GET /absences/mine` | S | Mis solicitudes |
| `GET /absences/pending` | R / H | Pendientes que puedo resolver |
| `GET /absences/team?from=&to=` | R / H | Calendario del equipo (motivos sensibles ocultos al responsable) |
| `GET /absences/balance/:employmentId?year=` | E / R / H | `{ entitled, adjustments, approved, pending, available }` |
| `POST /absences` | E / H | `{ absenceTypeId, startDate, endDate, comment?, employmentId? }`. RR. HH. la registra ya aprobada |
| `POST /absences/:id/approve`, `POST /absences/:id/reject` | Aprobador del paso actual, su delegado o H | `{ comment? }` → `{ status }`: `pending` si quedan pasos, `approved` o `rejected`. Nadie aprueba lo suyo |
| `POST /absences/:id/cancel` | E / H | La persona solo antes de que empiece |
| `POST /absences/adjustments` | H | `{ employmentId, year, days, reason }` |

## Aprobaciones (`/approvals`)

| Método y ruta | Quién | Descripción |
| --- | --- | --- |
| `GET /approvals/flows` | S | Circuitos configurados |
| `PUT /approvals/flows` | H (sociedad) / A (general) | `{ companyId?, absenceTypeId?, steps: [{ kind, userId? }] }` (crea o sustituye) |
| `DELETE /approvals/flows/:id` | H / A | |
| `GET /approvals/delegations` | S | Delegaciones recientes en las que participo (administración ve todas) |
| `POST /approvals/delegations` | S | `{ toUserId, startDate, endDate, reason? }`. Administración puede indicar `fromUserId` |
| `DELETE /approvals/delegations/:id` | Quien delega / A | |
| `GET /approvals/candidates` | S | Personas con cuenta activa (para delegar o nombrar aprobadoras) |

Las solicitudes devueltas por `/absences/mine` y `/absences/pending` incluyen `steps`: cada paso con su tipo, estado, aprobadores y quién decidió y en calidad de qué.

## Documentos y nóminas

| Método y ruta | Quién | Descripción |
| --- | --- | --- |
| `GET /documents/mine` | S | Mis documentos |
| `GET /documents/person/:personId` | H | Documentos de una persona (de mis sociedades) |
| `GET /documents/:id/download` | E / H | Descarga. La primera descarga propia registra el acuse de lectura |
| `POST /documents` | H | Multipart: `file`, `personId`, `companyId`, `category`, `title`, `period?` |
| `GET /payslips/batches` | H | Lotes |
| `POST /payslips/batches` | H | Multipart: `file` (PDF), `companyId`, `period`. Detecta DNI/NIE por página |
| `GET /payslips/batches/:id` | H | Lote con páginas y sugerencias |
| `GET /payslips/batches/:id/pages/:n/pdf` | H | Una página, para revisarla |
| `POST /payslips/batches/:id/pages/:pageId` | H | `{ status: confirmed \| skipped \| pending, personId? }` |
| `POST /payslips/batches/:id/confirm-suggestions` | H | Confirma las páginas con una única sugerencia |
| `POST /payslips/batches/:id/publish` | H | Exige todas las páginas revisadas. Une las páginas de cada persona y la avisa |
| `POST /payslips/batches/:id/discard` | H | |

## Gastos (`/expenses`)

| Método y ruta | Quién | Descripción |
| --- | --- | --- |
| `GET /expenses/categories?all=` | Todos | Categorías activas (`all=true`: también las inactivas) |
| `POST /expenses/categories`, `PATCH /expenses/categories/:id` | A o RR. HH. del grupo | `{ name, kind: amount \| mileage, rateCentsPerKm?, limitCents?, requiresReceipt, active }` |
| `POST /expenses` | E | Multipart: `employmentId, categoryId, date, description, amount` (euros, admite coma) o `km`, y el fichero `receipt` (imagen o PDF, 10 MB). El kilometraje se calcula con la tarifa. Pasa al responsable directo o, si no lo hay, a RR. HH. |
| `GET /expenses/mine` | E | Mis gastos, con `status`, `stage` y `over_limit` |
| `GET /expenses/to-approve` | R / H | Pendientes cuyo paso me toca (también por delegación) |
| `POST /expenses/:id/decision` | R / H | `{ approve, comment? }`; rechazar exige motivo. El responsable lo pasa a RR. HH.; RR. HH. lo aprueba del todo. Nadie aprueba lo suyo |
| `POST /expenses/:id/cancel` | E | Anula un gasto propio pendiente |
| `GET /expenses/:id/receipt` | E / R / H | Justificante (queda auditado si no es tuyo) |
| `GET /expenses?status=&companyId=&period=` | H | Listado |
| `GET /expenses/export?status=approved\|paid&period=` | H | CSV para la nómina |
| `POST /expenses/pay` | H | `{ ids, period }`: marca aprobados como abonados en la nómina de ese mes |

## Retribución y registro retributivo

| Método y ruta | Quién | Descripción |
| --- | --- | --- |
| `GET /pay/compensation/:employmentId` | H | Historial de retribución |
| `POST /pay/compensation` | H | `{ employmentId, effectiveFrom, baseAnnual, complementsAnnual?, extraSalaryAnnual?, note? }` (sustituye si coincide la fecha) |
| `DELETE /pay/compensation/:id` | H | |
| `GET /pay/register?companyId=&year=&groupBy=` | H | Registro retributivo: por grupo (`professional_group` o `job_title`) y en total, `women` y `men` con `n`, media y mediana de cada concepto (`base`, `complements`, `extraSalary`, `total`), brechas en % y `flagged` si alcanzan el 25 % |
| `GET /pay/register.csv?…` | H | El mismo registro en CSV |

Cálculo: personas con relación laboral en algún momento del año, con la retribución vigente a 31 de diciembre (o a su baja), equiparada a jornada completa (importe × jornada completa ÷ jornada real). Brecha = (hombres − mujeres) ÷ hombres.

## Anuncios, políticas y firma

| Método y ruta | Quién | Descripción |
| --- | --- | --- |
| `GET /announcements?archived=` | S | Anuncios de mis sociedades y del grupo, con `read` y, para RR. HH., `reads` |
| `POST /announcements` | H (sociedad) / A o RR. HH. del grupo (grupo) | `{ companyId?, title, body, pinned, expiresAt?, notify }`. Avisa en la app y, si `notify`, por email |
| `PATCH /announcements/:id` | Igual | `title`, `body`, `pinned`, `archived`, `expiresAt` |
| `POST /announcements/:id/read` | S | Marcar como leído |
| `GET /policies` | S | Políticas vigentes con mi `accepted_at` |
| `POST /policies` | H / A | Multipart: `file` (PDF), `title`, `description?`, `requiresAcceptance`, `companyId?` o `seriesId` (nueva versión) |
| `GET /policies/:id/file` | S (de su ámbito) | PDF |
| `POST /policies/:id/accept` | S | Registra la aceptación con la huella del fichero |
| `GET /policies/:id/acceptances` | H | Quién la ha aceptado y quién falta |
| `GET /signatures/mine`, `GET /signatures` | S / H | Mis firmas / solicitudes de mis sociedades |
| `POST /signatures` | H | Multipart: `file` (PDF), `personId`, `companyId`, `title`, `message?`, `dueDate?` |
| `GET /signatures/:id/file?signed=` | Firmante / H | Original o firmado |
| `POST /signatures/:id/code` | Firmante | Envía un código de 6 dígitos al email (10 min) |
| `POST /signatures/:id/sign` | Firmante | `{ code, consent: true }`. Cinco intentos por código |
| `POST /signatures/:id/decline` | Firmante | `{ reason }` |
| `POST /signatures/:id/cancel` | H | Solo pendientes |
| `GET /signatures/:id/evidence` | Firmante / H | Evidencias de la firma |

## Privacidad (RGPD)

| Método y ruta | Quién | Descripción |
| --- | --- | --- |
| `GET /privacy/my-data` | S | JSON con todos mis datos (acceso y portabilidad) |
| `GET /privacy/requests/mine`, `POST /privacy/requests` | S | Mis solicitudes; `{ kind, details }` |
| `GET /privacy/requests` | H / A | Solicitudes (RR. HH., de personas de sus sociedades) |
| `POST /privacy/requests/:id` | H / A | `{ status, response?, extendDays? }` |
| `GET /privacy/retention`, `PUT /privacy/retention` | S / A | Plazos de conservación en días |
| `POST /privacy/retention/run` | A | `{ dryRun }`: cuenta o aplica (fichajes, notificaciones, emails enviados, anonimización de antiguas personas) |
| `POST /privacy/anonymize/:personId` | A | Anonimiza ya a una persona sin relación vigente |

## Canal de denuncias

| Método y ruta | Quién | Descripción |
| --- | --- | --- |
| `GET /whistleblowing/settings`, `POST /whistleblowing/enable` | A (y responsable para ver) | Activa el canal o cambia su enlace (`{ regenerate }`) |
| `GET /whistleblowing/reports`, `GET /whistleblowing/reports/:id` | Responsable del Sistema | Comunicaciones descifradas; consultar una queda en la auditoría |
| `POST /whistleblowing/reports/:id/messages` | Responsable | Responder (cuenta como acuse de recibo) |
| `POST /whistleblowing/reports/:id/status` | Responsable | `{ status, resolution?, extendResolution? }` |
| `GET /public/whistleblowing/:token` | P | Nombre de la organización y categorías |
| `POST /public/whistleblowing/:token/reports` | P | `{ category, subject, description, anonymous, contact? }` → `{ code }` |
| `POST /public/whistleblowing/:token/status` | P | `{ code }` → estado, resolución y mensajes |
| `POST /public/whistleblowing/:token/messages` | P | `{ code, body }` |

Las rutas públicas tienen límite de 20 peticiones por IP cada 15 minutos.

## Migración desde Factorial

| Método y ruta | Quién | Descripción |
| --- | --- | --- |
| `POST /migration/factorial` | A | `{ apiKey, environment: production \| demo, dryRun, shiftsFrom?, includeLeaves, includeSalaries }` → `{ jobId }`. Se ejecuta en segundo plano |
| `GET /migration/jobs`, `GET /migration/jobs/:id` | A | Estado, recuentos y registro |

## Exportaciones e importación

| Método y ruta | Quién | Descripción |
| --- | --- | --- |
| `GET /exports/time-register?companyId=&from=&to=` | H | CSV del registro de jornada de la sociedad |
| `GET /exports/time-register?employmentId=&from=&to=` | E / H | CSV del registro de una persona |
| `GET /exports/payroll-variables?companyId=&period=` | H | CSV de variables de nómina del mes |
| `GET /imports/employees/template` | S | Plantilla CSV |
| `POST /imports/employees?dryRun=true\|false` | H | Multipart `file`: CSV (`;` o `,`) o Excel `.xlsx` (primera hoja, primera fila de cabeceras). Valida todo; con errores no escribe nada |

Los CSV usan `;`, BOM UTF-8 y CRLF (se abren bien en Excel en español), neutralizan fórmulas y llevan la cabecera `X-Content-SHA256`. Cada exportación queda en la auditoría con su huella.
