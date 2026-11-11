-- OpenHR · cierre de la V1: límites de intentos compartidos entre réplicas, sellado
-- automático mensual con sello de tiempo RFC 3161 y análisis antivirus de ficheros.

-- ── Límites de intentos ────────────────────────────────────────────────────────────
-- Antes vivían en la memoria de cada proceso de la API: con varias réplicas, cada una
-- contaba por separado. Ahora se cuentan aquí. La tabla no tiene tenant (los intentos
-- llegan antes de saber de qué organización son) y la aplicación solo la toca con las
-- funciones de abajo. La clave es una huella SHA-256: no se guardan emails ni IPs.
CREATE TABLE rate_limit_hit (
  key     text NOT NULL,
  hit_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX rate_limit_hit_key_idx ON rate_limit_hit (key, hit_at);
REVOKE ALL ON rate_limit_hit FROM openhr_app;

-- Apunta un intento si aún cabe en la ventana. Devuelve false cuando se ha superado el
-- máximo. El bloqueo por clave serializa los intentos simultáneos sobre la misma clave.
CREATE FUNCTION rate_limit_try(p_key text, p_max integer, p_window_seconds integer) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  since timestamptz := now() - make_interval(secs => p_window_seconds);
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(p_key, 0));
  DELETE FROM rate_limit_hit WHERE key = p_key AND hit_at < since;
  IF (SELECT count(*) FROM rate_limit_hit WHERE key = p_key) >= p_max THEN
    RETURN false;
  END IF;
  INSERT INTO rate_limit_hit (key) VALUES (p_key);
  RETURN true;
END;
$$;

CREATE FUNCTION rate_limit_reset(p_key text) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  DELETE FROM rate_limit_hit WHERE key = p_key
$$;

-- Limpieza diaria de claves que nadie ha vuelto a usar (ninguna ventana supera un día).
CREATE FUNCTION rate_limit_cleanup() RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  DELETE FROM rate_limit_hit WHERE hit_at < now() - interval '1 day'
$$;

REVOKE ALL ON FUNCTION rate_limit_try(text, integer, integer), rate_limit_reset(text), rate_limit_cleanup() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION rate_limit_try(text, integer, integer), rate_limit_reset(text), rate_limit_cleanup() TO openhr_app;

-- ── Sellos automáticos y sello de tiempo ───────────────────────────────────────────
ALTER TABLE time_chain_seal
  ADD COLUMN automatic   boolean NOT NULL DEFAULT false,
  -- Mes cerrado (AAAA-MM) que cubre un sello automático.
  ADD COLUMN period      text CHECK (period ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  -- Respuesta de la autoridad de sellado de tiempo (TimeStampResp, RFC 3161) sobre `digest`.
  ADD COLUMN tsa_response bytea,
  ADD COLUMN tsa_url     text,
  ADD CONSTRAINT time_chain_seal_auto_period CHECK (NOT automatic OR period IS NOT NULL);

-- Un solo sello automático por sociedad y mes, aunque haya varias réplicas de la API.
CREATE UNIQUE INDEX time_chain_seal_auto_uq ON time_chain_seal (company_id, period) WHERE automatic;

-- Organizaciones de la instalación, para los procesos automáticos (sellado y conservación).
CREATE FUNCTION system_tenant_ids() RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT id FROM tenant
$$;
REVOKE ALL ON FUNCTION system_tenant_ids() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION system_tenant_ids() TO openhr_app;

-- ── Purga del registro de auditoría ────────────────────────────────────────────────
-- audit_event es append-only para la aplicación; el plazo de conservación se aplica solo
-- con esta función, que nunca borra nada de menos de un año.
CREATE FUNCTION retention_purge_audit(p_tenant uuid, p_before timestamptz) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  n integer;
BEGIN
  IF p_tenant IS DISTINCT FROM app_tenant_id() THEN
    RAISE EXCEPTION 'Tenant incorrecto';
  END IF;
  IF p_before > now() - interval '1 year' THEN
    RAISE EXCEPTION 'El registro de auditoría se conserva al menos 1 año';
  END IF;
  DELETE FROM audit_event WHERE tenant_id = p_tenant AND created_at < p_before;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$$;
REVOKE ALL ON FUNCTION retention_purge_audit(uuid, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION retention_purge_audit(uuid, timestamptz) TO openhr_app;
