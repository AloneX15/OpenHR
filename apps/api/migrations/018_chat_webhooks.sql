-- OpenHR · V1.1: avisos a canales de Slack y Microsoft Teams (webhooks entrantes)

CREATE TABLE chat_webhook (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenant(id),
  company_id     uuid REFERENCES company(id),             -- NULL: todas las sociedades
  provider       text NOT NULL CHECK (provider IN ('slack', 'teams')),
  label          text NOT NULL CHECK (length(label) BETWEEN 1 AND 80),
  url_enc        text NOT NULL,                           -- la URL del webhook es un secreto: cifrada
  url_hint       text NOT NULL,                           -- dominio, para reconocerla sin descifrar
  events         text[] NOT NULL CHECK (events <@ ARRAY['announcement', 'absence', 'welcome']::text[]),
  enabled        boolean NOT NULL DEFAULT true,
  last_sent_at   timestamptz,
  last_error     text,
  created_by     uuid NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);

SELECT enable_tenant_rls('chat_webhook');
