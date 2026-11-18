CREATE TABLE IF NOT EXISTS forms (
 id uuid PRIMARY KEY,
 automation_id uuid NOT NULL UNIQUE REFERENCES automation_definitions(id),
 revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
 title text NOT NULL CHECK (length(title) BETWEEN 1 AND 160),
 description text NOT NULL DEFAULT '' CHECK (length(description) <= 500),
 city text NOT NULL CHECK (length(city) BETWEEN 1 AND 100),
 fields jsonb NOT NULL CHECK (jsonb_typeof(fields) = 'array'),
 published boolean NOT NULL DEFAULT false,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS form_submissions (
 form_id uuid NOT NULL REFERENCES forms(id),
 event_id uuid NOT NULL UNIQUE REFERENCES events(id),
 form_revision integer NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY (form_id,event_id)
);
CREATE INDEX IF NOT EXISTS form_submissions_recent_idx ON form_submissions(form_id,created_at DESC,event_id DESC);
ALTER TABLE form_submissions ADD COLUMN IF NOT EXISTS fields jsonb NOT NULL DEFAULT '[]'::jsonb;
