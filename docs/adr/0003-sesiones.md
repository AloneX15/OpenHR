# ADR 0003 · Sesiones con JWT revocables

Estado: aceptada · 2026-11-08

## Contexto

La API emite un JWT en una cookie `HttpOnly`. Un JWT puro no se puede revocar: tras un cambio de contraseña o la baja de una persona, su sesión seguiría valiendo hasta que caducara (12 h).

## Decisión

- `app_user.session_version` (entero). Un trigger lo incrementa cuando cambian `password_hash`, `totp_enabled` o el email, o cuando la cuenta pasa a inactiva.
- El JWT incluye `sv` (la versión al iniciar sesión). `AuthGuard` llama en cada petición a `auth_session_check(user_id, tenant_id)` y rechaza la sesión si la cuenta está inactiva o la versión no coincide.
- Tras cambiar la contraseña o el MFA desde la propia sesión, la API reemite la cookie con la versión nueva: esa sesión sigue y las demás se cierran.

## Consecuencias

- Una consulta ligera por petición (clave primaria). Asumible para el piloto y para la V1.
- Cerrar sesión solo borra la cookie del navegador; «cerrar sesión en todos los dispositivos» basta con incrementar la versión (pendiente en la interfaz).
