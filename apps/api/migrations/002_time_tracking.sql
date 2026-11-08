-- OpenHR · registro de jornada (art. 34.9 ET)
-- Los fichajes son inmutables: una corrección es un evento nuevo que anula otro
-- (kind = 'void') o que declara uno olvidado (source = 'manual'). Ver docs/adr/0002.

CREATE TABLE time_entry (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenant(id),
  employment_id      uuid NOT NULL REFERENCES employment(id),
  seq                bigint NOT NULL,                 -- posición en la cadena de la relación laboral
  kind               text NOT NULL CHECK (kind IN ('in', 'out', 'break_start', 'break_end', 'void')),
  -- Momento del fichaje. Para source = 'clock' es la hora del servidor al recibirlo;
  -- para 'manual' es la hora declarada por quien corrige.
  occurred_at        timestamptz NOT NULL,
  recorded_at        timestamptz NOT NULL DEFAULT now(),
  device_time        timestamptz,                     -- hora que decía el dispositivo (informativa)
  source             text NOT NULL CHECK (source IN ('clock', 'manual', 'import')),
  voids_entry_id     uuid REFERENCES time_entry(id),
  reason             text,
  created_by         uuid NOT NULL,                   -- app_user que lo registró
  idempotency_key    text,
  content_digest     text NOT NULL,                   -- sha256 del contenido canónico
  prev_hash          text,
  hash               text NOT NULL,                   -- sha256(prev_hash || content_digest)
  UNIQUE (employment_id, seq),
  CHECK (kind <> 'void' OR (voids_entry_id IS NOT NULL AND reason IS NOT NULL)),
  CHECK (source = 'clock' OR reason IS NOT NULL)
);
CREATE UNIQUE INDEX time_entry_idem_uq ON time_entry (tenant_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE INDEX time_entry_emp_time_idx ON time_entry (employment_id, occurred_at);
CREATE UNIQUE INDEX time_entry_void_once_uq ON time_entry (voids_entry_id)
  WHERE voids_entry_id IS NOT NULL;

-- Defensa en profundidad: nadie (ni el propietario) puede modificar o borrar fichajes
-- por SQL normal. La purga por retención usará una función dedicada que trabaje por
-- periodos sellados (pendiente, ver ADR 0002).
CREATE OR REPLACE FUNCTION time_entry_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'time_entry es inmutable: registra una corrección en su lugar'
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

CREATE TRIGGER time_entry_no_update BEFORE UPDATE OR DELETE ON time_entry
  FOR EACH ROW EXECUTE FUNCTION time_entry_immutable();
CREATE TRIGGER time_entry_no_truncate BEFORE TRUNCATE ON time_entry
  FOR EACH STATEMENT EXECUTE FUNCTION time_entry_immutable();

-- Sellos de la cadena: instantáneas de las cabezas de cadena que se envían fuera del
-- sistema (email a la empresa) para que una reescritura de la base de datos sea detectable.
CREATE TABLE time_chain_seal (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenant(id),
  company_id    uuid NOT NULL REFERENCES company(id),
  sealed_at     timestamptz NOT NULL DEFAULT now(),
  heads         jsonb NOT NULL,                      -- {employment_id: {seq, hash}}
  digest        text NOT NULL,                       -- sha256 de heads canónico
  sent_to       text[]
);
