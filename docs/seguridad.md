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
- Purga y anonimización por retención (RGPD) y solicitudes de los interesados.
- Sellado automático mensual y sellado de tiempo RFC 3161.
- Límites de intentos compartidos (en base de datos o Redis) si se despliegan varias réplicas de la API.
- Antivirus opcional para documentos subidos.
- Inicio de sesión con Microsoft Entra ID (OIDC).

## Cómo informar de una vulnerabilidad

No abras una incidencia pública: escribe a quien mantenga el proyecto por un canal privado y da tiempo a publicar la corrección.
