CREATE TABLE IF NOT EXISTS event_automation_context (
 event_id uuid PRIMARY KEY REFERENCES events(id), trigger_type text NOT NULL
);
CREATE TABLE IF NOT EXISTS automation_executions (
 id uuid PRIMARY KEY, event_id uuid NOT NULL REFERENCES event_automation_context(event_id),
 automation_id uuid NOT NULL, revision integer NOT NULL,
 schema_version integer NOT NULL, trigger_type text NOT NULL, action_type text NOT NULL,
 result jsonb, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE (event_id, automation_id),
 FOREIGN KEY (automation_id, revision) REFERENCES automation_definition_revisions(automation_id, revision)
);
CREATE INDEX IF NOT EXISTS automation_executions_automation_id_id_idx ON automation_executions(automation_id,id);
