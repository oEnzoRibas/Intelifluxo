CREATE TABLE IF NOT EXISTS google_form_connections (
 id uuid PRIMARY KEY,
 form_id uuid NOT NULL UNIQUE REFERENCES forms(id),
 form_url text NOT NULL,
 cep_question text NOT NULL,
 message_question text NOT NULL DEFAULT '',
 public_base_url text NOT NULL,
 token_hash text,
 last_received_at timestamptz,
 last_event_id uuid REFERENCES events(id),
 created_at timestamptz NOT NULL DEFAULT now()
);
