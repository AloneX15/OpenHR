-- OpenHR · V1.1: SCIM 2.0 para que Microsoft Entra ID (u otro proveedor) cree y desactive cuentas

-- Tokens de SCIM de la organización. Solo se guarda la huella.
CREATE TABLE scim_token (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenant(id),
  label         text NOT NULL,
  token_hash    text NOT NULL UNIQUE,
  created_by    uuid NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_used_at  timestamptz,
  revoked_at    timestamptz
);
SELECT enable_tenant_rls('scim_token');

-- Identificador de la cuenta en el proveedor y última modificación (para meta.lastModified).
ALTER TABLE app_user ADD COLUMN scim_external_id text;
ALTER TABLE app_user ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
CREATE UNIQUE INDEX app_user_scim_external_uq ON app_user (tenant_id, scim_external_id) WHERE scim_external_id IS NOT NULL;

-- Resuelve la organización de un token (antes de tener contexto de tenant).
CREATE FUNCTION scim_token_lookup(p_hash text)
RETURNS TABLE (id uuid, tenant_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT id, tenant_id FROM scim_token WHERE token_hash = p_hash AND revoked_at IS NULL
$$;
REVOKE ALL ON FUNCTION scim_token_lookup(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION scim_token_lookup(text) TO openhr_app;
