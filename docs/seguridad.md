# Seguridad

OpenHR guarda datos personales, de salud (bajas) y salariales (nóminas), así que la seguridad es un requisito del producto. Este documento recoge el modelo de amenazas, los controles y el resultado de la auditoría de noviembre de 2026.

## Modelo de amenazas

| Quién | Qué no debe poder hacer |
| --- | --- |
| Persona de otra organización en la misma instalación | Ver o modificar nada de la nuestra |
| Empleado/a | Ver datos de otras personas, fichar por otra persona, aprobar sus propias ausencias, borrar o reescribir fichajes |
| Responsable | Ver datos de salud, DNI o nóminas de su equipo, actuar fuera de sus reportes directos |
| RR. HH. de una sociedad | Ver personas o documentos de otras sociedades del grupo |
| Atacante sin cuenta | Adivinar contraseñas, reclamar la instalación, robar sesiones, CSRF |
| Quien controla la base de datos | Reescribir el registro de jornada sin que se note |

## Controles

### Aislamiento y autorización
- **RLS en PostgreSQL** en todas las tablas con `tenant_id`; la API usa un rol sin privilegios de propietario ni `BYPASSRLS`. Un test comprueba que ninguna tabla se queda sin RLS ([ADR 0001](adr/0001-tenancy-rls.md)).
- **Permisos por sociedad y por responsable** centralizados en `apps/api/src/common/access.ts` (`assertHr`, `assertEmploymentAccess`). Cada endpoint los aplica antes de leer o escribir; exportaciones e importaciones comprueban cada sociedad o fila.
- **Datos sensibles**: las ausencias marcadas como sensibles (IT, familiares) se muestran al responsable como «Ausencia», sin tipo ni comentario. El responsable no recibe DNI, teléfono ni fecha de nacimiento.
- **Registro de auditoría** de altas, cambios, bajas, permisos, correcciones de fichajes, exportaciones (con huella SHA-256) y descargas de documentos ajenos. Solo lo consulta administración.

### Autenticación y sesiones
- Contraseñas con **bcrypt (coste 12)**, mínimo 10 caracteres. Hash ficticio para igualar tiempos si el email no existe.
- **Límite de intentos**: 10 por IP y email y 20 por cuenta cada 15 minutos; MFA, 10 intentos por usuario. La web no reenvía a la API las cabeceras `X-Forwarded-For`, `X-Real-IP` ni `Forwarded` del cliente, para que no se pueda falsear la IP.
- **MFA TOTP** (RFC 6238) con el secreto cifrado con AES-256-GCM. Desactivarlo exige la contraseña.
- **JWT HS256** con algoritmo fijado, en cookie `HttpOnly`, `SameSite=Lax` y `Secure` cuando `PUBLIC_URL` es HTTPS.
- **Sesiones revocables**: cada JWT lleva la versión de sesión de la cuenta; cambiar la contraseña o el email, activar o desactivar MFA o desactivar la cuenta la incrementa y cierra todas las sesiones al instante ([ADR 0003](adr/0003-sesiones.md)).
- **Enlaces de contraseña de un solo uso**: llevan una huella del hash actual y caducan (24 h recuperación, 7 días invitación). La recuperación responde igual exista o no el email.
- **Cuenta corporativa (OpenID Connect)**: Microsoft Entra ID, Google Workspace u otro proveedor, con código de autorización y PKCE, `state` y `nonce` en cookie firmada, y validación completa del ID token. Solo enlaza cuentas existentes del mismo email y dominio permitido; puede hacerse obligatoria para esos dominios. El secreto del cliente se guarda cifrado.
- **Configuración inicial protegible** con `SETUP_TOKEN`, para que nadie reclame una instalación recién expuesta.

### Web y HTTP
- **CSRF**: cookie `SameSite=Lax` y, en toda petición que modifica datos y trae cabecera `Origin` (los navegadores la envían siempre en peticiones entre sitios), comprobación de que coincide con `PUBLIC_URL`. Las peticiones sin `Origin` no vienen de un navegador de otro sitio y no pueden aprovechar la cookie de la víctima.
- **Cabeceras**: `Content-Security-Policy` (sin orígenes externos, `object-src 'none'`, `frame-ancestors 'self'`), `X-Frame-Options`, `X-Content-Type-Options: nosniff`, `Referrer-Policy`, `Permissions-Policy`, `Cross-Origin-Opener-Policy`.
- **Descargas** como `attachment`, `no-store` y `nosniff`. Los CSV neutralizan fórmulas (`=`, `+`, `-`, `@`).
- **Errores** sin trazas ni detalles de PostgreSQL (que podrían revelar, por ejemplo, que un email existe en otra organización).
- **Entradas** validadas con zod; los campos desconocidos se descartan (sin asignación masiva).

