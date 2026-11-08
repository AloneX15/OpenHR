-- OpenHR · V1 fase 5: registro retributivo (art. 28.2 ET y RD 902/2020)

-- Sexo registrado, necesario para el registro retributivo. NULL = no consta.
ALTER TABLE person ADD COLUMN sex text CHECK (sex IN ('female', 'male', 'other'));

-- Clasificación profesional (grupo, categoría o nivel del convenio).
ALTER TABLE employment ADD COLUMN professional_group text;

-- Jornada completa de referencia de cada sociedad (convenio), para equiparar salarios.
ALTER TABLE company ADD COLUMN full_time_weekly_minutes integer NOT NULL DEFAULT 2400 CHECK (full_time_weekly_minutes > 0);

-- Retribución anual pactada de una relación laboral a partir de una fecha (importes brutos
-- anuales a la jornada real de la persona). Dato salarial: solo RR. HH.
CREATE TABLE compensation (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL REFERENCES tenant(id),
  employment_id        uuid NOT NULL REFERENCES employment(id),
  effective_from       date NOT NULL,
  base_annual          numeric(12,2) NOT NULL CHECK (base_annual >= 0),        -- salario base
  complements_annual   numeric(12,2) NOT NULL DEFAULT 0 CHECK (complements_annual >= 0),  -- complementos salariales
  extra_salary_annual  numeric(12,2) NOT NULL DEFAULT 0 CHECK (extra_salary_annual >= 0), -- percepciones extrasalariales
  note                 text,
  created_by           uuid NOT NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (employment_id, effective_from)
);

SELECT enable_tenant_rls('compensation');
