-- OpenHR · documentos y reparto de nóminas

CREATE TABLE stored_file (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenant(id),
  storage_key   text NOT NULL,
  filename      text NOT NULL,
  content_type  text NOT NULL,
  size_bytes    bigint NOT NULL,
  sha256        text NOT NULL,
  created_by    uuid,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- Documento visible para una persona ("Mis documentos").
CREATE TABLE document (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenant(id),
  person_id      uuid NOT NULL REFERENCES person(id),
  company_id     uuid REFERENCES company(id),
  file_id        uuid NOT NULL REFERENCES stored_file(id),
  category       text NOT NULL CHECK (category IN ('payslip', 'contract', 'certificate', 'other')),
  title          text NOT NULL,
  period         text,                                 -- YYYY-MM para nóminas
  batch_id       uuid,
  published_at   timestamptz NOT NULL DEFAULT now(),
  first_read_at  timestamptz,                          -- acuse de lectura (no es firma)
  created_by     uuid,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX document_person_idx ON document (person_id, published_at DESC);

-- Lote de nóminas: un PDF con todas las nóminas de una sociedad y un mes.
CREATE TABLE payslip_batch (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenant(id),
  company_id    uuid NOT NULL REFERENCES company(id),
  period        text NOT NULL CHECK (period ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  file_id       uuid NOT NULL REFERENCES stored_file(id),
  page_count    integer NOT NULL,
  status        text NOT NULL DEFAULT 'review' CHECK (status IN ('review', 'published', 'discarded')),
  created_by    uuid NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  published_by  uuid,
  published_at  timestamptz
);

-- Una fila por página. La asignación detectada es solo una sugerencia: cada página debe
-- confirmarse (o descartarse) por una persona de RR. HH. antes de publicar.
CREATE TABLE payslip_page (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL REFERENCES tenant(id),
  batch_id              uuid NOT NULL REFERENCES payslip_batch(id) ON DELETE CASCADE,
  page_number           integer NOT NULL,
  detected_ids          text[] NOT NULL DEFAULT '{}',
  suggested_person_id   uuid REFERENCES person(id),
  person_id             uuid REFERENCES person(id),
  review_status         text NOT NULL DEFAULT 'pending'
                          CHECK (review_status IN ('pending', 'confirmed', 'skipped')),
  reviewed_by           uuid,
  reviewed_at           timestamptz,
  UNIQUE (batch_id, page_number),
  CHECK (review_status <> 'confirmed' OR person_id IS NOT NULL)
);
