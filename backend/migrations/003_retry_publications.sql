CREATE TABLE IF NOT EXISTS retry_publications (
  event_id uuid NOT NULL REFERENCES events(id),
  generation integer NOT NULL CHECK (generation > 0),
  confirmed_at timestamptz,
  processed_at timestamptz,
  PRIMARY KEY (event_id, generation)
);
