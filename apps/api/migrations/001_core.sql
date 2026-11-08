-- OpenHR · núcleo multiempresa
-- Se ejecuta con el rol propietario. La aplicación se conecta con el rol openhr_app,
-- que no es propietario de las tablas y por tanto está sujeto a RLS (ver docs/adr/0001).

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Contexto de tenant de la transacción actual (fijado con SET LOCAL / set_config(..., true)).
CREATE OR REPLACE FUNCTION app_tenant_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('app.tenant_id', true), '')::uuid
$$;

-- Un tenant es una instalación lógica: normalmente un grupo de empresas (holding).
CREATE TABLE tenant (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Sociedad (persona jurídica con CIF propio).
CREATE TABLE company (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenant(id),
  name        text NOT NULL,
  legal_name  text NOT NULL,
  tax_id      text NOT NULL,           -- CIF
  ccc         text,                    -- código de cuenta de cotización
  address     text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, tax_id)
);

-- Centro de trabajo: fija zona horaria y festivos locales.
CREATE TABLE work_center (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenant(id),
  company_id  uuid NOT NULL REFERENCES company(id),
  name        text NOT NULL,
  timezone    text NOT NULL DEFAULT 'Europe/Madrid',
  region      text,                    -- comunidad autónoma (ISO 3166-2:ES), p. ej. ES-MD
  address     text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE department (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenant(id),
  company_id  uuid NOT NULL REFERENCES company(id),
  name        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, name)
);

-- Persona física. Una persona puede tener varias relaciones laborales en el grupo.
CREATE TABLE person (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenant(id),
  first_name   text NOT NULL,
  last_name    text NOT NULL,
  national_id  text,                   -- DNI / NIE
  email        text,
  phone        text,
  birth_date   date,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, national_id)
);

-- Cuenta de acceso. El email es único en toda la instalación para poder iniciar sesión
-- sin elegir antes el tenant.
CREATE TABLE app_user (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenant(id),
  person_id      uuid REFERENCES person(id),
  email          text NOT NULL,
  password_hash  text,
  totp_secret    text,                 -- cifrado con ENCRYPTION_KEY
  totp_enabled   boolean NOT NULL DEFAULT false,
  is_active      boolean NOT NULL DEFAULT true,
  last_login_at  timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX app_user_email_uq ON app_user (lower(email));

-- Roles administrativos. company_id NULL = todo el tenant.
-- Ser empleado o responsable no necesita fila aquí: se deriva de employment.
CREATE TABLE role_assignment (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenant(id),
  user_id     uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  company_id  uuid REFERENCES company(id),
  role        text NOT NULL CHECK (role IN ('admin', 'hr')),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX role_assignment_uq
  ON role_assignment (user_id, role, coalesce(company_id, '00000000-0000-0000-0000-000000000000'));

-- Relación laboral: una persona trabajando para una sociedad durante un periodo.
CREATE TABLE employment (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               uuid NOT NULL REFERENCES tenant(id),
  person_id               uuid NOT NULL REFERENCES person(id),
  company_id              uuid NOT NULL REFERENCES company(id),
  work_center_id          uuid REFERENCES work_center(id),
  department_id           uuid REFERENCES department(id),
  manager_employment_id   uuid REFERENCES employment(id),
  employee_number         text,
  job_title               text,
  contract_type           text,                  -- indefinido, temporal, fijo-discontinuo…
  start_date              date NOT NULL,
  end_date                date,
  weekly_minutes          integer NOT NULL DEFAULT 2400 CHECK (weekly_minutes >= 0),
  -- Jornada teórica en minutos por día ISO (1 = lunes … 7 = domingo).
  schedule                jsonb NOT NULL DEFAULT '{"1":480,"2":480,"3":480,"4":480,"5":480,"6":0,"7":0}',
  vacation_days_per_year  numeric(5,1) NOT NULL DEFAULT 22,  -- días laborables
  -- Último hash de la cadena de fichajes de esta relación (ver docs/adr/0002).
  time_chain_head         text,
  time_chain_seq          bigint NOT NULL DEFAULT 0,
  created_at              timestamptz NOT NULL DEFAULT now(),
  CHECK (end_date IS NULL OR end_date >= start_date)
);
CREATE INDEX employment_person_idx ON employment (person_id);
CREATE INDEX employment_company_idx ON employment (company_id);
CREATE INDEX employment_manager_idx ON employment (manager_employment_id);

-- Festivos: nacionales (sin sociedad ni centro), de sociedad o de centro.
CREATE TABLE holiday (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenant(id),
  company_id      uuid REFERENCES company(id),
  work_center_id  uuid REFERENCES work_center(id),
  date            date NOT NULL,
  name            text NOT NULL
);
CREATE INDEX holiday_date_idx ON holiday (tenant_id, date);

-- Auditoría de acciones administrativas (append-only).
CREATE TABLE audit_event (
  id           bigserial PRIMARY KEY,
  tenant_id    uuid NOT NULL REFERENCES tenant(id),
  actor_id     uuid,
  action       text NOT NULL,
  entity       text NOT NULL,
  entity_id    text,
  data         jsonb,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_event_entity_idx ON audit_event (tenant_id, entity, entity_id);

-- Notificaciones en la app (bandeja) y outbox transaccional para emails.
CREATE TABLE notification (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenant(id),
  user_id     uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  type        text NOT NULL,
  title       text NOT NULL,
  body        text,
  link        text,
  read_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notification_user_idx ON notification (user_id, created_at DESC);

CREATE TABLE outbox (
  id            bigserial PRIMARY KEY,
  tenant_id     uuid NOT NULL REFERENCES tenant(id),
  type          text NOT NULL,
  payload       jsonb NOT NULL,
  attempts      integer NOT NULL DEFAULT 0,
  last_error    text,
  available_at  timestamptz NOT NULL DEFAULT now(),
  processed_at  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX outbox_pending_idx ON outbox (available_at) WHERE processed_at IS NULL;
