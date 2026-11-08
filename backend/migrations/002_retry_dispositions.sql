CREATE TABLE IF NOT EXISTS retry_dispositions (
  event_id uuid PRIMARY KEY REFERENCES events(id),
  generation integer NOT NULL CHECK (generation >= 0),
  attempt integer NOT NULL CHECK (attempt > 0),
  outcome text NOT NULL CHECK (outcome IN ('success','transient','permanent','unknown')),
  state text NOT NULL CHECK (state IN ('completed','retry_scheduled','blocked')),
  delay_ms integer CHECK (delay_ms > 0),
  next_eligible_at timestamptz,
  reason text CHECK (reason IN ('permanent','unknown','exhausted')),
  CHECK ((state = 'retry_scheduled' AND delay_ms IS NOT NULL AND next_eligible_at IS NOT NULL AND reason IS NULL)
    OR (state = 'blocked' AND delay_ms IS NULL AND next_eligible_at IS NULL AND reason IS NOT NULL)
    OR (state = 'completed' AND delay_ms IS NULL AND next_eligible_at IS NULL AND reason IS NULL))
);
