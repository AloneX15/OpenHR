-- OpenHR · endurecimiento tras la auditoría de seguridad (docs/seguridad.md)

-- Versión de sesión: cada sesión (JWT) lleva la versión vigente al iniciar sesión. Cambiar
-- la contraseña, restablecerla, activar o desactivar MFA o desactivar la cuenta la
-- incrementa, y todas las sesiones anteriores dejan de valer.
ALTER TABLE app_user ADD COLUMN session_version integer NOT NULL DEFAULT 1;

CREATE OR REPLACE FUNCTION bump_session_version() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.password_hash IS DISTINCT FROM OLD.password_hash
     OR NEW.totp_enabled IS DISTINCT FROM OLD.totp_enabled
     OR (OLD.is_active AND NOT NEW.is_active)
     OR lower(NEW.email) IS DISTINCT FROM lower(OLD.email) THEN
    NEW.session_version := OLD.session_version + 1;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER app_user_session_version BEFORE UPDATE ON app_user
  FOR EACH ROW EXECUTE FUNCTION bump_session_version();

-- Comprobación de sesión en cada petición (sin contexto de tenant todavía).
CREATE OR REPLACE FUNCTION auth_session_check(p_user_id uuid, p_tenant_id uuid)
RETURNS TABLE (is_active boolean, session_version integer)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT is_active, session_version FROM app_user WHERE id = p_user_id AND tenant_id = p_tenant_id
$$;

-- auth_find_user devuelve también la versión de sesión.
DROP FUNCTION auth_find_user(text);
CREATE FUNCTION auth_find_user(p_email text)
RETURNS TABLE (user_id uuid, tenant_id uuid, password_hash text, totp_secret text,
               totp_enabled boolean, is_active boolean, session_version integer)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT id, tenant_id, password_hash, totp_secret, totp_enabled, is_active, session_version
  FROM app_user WHERE lower(email) = lower(p_email)
$$;

-- Al enviar un email, se borra su cuerpo del outbox: los enlaces para fijar contraseña no
-- deben quedarse en la base de datos.
CREATE OR REPLACE FUNCTION outbox_finish(p_id bigint, p_error text) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  UPDATE outbox
     SET processed_at = CASE WHEN p_error IS NULL THEN now() END,
         payload = CASE WHEN p_error IS NULL
                        THEN jsonb_build_object('to', payload->'to', 'subject', payload->'subject', 'redacted', true)
                        ELSE payload END,
         last_error = p_error,
         available_at = CASE WHEN p_error IS NULL THEN available_at
                             ELSE now() + make_interval(mins => power(2, least(attempts, 8))::int) END
   WHERE id = p_id
$$;

REVOKE ALL ON FUNCTION auth_session_check(uuid, uuid), auth_find_user(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_session_check(uuid, uuid), auth_find_user(text) TO openhr_app;
