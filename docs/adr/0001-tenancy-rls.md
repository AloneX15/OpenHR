# ADR 0001 · Aislamiento entre organizaciones con RLS

Estado: aceptada · 2026-11-08

## Contexto

Una instalación de OpenHR puede alojar varias organizaciones (tenants). Una fuga de datos entre ellas es el fallo más grave posible y no se arregla con una actualización.

## Decisión

- Toda tabla de negocio tiene `tenant_id` y una política de Row Level Security `tenant_id = app_tenant_id()`, creada con `enable_tenant_rls()`. Un test de integración falla si alguna tabla con `tenant_id` no tiene RLS.
- La API se conecta con el rol `openhr_app`: no es propietario de las tablas, no es superusuario y tiene `NOBYPASSRLS`. Las migraciones usan el rol propietario.
- El tenant se fija **por transacción** con `set_config('app.tenant_id', $1, true)` (equivalente a `SET LOCAL`). Muere con la transacción, así que es seguro con PgBouncer en modo transacción. Sin contexto, `app_tenant_id()` es `NULL` y no se ve ninguna fila.
- Las únicas operaciones que cruzan tenants son funciones `SECURITY DEFINER` acotadas: buscar un usuario por email al iniciar sesión, la configuración inicial y el procesado del outbox.
- Dentro de un tenant, los permisos por sociedad (RR. HH. de una sociedad, responsable de equipo) se aplican en la capa de aplicación (`common/access.ts`).

## Consecuencias

- Un error en una consulta de la aplicación (olvidar un `WHERE tenant_id`) no expone otra organización.
- Las tablas nuevas deben llamar a `enable_tenant_rls()` en su migración.
- Los permisos por sociedad aún no están en RLS: si se quisiera, se añadiría `app.company_ids` al contexto.
