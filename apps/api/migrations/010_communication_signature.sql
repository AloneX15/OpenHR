-- OpenHR · V1 fase 4: anuncios, políticas con aceptación y firma individual

-- Anuncios. company_id NULL = para todo el grupo.
CREATE TABLE announcement (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenant(id),
  company_id    uuid REFERENCES company(id),
  title         text NOT NULL,
  body          text NOT NULL,
  pinned        boolean NOT NULL DEFAULT false,
  published_at  timestamptz NOT NULL DEFAULT now(),
  expires_at    date,
  archived      boolean NOT NULL DEFAULT false,
  created_by    uuid NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX announcement_published_idx ON announcement (tenant_id, published_at DESC);

CREATE TABLE announcement_read (
  tenant_id        uuid NOT NULL REFERENCES tenant(id),
  announcement_id  uuid NOT NULL REFERENCES announcement(id) ON DELETE CASCADE,
  user_id          uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  read_at          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (announcement_id, user_id)
);

-- Políticas internas (código de conducta, teletrabajo, desconexión digital…) con aceptación.
CREATE TABLE policy (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL REFERENCES tenant(id),
  company_id           uuid REFERENCES company(id),
  series_id            uuid NOT NULL,             -- agrupa las versiones de una misma política
  version              integer NOT NULL DEFAULT 1,
  title                text NOT NULL,
  description          text,
  file_id              uuid NOT NULL REFERENCES stored_file(id),
  requires_acceptance  boolean NOT NULL DEFAULT true,
  status               text NOT NULL DEFAULT 'published' CHECK (status IN ('published', 'archived')),
  published_at         timestamptz NOT NULL DEFAULT now(),
  created_by           uuid NOT NULL,
  UNIQUE (series_id, version)
);

-- Aceptación (registro de quién leyó y aceptó qué versión, con huella del fichero).
CREATE TABLE policy_acceptance (
  tenant_id    uuid NOT NULL REFERENCES tenant(id),
  policy_id    uuid NOT NULL REFERENCES policy(id),
  person_id    uuid NOT NULL REFERENCES person(id),
  user_id      uuid NOT NULL,
  accepted_at  timestamptz NOT NULL DEFAULT now(),
  file_sha256  text NOT NULL,
  ip           text,
  user_agent   text,
  PRIMARY KEY (policy_id, person_id)
);

-- Firma individual (firma electrónica simple con doble factor y evidencias; ver docs).
CREATE TABLE signature_request (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenant(id),
  company_id       uuid NOT NULL REFERENCES company(id),
  person_id        uuid NOT NULL REFERENCES person(id),
  title            text NOT NULL,
  message          text,
  file_id          uuid NOT NULL REFERENCES stored_file(id),
  status           text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'signed', 'declined', 'cancelled')),
  requested_by     uuid NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  due_date         date,
  otp_hash         text,
  otp_expires_at   timestamptz,
  otp_attempts     integer NOT NULL DEFAULT 0,
  signed_at        timestamptz,
  signed_file_id   uuid REFERENCES stored_file(id),
  document_id      uuid REFERENCES document(id),
  evidence         jsonb,
  decline_reason   text
);
CREATE INDEX signature_request_person_idx ON signature_request (person_id, status);

-- Documentos firmados en «Mis documentos».
ALTER TABLE document DROP CONSTRAINT document_category_check;
ALTER TABLE document ADD CONSTRAINT document_category_check
  CHECK (category IN ('payslip', 'contract', 'certificate', 'policy', 'signed', 'other'));

SELECT enable_tenant_rls(t::regclass) FROM unnest(ARRAY[
  'announcement', 'announcement_read', 'policy', 'policy_acceptance', 'signature_request'
]) AS t;
