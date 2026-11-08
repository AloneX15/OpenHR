-- OpenHR · V1.1: encuestas de clima, eNPS y preguntas propias, anónimas o con nombre

CREATE TABLE survey (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenant(id),
  company_id      uuid REFERENCES company(id),          -- NULL: todo el grupo
  title           text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  description     text,
  anonymous       boolean NOT NULL DEFAULT true,
  -- Con respuestas anónimas no se enseñan resultados por debajo de este número.
  min_responses   integer NOT NULL DEFAULT 5 CHECK (min_responses BETWEEN 3 AND 50),
  status          text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'open', 'closed')),
  closes_on       date,
  opened_at       timestamptz,
  closed_at       timestamptz,
  created_by      uuid NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE survey_question (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenant(id),
  survey_id   uuid NOT NULL REFERENCES survey(id) ON DELETE CASCADE,
  position    integer NOT NULL,
  kind        text NOT NULL CHECK (kind IN ('scale', 'enps', 'choice', 'text')),
  text        text NOT NULL CHECK (length(text) BETWEEN 1 AND 500),
  options     text[] NOT NULL DEFAULT '{}',
  required    boolean NOT NULL DEFAULT true,
  UNIQUE (survey_id, position),
  CHECK (kind <> 'choice' OR cardinality(options) BETWEEN 2 AND 20)
);

-- Quién ha respondido (para no responder dos veces). En las anónimas no hay hora ni enlace
-- con la respuesta, para que no se puedan cruzar.
CREATE TABLE survey_participation (
  tenant_id  uuid NOT NULL REFERENCES tenant(id),
  survey_id  uuid NOT NULL REFERENCES survey(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  PRIMARY KEY (survey_id, user_id)
);

-- Respuestas. user_id solo en las encuestas con nombre; en las anónimas, solo el día.
CREATE TABLE survey_response (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenant(id),
  survey_id     uuid NOT NULL REFERENCES survey(id) ON DELETE CASCADE,
  user_id       uuid REFERENCES app_user(id) ON DELETE SET NULL,
  submitted_on  date NOT NULL DEFAULT current_date,
  answers       jsonb NOT NULL CHECK (jsonb_typeof(answers) = 'object')
);
CREATE INDEX survey_response_survey_idx ON survey_response (survey_id);

SELECT enable_tenant_rls(t::regclass) FROM unnest(ARRAY['survey', 'survey_question', 'survey_participation', 'survey_response']) AS t;
