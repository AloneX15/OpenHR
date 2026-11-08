-- OpenHR · V1 fase 2: aprobaciones multinivel y delegación

-- Circuito de aprobación. Se elige el más específico: sociedad + tipo, sociedad, tipo y,
-- por último, el general (ambos NULL). Sin ninguno: un paso, el responsable directo.
-- steps: [{"kind":"manager"} | {"kind":"manager_of_manager"} | {"kind":"hr"} | {"kind":"user","userId":"…"}]
CREATE TABLE approval_flow (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenant(id),
  company_id       uuid REFERENCES company(id),
  absence_type_id  uuid REFERENCES absence_type(id),
  steps            jsonb NOT NULL CHECK (jsonb_typeof(steps) = 'array' AND jsonb_array_length(steps) BETWEEN 1 AND 5),
  updated_by       uuid,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE NULLS NOT DISTINCT (tenant_id, company_id, absence_type_id)
);

-- Pasos de cada solicitud. Los aprobadores se resuelven al activar el paso.
CREATE TABLE approval_step (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenant(id),
  request_id         uuid NOT NULL REFERENCES absence_request(id) ON DELETE CASCADE,
  step_index         integer NOT NULL,
  kind               text NOT NULL CHECK (kind IN ('manager', 'manager_of_manager', 'hr', 'user', 'admin')),
  target_user_id     uuid,                  -- para kind = 'user'
  approver_user_ids  uuid[] NOT NULL DEFAULT '{}',
  status             text NOT NULL DEFAULT 'waiting'
                       CHECK (status IN ('waiting', 'pending', 'approved', 'rejected', 'skipped', 'cancelled')),
  decided_by         uuid,
  decided_as         text CHECK (decided_as IN ('approver', 'delegate', 'hr')),
  decided_at         timestamptz,
  comment            text,
  UNIQUE (request_id, step_index)
);
CREATE INDEX approval_step_pending_idx ON approval_step (tenant_id, status) WHERE status = 'pending';

ALTER TABLE absence_request ADD COLUMN current_step integer;

-- Delegación: durante unas fechas, otra persona puede aprobar en mi lugar.
CREATE TABLE approval_delegation (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenant(id),
  from_user_id  uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  to_user_id    uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  start_date    date NOT NULL,
  end_date      date NOT NULL,
  reason        text,
  created_by    uuid NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CHECK (from_user_id <> to_user_id),
  CHECK (end_date >= start_date)
);
CREATE INDEX approval_delegation_active_idx ON approval_delegation (to_user_id, start_date, end_date);

SELECT enable_tenant_rls(t::regclass) FROM unnest(ARRAY['approval_flow', 'approval_step', 'approval_delegation']) AS t;

-- Las solicitudes pendientes anteriores pasan a tener un paso: el responsable o RR. HH.
INSERT INTO approval_step (tenant_id, request_id, step_index, kind, status)
SELECT tenant_id, id, 0, 'manager', 'pending' FROM absence_request WHERE status = 'pending';
UPDATE absence_request SET current_step = 0 WHERE status = 'pending';
