-- OpenHR · V1.1: consultas internas a RR. HH. (tickets)

CREATE TABLE ticket_category (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenant(id),
  name        text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  active      boolean NOT NULL DEFAULT true,
  UNIQUE (tenant_id, name)
);

CREATE TABLE ticket (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenant(id),
  number             bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  company_id         uuid NOT NULL REFERENCES company(id),
  requester_user_id  uuid NOT NULL REFERENCES app_user(id),
  category_id        uuid NOT NULL REFERENCES ticket_category(id),
  subject            text NOT NULL CHECK (length(subject) BETWEEN 1 AND 200),
  status             text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_progress', 'waiting', 'resolved', 'closed')),
  priority           text NOT NULL DEFAULT 'normal' CHECK (priority IN ('normal', 'high')),
  assignee_user_id   uuid REFERENCES app_user(id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  resolved_at        timestamptz
);
CREATE INDEX ticket_queue_idx ON ticket (tenant_id, status, company_id);
CREATE INDEX ticket_requester_idx ON ticket (requester_user_id, created_at DESC);

-- Conversación. Las notas internas solo las ve RR. HH.
CREATE TABLE ticket_message (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenant(id),
  ticket_id       uuid NOT NULL REFERENCES ticket(id) ON DELETE CASCADE,
  author_user_id  uuid NOT NULL REFERENCES app_user(id),
  body            text NOT NULL CHECK (length(body) BETWEEN 1 AND 10000),
  internal        boolean NOT NULL DEFAULT false,
  file_id         uuid REFERENCES stored_file(id),
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ticket_message_ticket_idx ON ticket_message (ticket_id, created_at);

SELECT enable_tenant_rls(t::regclass) FROM unnest(ARRAY['ticket_category', 'ticket', 'ticket_message']) AS t;

INSERT INTO ticket_category (tenant_id, name)
SELECT t.id, c.name FROM tenant t CROSS JOIN (VALUES
  ('Nómina'), ('Contrato y documentos'), ('Certificados'), ('Vacaciones y ausencias'), ('Datos personales'), ('Otros')
) AS c(name)
ON CONFLICT DO NOTHING;
