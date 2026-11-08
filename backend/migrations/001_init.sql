CREATE TABLE IF NOT EXISTS events (
  id uuid PRIMARY KEY,
  scope text NOT NULL,
  idempotency_key text NOT NULL,
  content jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (scope, idempotency_key)
);
CREATE TABLE IF NOT EXISTS target_snapshots (
  event_id uuid PRIMARY KEY REFERENCES events(id),
  target text NOT NULL CHECK (target = 'local-receipt'),
  version integer NOT NULL CHECK (version = 1)
);
CREATE TABLE IF NOT EXISTS audit (
  event_id uuid PRIMARY KEY REFERENCES events(id),
  action text NOT NULL CHECK (action = 'accepted'),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS outbox (
  event_id uuid PRIMARY KEY REFERENCES events(id),
  confirmed_at timestamptz
);
CREATE TABLE IF NOT EXISTS receipts (
  event_id uuid PRIMARY KEY REFERENCES events(id),
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
