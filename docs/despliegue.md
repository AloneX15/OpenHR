# Despliegue

Hay dos formas: **Docker Compose** en un servidor (esta guía) o **Azure** con Terraform ([despliegue en Azure](despliegue-azure.md)).

## Requisitos

- Docker Engine 24+ con Compose v2 (o Docker Desktop).
- 2 vCPU, 2 GB de RAM y 10 GB de disco bastan para un grupo de unos cientos de personas.
- Un dominio y HTTPS si se accede desde fuera de la red local.

## Primera instalación

```bash
git clone https://github.com/AloneX15/OpenHR.git
cd OpenHR
cp .env.example .env
```

Edita `.env` y genera los secretos:

```bash
openssl rand -hex 24      # para POSTGRES_OWNER_PASSWORD y OPENHR_APP_DB_PASSWORD
openssl rand -hex 32      # para JWT_SECRET
openssl rand -base64 32   # para ENCRYPTION_KEY
openssl rand -hex 16      # para SETUP_TOKEN
```

Arranca:

```bash
docker compose up -d --build
```

Abre `PUBLIC_URL` (por defecto <http://localhost:3000>), completa la **configuración inicial** (pide `SETUP_TOKEN` si lo definiste) y entra en **Organización** para añadir sociedades, centros, festivos locales y personas.

## Variables de entorno

| Variable | Obligatoria | Descripción |
| --- | --- | --- |
| `POSTGRES_DB` | No (`openhr`) | Nombre de la base de datos |
| `POSTGRES_OWNER_USER` | No (`openhr_owner`) | Rol propietario (migraciones) |
| `POSTGRES_OWNER_PASSWORD` | **Sí** | Contraseña del propietario |
| `OPENHR_APP_DB_PASSWORD` | **Sí** | Contraseña del rol `openhr_app` que usa la API |
| `JWT_SECRET` | **Sí** | Firma de las sesiones. Cambiarlo cierra todas las sesiones |
| `ENCRYPTION_KEY` | Recomendada | 32 bytes en base64 para cifrar los secretos MFA. Si falta, se deriva de `JWT_SECRET`. **No la cambies** después o los MFA dejarán de funcionar |
| `SETUP_TOKEN` | Recomendada | Protege la configuración inicial |
| `PUBLIC_URL` | **Sí en producción** | URL exacta con la que se accede (`https://rrhh.ejemplo.com`). Se usa en los enlaces de los emails y para rechazar peticiones de otro origen |
| `SECURE_COOKIES` | No | `true`/`false`. Por defecto, `true` si `PUBLIC_URL` es HTTPS |
| `SESSION_HOURS` | No (12) | Duración de la sesión |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_FROM` | En producción | Servidor de correo. Por defecto, Mailpit |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` | No | Avisos push en el navegador. Genera las claves una vez con `npx web-push generate-vapid-keys` y no las cambies (las suscripciones dependen de ellas). Sin ellas, los avisos llegan solo a la bandeja y por email |
| `PUSH_ALLOWED_HOSTS` | No | Servicios de push permitidos (sufijos de dominio separados por comas). Por defecto, los de Chrome, Firefox, Edge y Safari |
| `OUTBOX_WORKER` | No (`true`) | Procesar en la API el envío de emails y la conservación diaria |
| `STORAGE_DRIVER` | No (`local`) | Dónde guardar los ficheros: `local` (volumen), `s3` o `azure` |
| `STORAGE_DIR` | No | Carpeta para `local` |
| `S3_BUCKET`, `S3_REGION`, `S3_ENDPOINT`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_FORCE_PATH_STYLE` | Con `s3` | Amazon S3 o compatible (MinIO, R2…). Sin claves se usa la cadena de credenciales estándar |
| `AZURE_STORAGE_CONTAINER`, `AZURE_STORAGE_CONNECTION_STRING` o `AZURE_STORAGE_ACCOUNT` | Con `azure` | Con `AZURE_STORAGE_ACCOUNT` se usa la identidad gestionada (`AZURE_CLIENT_ID`) |
| `TSA_URL` | No | Autoridad de sellado de tiempo RFC 3161 para los sellos del registro de jornada (por ejemplo `https://freetsa.org/tsr`, o la de tu prestador cualificado) |
| `SIGNATURE_PROVIDER` | No (`simple`) | Adaptador de firma electrónica. Solo existe `simple` (código por email y hoja de evidencias); un valor desconocido impide arrancar la API |
| `CLAMAV_HOST`, `CLAMAV_PORT` | No (puerto 3310) | Antivirus ClamAV (`clamd`) para analizar los ficheros subidos. Con `docker compose --profile antivirus up -d` se arranca uno y basta `CLAMAV_HOST=clamav` |
| `OUTBOX_WORKER` | No (`true`) | `false` desactiva en esa réplica el envío de emails, la conservación diaria y el sellado automático |
| `WEB_PORT`, `DB_PORT` | No (3000, 5433) | Puertos publicados en el host |

## Producción

1. **HTTPS**: pon un proxy inverso delante del puerto 3000. Ejemplo con Caddy:
   ```
   rrhh.ejemplo.com {
     reverse_proxy localhost:3000
   }
   ```
   Ajusta `PUBLIC_URL=https://rrhh.ejemplo.com`.
2. **Correo**: configura `SMTP_*` con tu proveedor y elimina el servicio `mailpit` del compose.
3. **Red**: no publiques el puerto de PostgreSQL fuera de `127.0.0.1`.
4. **Copias de seguridad** diarias y probadas:
   ```bash
   docker compose exec db pg_dump -U openhr_owner -Fc openhr > openhr-$(date +%F).dump
   docker run --rm -v openhr_storage:/data -v "$PWD":/backup alpine tar czf /backup/storage-$(date +%F).tgz -C /data .
   ```
   Guarda también `.env` (sobre todo `ENCRYPTION_KEY`) en un lugar seguro.
5. **Sellos**: el registro de jornada de cada sociedad se sella solo al empezar cada mes y la huella llega por email a RR. HH.; conserva esos correos. Para una prueba de un tercero, define `TSA_URL`.
6. **Antivirus** (recomendado si la plantilla sube documentos): `CLAMAV_HOST=clamav` en `.env` y `docker compose --profile antivirus up -d`. ClamAV necesita alrededor de 1,5 GB de memoria y tarda unos minutos en descargar las firmas la primera vez; hasta entonces las subidas se rechazan. Su `StreamMaxLength` (25 MB por defecto en algunas versiones) debe cubrir el tamaño máximo de subida de OpenHR, 50 MB.

## Actualizar

```bash
git pull
docker compose up -d --build
```

El servicio `migrate` aplica las migraciones nuevas antes de arrancar la API. Haz copia de seguridad antes de actualizar.

## Restaurar

```bash
docker compose stop api web
docker compose exec -T db pg_restore -U openhr_owner -d openhr --clean < openhr-AAAA-MM-DD.dump
docker run --rm -v openhr_storage:/data -v "$PWD":/backup alpine tar xzf /backup/storage-AAAA-MM-DD.tgz -C /data
docker compose up -d
```

## Empezar de cero (solo pruebas)

`docker compose down -v` **borra todos los datos** (base de datos y ficheros). Úsalo solo en instalaciones de prueba.
