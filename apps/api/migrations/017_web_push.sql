-- OpenHR · V1.1: avisos push en el navegador (Web Push con VAPID)

-- Una fila por navegador o dispositivo en el que la persona activó los avisos.
CREATE TABLE push_subscription (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenant(id),
  user_id       uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  endpoint      text NOT NULL CHECK (endpoint ~ '^https://'),
  p256dh        text NOT NULL,
  auth          text NOT NULL,
  user_agent    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_used_at  timestamptz,
  UNIQUE (tenant_id, endpoint)
);
CREATE INDEX push_subscription_user_idx ON push_subscription (user_id);

SELECT enable_tenant_rls('push_subscription');

-- El outbox redacta los envíos hechos; para el push no queda nada del contenido ni de las claves.
CREATE OR REPLACE FUNCTION outbox_finish(p_id bigint, p_error text) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  UPDATE outbox
     SET processed_at = CASE WHEN p_error IS NULL THEN now() END,
         payload = CASE WHEN p_error IS NULL AND type = 'push'
                        THEN jsonb_build_object('subscriptionId', payload->'subscriptionId', 'redacted', true)
                        WHEN p_error IS NULL
                        THEN jsonb_build_object('to', payload->'to', 'subject', payload->'subject', 'redacted', true)
                        ELSE payload END,
         last_error = p_error,
         available_at = CASE WHEN p_error IS NULL THEN available_at
                             ELSE now() + make_interval(mins => power(2, least(attempts, 8))::int) END
   WHERE id = p_id
$$;
