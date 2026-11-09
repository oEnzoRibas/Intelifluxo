-- Pinned work must continue to observe the same event and execution identity.
-- This guard does not block cleanup deletes or updates to processing results.
CREATE OR REPLACE FUNCTION guard_event_identity_content_v1() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.id, NEW.scope, NEW.idempotency_key, NEW.content, NEW.created_at)
       IS DISTINCT FROM
     (OLD.id, OLD.scope, OLD.idempotency_key, OLD.content, OLD.created_at) THEN
    RAISE EXCEPTION 'event identity and content are immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS event_identity_content_immutable ON events;
CREATE TRIGGER event_identity_content_immutable BEFORE UPDATE ON events
FOR EACH ROW EXECUTE FUNCTION guard_event_identity_content_v1();

CREATE OR REPLACE FUNCTION guard_execution_identity_v1() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.id, NEW.event_id, NEW.automation_id, NEW.revision, NEW.schema_version,
      NEW.trigger_type, NEW.action_type, NEW.created_at)
       IS DISTINCT FROM
     (OLD.id, OLD.event_id, OLD.automation_id, OLD.revision, OLD.schema_version,
      OLD.trigger_type, OLD.action_type, OLD.created_at) THEN
    RAISE EXCEPTION 'execution identity is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS execution_identity_immutable ON automation_executions;
CREATE TRIGGER execution_identity_immutable BEFORE UPDATE ON automation_executions
FOR EACH ROW EXECUTE FUNCTION guard_execution_identity_v1();
