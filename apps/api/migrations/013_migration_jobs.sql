-- OpenHR · V1 fase 8: migración desde Factorial

-- Correspondencia entre identificadores externos y de OpenHR: permite repetir la migración
-- sin duplicar nada (y actualizar lo que cambió).
CREATE TABLE migration_mapping (
  tenant_id    uuid NOT NULL REFERENCES tenant(id),
  source       text NOT NULL,          -- 'factorial'
  entity       text NOT NULL,          -- legal_entity, location, team, employee, leave_type, leave, shift
  external_id  text NOT NULL,
  internal_id  uuid NOT NULL,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, source, entity, external_id)
);

-- Ejecuciones de migración (la clave de la API nunca se guarda).
CREATE TABLE migration_job (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenant(id),
  source       text NOT NULL,
  dry_run      boolean NOT NULL,
  options      jsonb NOT NULL,
  status       text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'done', 'failed')),
  counts       jsonb NOT NULL DEFAULT '{}',
  log          text[] NOT NULL DEFAULT '{}',
  error        text,
  started_by   uuid NOT NULL,
  started_at   timestamptz NOT NULL DEFAULT now(),
  finished_at  timestamptz
);

SELECT enable_tenant_rls(t::regclass) FROM unnest(ARRAY['migration_mapping', 'migration_job']) AS t;
