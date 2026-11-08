-- OpenHR · ausencias, vacaciones y permisos

CREATE TABLE absence_type (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenant(id),
  code                text NOT NULL,
  name                text NOT NULL,
  paid                boolean NOT NULL DEFAULT true,
  counts_as_vacation  boolean NOT NULL DEFAULT false,  -- descuenta del saldo de vacaciones
  requires_approval   boolean NOT NULL DEFAULT true,
  -- 'working' = días laborables según la jornada teórica; 'calendar' = días naturales.
  day_unit            text NOT NULL DEFAULT 'working' CHECK (day_unit IN ('working', 'calendar')),
  -- Datos de salud: solo RR. HH. ve el motivo y los adjuntos (no el responsable).
  sensitive           boolean NOT NULL DEFAULT false,
  active              boolean NOT NULL DEFAULT true,
  UNIQUE (tenant_id, code)
);

CREATE TABLE absence_request (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenant(id),
  employment_id     uuid NOT NULL REFERENCES employment(id),
  absence_type_id   uuid NOT NULL REFERENCES absence_type(id),
  start_date        date NOT NULL,
  end_date          date NOT NULL,
  days              numeric(5,1) NOT NULL,
  status            text NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled')),
  comment           text,
  requested_by      uuid NOT NULL,
  decided_by        uuid,
  decided_at        timestamptz,
  decision_comment  text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CHECK (end_date >= start_date)
);
CREATE INDEX absence_request_emp_idx ON absence_request (employment_id, start_date);
CREATE INDEX absence_request_status_idx ON absence_request (tenant_id, status);

-- Ajustes manuales del saldo de vacaciones (días arrastrados, compensaciones…).
CREATE TABLE vacation_adjustment (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenant(id),
  employment_id  uuid NOT NULL REFERENCES employment(id),
  year           integer NOT NULL,
  days           numeric(5,1) NOT NULL,
  reason         text NOT NULL,
  created_by     uuid NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);