### Integridad del registro de jornada
- Fichajes **append-only** (permisos y triggers), correcciones como eventos con motivo y autor.
- **Cadena de hashes** por relación laboral y **sellos** enviados por email fuera del sistema ([ADR 0002](adr/0002-time-entry-hash-chain.md)).

### Datos salariales
- La retribución y el sexo solo los ve RR. HH. de la sociedad (el sexo, también la propia persona); el responsable no. La auditoría registra que hubo un cambio y quién lo hizo, sin los importes.

### Avisos push
- El servidor solo envía a servicios de push conocidos (Chrome, Firefox, Edge, Safari; configurable con `PUSH_ALLOWED_HOSTS`), por https y sin puertos raros: una suscripción manipulada no puede hacer que llame a direcciones internas.
- El contenido va cifrado de extremo a extremo (Web Push con VAPID). Al enviarse, el outbox borra el texto y las claves de la suscripción. El service worker solo abre rutas de la propia web.

### SCIM
- El token de SCIM se guarda como huella SHA-256, se puede revocar y solo sirve para su organización. SCIM no asigna roles: solo crea, cambia el email y activa o desactiva cuentas de empleado.
- «Borrar» por SCIM desactiva (el registro de jornada y la auditoría deben conservarse). La desactivación cierra al momento las sesiones abiertas.

### Slack y Teams
- La URL de un webhook es la credencial del canal: se guarda cifrada (AES-256-GCM), no se devuelve nunca por la API y no entra en la auditoría.
- Solo se admiten dominios de Slack y de flujos de trabajo de Teams, por https; el envío no sigue redirecciones y corta a los 10 segundos.
- A los canales solo sale el nombre, el tipo de ausencia y las fechas. Las ausencias marcadas como sensibles (bajas médicas, enfermedad de familiares) no se publican nunca.

### Gastos
- El justificante solo lo ven la persona, su responsable directo y RR. HH. de la sociedad; cada consulta ajena queda en la auditoría. Se aceptan solo imágenes y PDF de hasta 10 MB, y se sirven con `nosniff`. Nadie puede aprobar sus propios gastos.

### Kiosco y ubicación
- El kiosco se autentica con un token de dispositivo (solo se guarda su hash) y se puede desactivar. Cada persona se identifica con código y PIN (bcrypt, 5 intentos cada 15 minutos) o con un QR firmado que caduca en 60 segundos. La pantalla solo muestra el nombre de pila.
- La ubicación se pide únicamente al fichar y solo si el centro lo tiene activado; nunca se hace seguimiento. Con la zona desactivada no se guarda ninguna posición. `Permissions-Policy` limita cámara y ubicación al propio origen.

### Canal de denuncias
- Accesible sin cuenta en `/canal/<token>`; el token es aleatorio y se puede cambiar. Anónimo si se quiere: no se guarda la IP ni datos del informante, que se identifica solo con un código de seguimiento de unos 100 bits del que se guarda el hash.
- Contenido cifrado en la base de datos. Solo lo ve quien tiene el rol de Responsable del Sistema; administración y RR. HH. no, salvo que se les asigne (queda en la auditoría, como cada consulta de una comunicación).
- Plazos legales (acuse en 7 días, respuesta en 3 meses) visibles y marcados al vencer.

### Conservación y derechos
- Plazos por categoría aplicados cada día. El registro de jornada no se puede purgar antes de 4 años ni desde la propia base de datos.
- Anonimización de quien dejó el grupo: datos identificativos, cuenta, campos personalizados, evidencias de firma y documentos.
- Cada persona descarga sus datos en JSON y ejerce sus derechos con plazo de respuesta controlado.

### Firma electrónica
- Es una **firma electrónica simple** (art. 3.10 del Reglamento eIDAS): tiene validez jurídica y su fuerza probatoria depende de las evidencias. Para contratos de alto riesgo puede convenir un proveedor de firma avanzada o cualificada (pendiente como adaptador).
- Doble factor: sesión autenticada y código de un solo uso enviado al email del firmante (guardado como hash, 10 minutos, 5 intentos; los fallos quedan registrados aunque la petición falle).
- Al PDF se le añade una hoja con firmante, DNI/NIE, email, fecha, IP, método, declaración aceptada y SHA-256 del original; las evidencias y la huella del PDF firmado se guardan en la base de datos y en la auditoría.

