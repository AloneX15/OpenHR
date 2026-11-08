-- OpenHR · V1.1: inicio de sesión con un proveedor OpenID Connect (Microsoft Entra ID,
-- Google Workspace, Keycloak…). Solo enlaza cuentas existentes por email.

CREATE TABLE oidc_provider (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenant(id) UNIQUE,   -- uno por organización
  label              text NOT NULL DEFAULT 'Microsoft 365',
  issuer             text NOT NULL,                                -- https (lo comprueba la API)
  client_id          text NOT NULL,
  client_secret_enc  text NOT NULL,                                -- cifrado con ENCRYPTION_KEY
  domains            text[] NOT NULL,                              -- dominios de email que usan este acceso
  enabled            boolean NOT NULL DEFAULT true,
  -- Si es true, las cuentas de esos dominios ya no pueden entrar con contraseña.
  enforce            boolean NOT NULL DEFAULT false,
  updated_at         timestamptz NOT NULL DEFAULT now()
);

-- Antes de iniciar sesión no hay tenant: se localiza el proveedor por el dominio del email.
CREATE OR REPLACE FUNCTION oidc_provider_by_domain(p_domain text)
RETURNS TABLE (tenant_id uuid, provider_id uuid, enforce boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT tenant_id, id, enforce FROM oidc_provider WHERE enabled AND lower(p_domain) = ANY(domains) LIMIT 1
$$;

SELECT enable_tenant_rls('oidc_provider');
REVOKE ALL ON FUNCTION oidc_provider_by_domain(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION oidc_provider_by_domain(text) TO openhr_app;
