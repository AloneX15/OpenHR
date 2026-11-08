-- OpenHR · V1 fase 1: turnos con reglas de descanso, horas extra y bolsa de horas

-- Plantillas de turno de una sociedad (mañana, tarde, noche…). Horas locales del centro.
CREATE TABLE shift_template (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenant(id),
  company_id     uuid NOT NULL REFERENCES company(id),
  name           text NOT NULL,
  start_time     time NOT NULL,
  end_time       time NOT NULL,          -- si es <= start_time, el turno acaba al día siguiente
  break_minutes  integer NOT NULL DEFAULT 0 CHECK (break_minutes >= 0),
  color          text NOT NULL DEFAULT 'sky' CHECK (color IN ('sky', 'navy', 'teal', 'amber', 'violet', 'rose', 'slate')),
  active         boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, name)
);

-- Turno asignado a una relación laboral en un día (fecha local de inicio del turno).
-- Sustituye a la jornada teórica semanal ese día. Un día libre planificado se marca con
-- is_day_off = true.
CREATE TABLE shift_assignment (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenant(id),
  employment_id      uuid NOT NULL REFERENCES employment(id),
  date               date NOT NULL,
  shift_template_id  uuid REFERENCES shift_template(id),
  is_day_off         boolean NOT NULL DEFAULT false,
  start_at           timestamptz,
  end_at             timestamptz,
  break_minutes      integer NOT NULL DEFAULT 0 CHECK (break_minutes >= 0),
  note               text,
  published_at       timestamptz,
  created_by         uuid NOT NULL,
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (employment_id, date),
  CHECK (is_day_off OR (start_at IS NOT NULL AND end_at IS NOT NULL AND end_at > start_at))
);
CREATE INDEX shift_assignment_date_idx ON shift_assignment (tenant_id, date);

-- Bolsa de horas: se activa por relación laboral desde una fecha.
ALTER TABLE employment
  ADD COLUMN hour_bank_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN hour_bank_start   date;

-- Movimientos manuales de la bolsa (horas pagadas en nómina, saldo inicial, regularización…).
CREATE TABLE hour_bank_adjustment (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenant(id),
  employment_id  uuid NOT NULL REFERENCES employment(id),
  date           date NOT NULL,
  minutes        integer NOT NULL,       -- positivo suma a la bolsa, negativo la reduce
  kind           text NOT NULL CHECK (kind IN ('opening', 'paid', 'adjustment')),
  reason         text NOT NULL,
  created_by     uuid NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- Un tipo de ausencia puede consumir la bolsa (p. ej. «Compensación de horas»).
ALTER TABLE absence_type ADD COLUMN consumes_hour_bank boolean NOT NULL DEFAULT false;

INSERT INTO absence_type (tenant_id, code, name, paid, counts_as_vacation, requires_approval, day_unit, sensitive, consumes_hour_bank)
SELECT id, 'COMP', 'Compensación de horas (bolsa)', true, false, true, 'working', false, true FROM tenant
ON CONFLICT (tenant_id, code) DO NOTHING;

-- Reglas de descanso configurables por sociedad (valores por defecto del Estatuto de los
-- Trabajadores; un convenio puede cambiarlos).
ALTER TABLE company
  ADD COLUMN min_rest_between_shifts_minutes integer NOT NULL DEFAULT 720,   -- art. 34.3: 12 h
  ADD COLUMN max_daily_ordinary_minutes      integer NOT NULL DEFAULT 540,   -- art. 34.3: 9 h
  ADD COLUMN min_weekly_rest_minutes         integer NOT NULL DEFAULT 2160,  -- art. 37.1: día y medio
  ADD COLUMN max_yearly_overtime_minutes     integer NOT NULL DEFAULT 4800;  -- art. 35.2: 80 h

SELECT enable_tenant_rls(t::regclass) FROM unnest(ARRAY['shift_template', 'shift_assignment', 'hour_bank_adjustment']) AS t;