### Ficheros
- Claves de almacenamiento generadas por el servidor (sin rutas del usuario) y comprobación de que no salen del directorio raíz.
- SHA-256 de cada fichero, comprobado al leerlo.
- Límites de tamaño: 50 MB (PDF y documentos) y 5 MB (CSV). Los PDF se validan por cabecera y se procesan sin evaluar código (`isEvalSupported: false`).
- Nóminas: ninguna página se publica sin revisión humana.

### Datos en reposo y secretos
- Secretos solo en `.env` (fuera de Git); `.env.example` sin valores reales.
- El cuerpo de los emails (que puede incluir enlaces de contraseña) se borra del outbox al enviarse.
- PostgreSQL y Mailpit escuchan solo en `127.0.0.1` del host.

### Dependencias
- `npm audit --omit=dev`: **0 vulnerabilidades** (se actualizaron `nodemailer` a 10.x y `csv-parse` a 7.x, y se forzó `multer` 2.5.0).

## Auditoría de noviembre de 2026

Revisión del código fuente siguiendo la metodología de la skill `security-audit` de Cloudflare (fronteras de confianza, control de acceso, inyección, cripto y secretos, lógica de negocio, abuso de funciones, HTTP y autenticación). Hallazgos corregidos:

| # | Hallazgo | Impacto | Corrección |
| --- | --- | --- | --- |
| 1 | Las sesiones (JWT) seguían valiendo tras cambiar la contraseña o desactivar la cuenta | Alto: una sesión robada o de una persona dada de baja seguía activa hasta 12 h | Versión de sesión en `app_user`, comprobada en cada petición |
| 2 | El límite de intentos de login usaba la IP, que la web reenvía desde `X-Forwarded-For` y puede falsearse | Medio: fuerza bruta contra una cuenta rotando IPs | Límite adicional por cuenta |
| 3 | El registro de auditoría lo veía RR. HH. de cualquier sociedad | Medio: datos de otras sociedades del grupo | Solo administración |
| 4 | Los errores de clave única devolvían `detail` de PostgreSQL | Bajo: revelaba emails de otras organizaciones | Mensaje genérico |
| 5 | La configuración inicial era pública hasta completarla | Medio en instalaciones expuestas | `SETUP_TOKEN` opcional |
| 6 | Enlaces de contraseña guardados en claro en el outbox tras enviarse | Bajo: requiere acceso a la base de datos | Se borra el cuerpo al enviar |
| 7 | Cookie sin `Secure` por defecto | Bajo | `Secure` automático con `PUBLIC_URL` HTTPS |
| 8 | JWT sin algoritmo fijado al verificar | Endurecimiento | `algorithms: ['HS256']` |
| 9 | Sin CSP ni `Permissions-Policy` | Endurecimiento | Cabeceras en la web |
| 10 | Dependencias con avisos (nodemailer, csv-parse, multer) | Alto/medio según el aviso | Actualizadas |
| 11 | La web reenviaba el `X-Forwarded-For` del cliente a la API | Medio: eludir el límite por IP | La web elimina esas cabeceras (hallado en la revisión de código posterior) |
| 12 | Al dar de alta por email se podía fusionar a dos personas con DNI distintos | Medio: datos de una persona visibles para otra | Solo se reutiliza la persona si el DNI no lo contradice |
| 11 | La web reenviaba el `X-Forwarded-For` del cliente a la API | Medio: eludir el límite por IP | La web elimina esas cabeceras (hallado en la revisión de código posterior) |
| 12 | Al dar de alta por email se podía fusionar a dos personas con DNI distintos | Medio: datos de una persona visibles para otra | Solo se reutiliza la persona si el DNI no lo contradice |

Los tests de integración cubren los puntos 1, 3 y 4.

## Pendiente (V1 comercial)

- `'unsafe-inline'` en `script-src`: sustituir por nonces de Next.js.
- Sellado automático mensual y sellado de tiempo RFC 3161.
- Límites de intentos compartidos (en base de datos o Redis) si se despliegan varias réplicas de la API.
- Antivirus opcional para documentos subidos.

## Cómo informar de una vulnerabilidad

No abras una incidencia pública: escribe a quien mantenga el proyecto por un canal privado y da tiempo a publicar la corrección.
