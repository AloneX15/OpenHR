-- OpenHR · V1.1: gastos con justificante y aprobación

-- Categorías de gasto del grupo. Las de kilometraje calculan el importe con la tarifa por km.
CREATE TABLE expense_category (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenant(id),
  name               text NOT NULL,
  kind               text NOT NULL DEFAULT 'amount' CHECK (kind IN ('amount', 'mileage')),
  rate_cents_per_km  integer CHECK (rate_cents_per_km > 0),
  limit_cents        integer CHECK (limit_cents > 0),     -- aviso si se supera, no bloquea
  requires_receipt   boolean NOT NULL DEFAULT true,
  active             boolean NOT NULL DEFAULT true,
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name),
  CHECK (kind = 'amount' OR rate_cents_per_km IS NOT NULL)
);

-- Cada gasto pasa por el responsable directo (si lo hay) y después por RR. HH.
CREATE TABLE expense (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenant(id),
  employment_id       uuid NOT NULL REFERENCES employment(id),
  company_id          uuid NOT NULL REFERENCES company(id),
  category_id         uuid NOT NULL REFERENCES expense_category(id),
  expense_date        date NOT NULL,
  description         text NOT NULL CHECK (length(description) BETWEEN 1 AND 500),
  amount_cents        integer NOT NULL CHECK (amount_cents > 0 AND amount_cents <= 10000000),
  km                  numeric(8,1) CHECK (km > 0),
  receipt_file_id     uuid REFERENCES stored_file(id),
  status              text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'paid', 'cancelled')),
  stage               text CHECK (stage IN ('manager', 'hr')),   -- solo mientras está pendiente
  created_by          uuid NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  manager_decided_by  uuid,
  manager_decided_at  timestamptz,
  hr_decided_by       uuid,
  hr_decided_at       timestamptz,
  decision_comment    text,
  paid_at             timestamptz,
  paid_period         text CHECK (paid_period ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  CHECK ((status = 'pending') = (stage IS NOT NULL))
);
CREATE INDEX expense_employment_idx ON expense (employment_id, expense_date DESC);
CREATE INDEX expense_pending_idx ON expense (tenant_id, stage) WHERE status = 'pending';

SELECT enable_tenant_rls('expense_category');
SELECT enable_tenant_rls('expense');

-- Categorías de partida para los grupos ya creados. 0,26 €/km es el importe exento de IRPF.
INSERT INTO expense_category (tenant_id, name, kind, rate_cents_per_km, limit_cents, requires_receipt)
SELECT t.id, c.name, c.kind, c.rate, c.lim, c.receipt
  FROM tenant t CROSS JOIN (VALUES
    ('Comidas', 'amount', NULL::integer, NULL::integer, true),
    ('Transporte', 'amount', NULL, NULL, true),
    ('Alojamiento', 'amount', NULL, NULL, true),
    ('Kilometraje', 'mileage', 26, NULL, false),
    ('Otros', 'amount', NULL, NULL, true)
  ) AS c(name, kind, rate, lim, receipt)
ON CONFLICT DO NOTHING;
