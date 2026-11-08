-- OpenHR · aislamiento entre tenants (RLS) y permisos del rol de aplicación.
-- El rol openhr_app lo crea el script de migración (src/db/migrate.ts) antes de ejecutar
-- este fichero. Ver docs/adr/0001-tenancy-rls.md.

-- Activa RLS con la política estándar de tenant en una tabla.
CREATE OR REPLACE FUNCTION enable_tenant_rls(tbl regclass) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', tbl);
  EXECUTE format(
    'CREATE POLICY tenant_isolation ON %s USING (tenant_id = app_tenant_id()) '
    'WITH CHECK (tenant_id = app_tenant_id())', tbl);
END;
$$;

SELECT enable_tenant_rls(t::regclass) FROM unnest(ARRAY[
  'company', 'work_center', 'department', 'person', 'app_user', 'role_assignment',
  'employment', 'holiday', 'audit_event', 'notification', 'outbox',
  'time_entry', 'time_chain_seal',
  'absence_type', 'absence_request', 'vacation_adjustment',
  'stored_file', 'document', 'payslip_batch', 'payslip_page'
]) AS t;

ALTER TABLE tenant ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_self ON tenant USING (id = app_tenant_id());

-- Permisos mínimos del rol de aplicación.
GRANT USAGE ON SCHEMA public TO openhr_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO openhr_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO openhr_app;
-- Tablas append-only: la app solo puede leer e insertar.
REVOKE UPDATE, DELETE ON time_entry, time_chain_seal, audit_event FROM openhr_app;
REVOKE INSERT, DELETE ON tenant FROM openhr_app;
REVOKE ALL ON schema_migrations FROM openhr_app;
GRANT SELECT ON schema_migrations TO openhr_app;

-- ── Funciones SECURITY DEFINER: las únicas puertas que cruzan tenants ──────────────

-- Inicio de sesión: aún no sabemos el tenant, así que buscamos por email.
CREATE OR REPLACE FUNCTION auth_find_user(p_email text)
RETURNS TABLE (user_id uuid, tenant_id uuid, password_hash text, totp_secret text,
               totp_enabled boolean, is_active boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT id, tenant_id, password_hash, totp_secret, totp_enabled, is_active
  FROM app_user WHERE lower(email) = lower(p_email)
$$;

-- Primera puesta en marcha: crea el tenant solo si la instalación está vacía.
CREATE OR REPLACE FUNCTION setup_create_tenant(p_name text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  new_id uuid;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('openhr_setup'));
  IF EXISTS (SELECT 1 FROM tenant) THEN
    RAISE EXCEPTION 'La instalación ya está configurada' USING ERRCODE = 'unique_violation';
  END IF;
  INSERT INTO tenant (name) VALUES (p_name) RETURNING id INTO new_id;
  RETURN new_id;
END;
$$;

CREATE OR REPLACE FUNCTION setup_is_done() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM tenant)
$$;

-- Outbox: el proceso de envío trabaja para todos los tenants.
CREATE OR REPLACE FUNCTION outbox_claim(p_limit integer)
RETURNS TABLE (id bigint, tenant_id uuid, type text, payload jsonb, attempts integer)
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  UPDATE outbox o
     SET attempts = o.attempts + 1,
         available_at = now() + interval '5 minutes'   -- arrendamiento
   WHERE o.id IN (
     SELECT x.id FROM outbox x
      WHERE x.processed_at IS NULL AND x.available_at <= now() AND x.attempts < 10
      ORDER BY x.id
      LIMIT p_limit
      FOR UPDATE SKIP LOCKED)
  RETURNING o.id, o.tenant_id, o.type, o.payload, o.attempts
$$;

CREATE OR REPLACE FUNCTION outbox_finish(p_id bigint, p_error text) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  UPDATE outbox
     SET processed_at = CASE WHEN p_error IS NULL THEN now() END,
         last_error = p_error,
         available_at = CASE WHEN p_error IS NULL THEN available_at
                             ELSE now() + make_interval(mins => power(2, least(attempts, 8))::int) END
   WHERE id = p_id
$$;

REVOKE ALL ON FUNCTION auth_find_user(text), setup_create_tenant(text), setup_is_done(),
  outbox_claim(integer), outbox_finish(bigint, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_find_user(text), setup_create_tenant(text), setup_is_done(),
  outbox_claim(integer), outbox_finish(bigint, text) TO openhr_app;

-- Tablas futuras: permisos por defecto. ¡Recuerda llamar a enable_tenant_rls() en cada
-- tabla nueva con tenant_id! El test de seguridad comprueba que ninguna se queda sin RLS.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO openhr_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO openhr_app;
