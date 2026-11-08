-- OpenHR · V1 fase 3: altas, bajas y traspasos con checklist; campos personalizados

-- Plantillas de checklist. company_id NULL = para todo el grupo.
CREATE TABLE checklist_template (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenant(id),
  company_id  uuid REFERENCES company(id),
  kind        text NOT NULL CHECK (kind IN ('onboarding', 'offboarding', 'transfer')),
  name        text NOT NULL,
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE checklist_template_item (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenant(id),
  template_id      uuid NOT NULL REFERENCES checklist_template(id) ON DELETE CASCADE,
  position         integer NOT NULL,
  title            text NOT NULL,
  description      text,
  assignee         text NOT NULL CHECK (assignee IN ('hr', 'manager', 'employee')),
  due_offset_days  integer NOT NULL DEFAULT 0   -- respecto a la fecha de alta, baja o traspaso
);

-- Checklist en curso de una relación laboral.
CREATE TABLE checklist (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenant(id),
  employment_id   uuid NOT NULL REFERENCES employment(id),
  kind            text NOT NULL CHECK (kind IN ('onboarding', 'offboarding', 'transfer')),
  template_id     uuid REFERENCES checklist_template(id) ON DELETE SET NULL,
  name            text NOT NULL,
  reference_date  date NOT NULL,
  status          text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done', 'cancelled')),
  created_by      uuid NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  completed_at    timestamptz
);
CREATE INDEX checklist_employment_idx ON checklist (employment_id);

CREATE TABLE checklist_task (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenant(id),
  checklist_id  uuid NOT NULL REFERENCES checklist(id) ON DELETE CASCADE,
  position      integer NOT NULL,
  title         text NOT NULL,
  description   text,
  assignee      text NOT NULL CHECK (assignee IN ('hr', 'manager', 'employee')),
  due_date      date,
  done_at       timestamptz,
  done_by       uuid,
  note          text
);
CREATE INDEX checklist_task_open_idx ON checklist_task (tenant_id, assignee) WHERE done_at IS NULL;

-- Traspasos: la relación laboral nueva recuerda de cuál viene.
ALTER TABLE employment ADD COLUMN transferred_from_employment_id uuid REFERENCES employment(id);

-- Campos personalizados. Los valores viven en custom_values (jsonb) de person o employment.
CREATE TABLE custom_field (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenant(id),
  entity      text NOT NULL CHECK (entity IN ('person', 'employment')),
  key         text NOT NULL CHECK (key ~ '^[a-z][a-z0-9_]{1,40}$'),
  label       text NOT NULL,
  type        text NOT NULL CHECK (type IN ('text', 'number', 'date', 'boolean', 'select')),
  options     jsonb NOT NULL DEFAULT '[]',
  required    boolean NOT NULL DEFAULT false,
  -- Quién puede verlo además de RR. HH.: solo RR. HH., también el responsable, o también la persona.
  visibility  text NOT NULL DEFAULT 'hr' CHECK (visibility IN ('hr', 'manager', 'employee')),
  position    integer NOT NULL DEFAULT 0,
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, entity, key)
);

ALTER TABLE person ADD COLUMN custom_values jsonb NOT NULL DEFAULT '{}';
ALTER TABLE employment ADD COLUMN custom_values jsonb NOT NULL DEFAULT '{}';

SELECT enable_tenant_rls(t::regclass) FROM unnest(ARRAY[
  'checklist_template', 'checklist_template_item', 'checklist', 'checklist_task', 'custom_field'
]) AS t;
