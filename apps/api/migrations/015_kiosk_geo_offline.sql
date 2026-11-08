-- OpenHR · V1.1: kiosco de fichaje, geolocalización y fichaje sin conexión

-- Canal y contexto del fichaje. Entran en la huella de la cadena cuando tienen valor.
ALTER TABLE time_entry
  ADD COLUMN channel          text CHECK (channel IN ('web', 'kiosk', 'offline', 'import')),
  ADD COLUMN kiosk_device_id  uuid,
  ADD COLUMN latitude         double precision,
  ADD COLUMN longitude        double precision,
  ADD COLUMN accuracy_m       double precision,
  ADD COLUMN inside_zone      boolean;

-- Fichajes hechos sin conexión: vale la hora que dijo el dispositivo (limitada) y quedan marcados.
ALTER TABLE time_entry DROP CONSTRAINT time_entry_source_check;
ALTER TABLE time_entry ADD CONSTRAINT time_entry_source_check CHECK (source IN ('clock', 'manual', 'import', 'offline'));

-- Zona de fichaje del centro: no se comprueba, se registra o se exige estar dentro.
ALTER TABLE work_center
  ADD COLUMN latitude    double precision,
  ADD COLUMN longitude   double precision,
  ADD COLUMN radius_m    integer CHECK (radius_m BETWEEN 20 AND 5000),
  ADD COLUMN geo_policy  text NOT NULL DEFAULT 'off' CHECK (geo_policy IN ('off', 'record', 'require'));

-- Personas que pueden fichar fuera de la zona (teletrabajo, comerciales…).
ALTER TABLE employment ADD COLUMN remote_allowed boolean NOT NULL DEFAULT false;

-- PIN personal para el kiosco (hash bcrypt) y código corto para identificarse.
ALTER TABLE employment
  ADD COLUMN kiosk_code      text,
  ADD COLUMN kiosk_pin_hash  text;
CREATE UNIQUE INDEX employment_kiosk_code_uq ON employment (tenant_id, kiosk_code) WHERE kiosk_code IS NOT NULL;

-- Dispositivos de kiosco (tableta en la entrada). Se autentican con un token propio.
CREATE TABLE kiosk_device (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenant(id),
  work_center_id  uuid NOT NULL REFERENCES work_center(id),
  name            text NOT NULL,
  token_hash      text NOT NULL UNIQUE,
  active          boolean NOT NULL DEFAULT true,
  created_by      uuid NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  last_seen_at    timestamptz
);

-- El kiosco no tiene sesión: se localiza por el hash de su token.
CREATE OR REPLACE FUNCTION kiosk_by_token_hash(p_hash text)
RETURNS TABLE (tenant_id uuid, device_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT tenant_id, id FROM kiosk_device WHERE token_hash = p_hash AND active
$$;

SELECT enable_tenant_rls('kiosk_device');
REVOKE ALL ON FUNCTION kiosk_by_token_hash(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION kiosk_by_token_hash(text) TO openhr_app;
