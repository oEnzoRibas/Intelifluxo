CREATE TABLE IF NOT EXISTS automation_definitions (
 id uuid PRIMARY KEY, scope text NOT NULL CHECK (length(scope) BETWEEN 1 AND 128),
 current_revision integer NOT NULL CHECK (current_revision > 0)
);
CREATE TABLE IF NOT EXISTS automation_definition_revisions (
 automation_id uuid NOT NULL REFERENCES automation_definitions(id), revision integer NOT NULL CHECK (revision > 0),
 name text NOT NULL CHECK (length(name) BETWEEN 1 AND 200), active boolean NOT NULL,
 schema_version integer NOT NULL CHECK (schema_version = 1),
 trigger_type text NOT NULL CHECK (trigger_type = 'receipt.v1'), action_type text NOT NULL CHECK (action_type = 'record-receipt.v1'),
 created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (automation_id, revision)
);
CREATE INDEX IF NOT EXISTS automation_definitions_scope_id_idx ON automation_definitions(scope, id);
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'automation_definitions'::regclass AND conname = 'automation_current_revision_fk') THEN
 ALTER TABLE automation_definitions ADD CONSTRAINT automation_current_revision_fk FOREIGN KEY (id,current_revision) REFERENCES automation_definition_revisions(automation_id,revision) DEFERRABLE INITIALLY DEFERRED;
 END IF;
END $$;
CREATE OR REPLACE FUNCTION automation_revision_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'automation revisions are immutable'; END $$;
DROP TRIGGER IF EXISTS automation_revision_immutable_trigger ON automation_definition_revisions;
CREATE TRIGGER automation_revision_immutable_trigger BEFORE UPDATE OR DELETE ON automation_definition_revisions FOR EACH ROW EXECUTE FUNCTION automation_revision_immutable();
CREATE OR REPLACE FUNCTION automation_definition_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.id <> OLD.id OR NEW.scope <> OLD.scope OR NEW.current_revision <> OLD.current_revision + 1 THEN RAISE EXCEPTION 'invalid automation definition update'; END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS automation_definition_guard_trigger ON automation_definitions;
CREATE TRIGGER automation_definition_guard_trigger BEFORE UPDATE ON automation_definitions FOR EACH ROW EXECUTE FUNCTION automation_definition_guard();
