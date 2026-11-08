-- OpenHR · V1 fase 6: RGPD (derechos y conservación) y canal de denuncias (Ley 2/2023)

-- ── Solicitudes de derechos (arts. 15-22 RGPD) ─────────────────────────────────────
CREATE TABLE privacy_request (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenant(id),
  person_id     uuid NOT NULL REFERENCES person(id),
  user_id       uuid,
  kind          text NOT NULL CHECK (kind IN ('access', 'rectification', 'erasure', 'restriction', 'portability', 'objection')),
  details       text NOT NULL,
  status        text NOT NULL DEFAULT 'received' CHECK (status IN ('received', 'in_progress', 'completed', 'rejected')),
  due_date      date NOT NULL,           -- un mes desde la recepción (art. 12.3), ampliable dos más
  response      text,
  handled_by    uuid,
  created_at    timestamptz NOT NULL DEFAULT now(),
  completed_at  timestamptz
);

-- ── Conservación ───────────────────────────────────────────────────────────────────
-- Plazos en días por categoría. Sin fila, se aplica el valor por defecto del código.
CREATE TABLE retention_setting (
  tenant_id  uuid NOT NULL REFERENCES tenant(id),
  category   text NOT NULL CHECK (category IN ('time_entries', 'notifications', 'outbox', 'audit', 'former_employees')),
  days       integer NOT NULL CHECK (days > 0),
  PRIMARY KEY (tenant_id, category)
);

CREATE TABLE retention_run (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenant(id),
  run_at      timestamptz NOT NULL DEFAULT now(),
  triggered_by uuid,
  result      jsonb NOT NULL
);

-- Punto de control de la cadena de fichajes tras purgar un periodo (ver ADR 0002): la
-- verificación empieza en este eslabón.
CREATE TABLE time_chain_checkpoint (
  tenant_id      uuid NOT NULL REFERENCES tenant(id),
  employment_id  uuid PRIMARY KEY REFERENCES employment(id),
  seq            bigint NOT NULL,
  hash           text NOT NULL,
  purged_before  timestamptz NOT NULL,
  updated_at     timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE person ADD COLUMN anonymized_at timestamptz;

-- El trigger de inmutabilidad deja borrar solo dentro de la purga por conservación.
CREATE OR REPLACE FUNCTION time_entry_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_setting('openhr.retention_purge', true) = 'on' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'time_entry es inmutable: registra una corrección en su lugar'
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

-- Purga de fichajes anteriores a una fecha para un tenant. Solo la puede ejecutar la API a
-- través de esta función (el rol de aplicación no tiene DELETE sobre time_entry). Deja un
-- punto de control por relación laboral con el último eslabón purgado.
CREATE OR REPLACE FUNCTION retention_purge_time_entries(p_tenant uuid, p_before timestamptz) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  n integer;
BEGIN
  IF p_tenant IS DISTINCT FROM app_tenant_id() THEN
    RAISE EXCEPTION 'Tenant incorrecto';
  END IF;
  IF p_before > now() - interval '4 years' THEN
    RAISE EXCEPTION 'El registro de jornada se conserva al menos 4 años (art. 34.9 ET)';
  END IF;
  -- No se purga un fichaje si una anulación posterior al corte lo referencia.
  INSERT INTO time_chain_checkpoint (tenant_id, employment_id, seq, hash, purged_before)
  SELECT DISTINCT ON (t.employment_id) t.tenant_id, t.employment_id, t.seq, t.hash, p_before
    FROM time_entry t
   WHERE t.tenant_id = p_tenant AND t.recorded_at < p_before
     AND NOT EXISTS (SELECT 1 FROM time_entry v WHERE v.voids_entry_id = t.id AND v.recorded_at >= p_before)
   ORDER BY t.employment_id, t.seq DESC
  ON CONFLICT (employment_id) DO UPDATE SET seq = EXCLUDED.seq, hash = EXCLUDED.hash,
    purged_before = EXCLUDED.purged_before, updated_at = now()
   WHERE time_chain_checkpoint.seq < EXCLUDED.seq;
  PERFORM set_config('openhr.retention_purge', 'on', true);
  DELETE FROM time_entry t USING time_chain_checkpoint c
   WHERE t.tenant_id = p_tenant AND c.employment_id = t.employment_id AND t.seq <= c.seq;
  GET DIAGNOSTICS n = ROW_COUNT;
  PERFORM set_config('openhr.retention_purge', 'off', true);
  RETURN n;
END;
$$;

-- Tenants para el proceso automático de conservación.
CREATE OR REPLACE FUNCTION retention_tenant_ids() RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT id FROM tenant
$$;

-- ── Canal de denuncias (Ley 2/2023) ───────────────────────────────────────────────
ALTER TABLE tenant ADD COLUMN whistleblowing_token text UNIQUE;
-- Rol de «Responsable del Sistema interno de información».
ALTER TABLE role_assignment DROP CONSTRAINT role_assignment_role_check;
ALTER TABLE role_assignment ADD CONSTRAINT role_assignment_role_check CHECK (role IN ('admin', 'hr', 'compliance'));

-- Textos cifrados con ENCRYPTION_KEY (AES-256-GCM) en la API.
CREATE TABLE wb_report (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenant(id),
  code_hash        text NOT NULL UNIQUE,     -- sha256 del código de seguimiento
  category         text NOT NULL,
  subject_enc      text NOT NULL,
  description_enc  text NOT NULL,
  anonymous        boolean NOT NULL,
  contact_enc      text,                     -- nombre y forma de contacto, si no es anónima
  status           text NOT NULL DEFAULT 'received'
                     CHECK (status IN ('received', 'acknowledged', 'investigating', 'resolved', 'dismissed')),
  received_at      timestamptz NOT NULL DEFAULT now(),
  ack_due          timestamptz NOT NULL,     -- acuse en 7 días (art. 9.2.c)
  resolution_due   timestamptz NOT NULL,     -- respuesta en 3 meses (art. 9.2.d)
  acknowledged_at  timestamptz,
  resolved_at      timestamptz,
  resolution_enc   text
);

CREATE TABLE wb_message (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenant(id),
  report_id   uuid NOT NULL REFERENCES wb_report(id) ON DELETE CASCADE,
  author      text NOT NULL CHECK (author IN ('reporter', 'handler')),
  handler_id  uuid,
  body_enc    text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Acceso sin sesión: localizar el tenant por el token público del canal.
CREATE OR REPLACE FUNCTION wb_tenant_by_token(p_token text)
RETURNS TABLE (tenant_id uuid, tenant_name text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT id, name FROM tenant WHERE whistleblowing_token = p_token AND p_token IS NOT NULL
$$;

SELECT enable_tenant_rls(t::regclass) FROM unnest(ARRAY[
  'privacy_request', 'retention_setting', 'retention_run', 'time_chain_checkpoint', 'wb_report', 'wb_message'
]) AS t;

REVOKE ALL ON FUNCTION retention_purge_time_entries(uuid, timestamptz), retention_tenant_ids(), wb_tenant_by_token(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION retention_purge_time_entries(uuid, timestamptz), retention_tenant_ids(), wb_tenant_by_token(text) TO openhr_app;
