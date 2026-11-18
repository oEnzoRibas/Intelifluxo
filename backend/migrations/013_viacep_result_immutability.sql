-- This trigger is intentionally independent of the existing shape constraints.
-- It does not enable v3 writes: those require the replacement v3 guards.
CREATE OR REPLACE FUNCTION guard_execution_result_immutability_v3() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.schema_version = 3 AND OLD.result IS NOT NULL THEN
    IF OLD.result->'lookup'->>'status' = 'found'
       AND NEW.result->'lookup' IS DISTINCT FROM OLD.result->'lookup' THEN
      RAISE EXCEPTION 'committed lookup observation is immutable' USING ERRCODE = '23514';
    END IF;
    IF OLD.result->'action'->>'status' IN ('executed', 'ignored')
       AND NEW.result IS DISTINCT FROM OLD.result THEN
      RAISE EXCEPTION 'terminal execution result is immutable' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS execution_result_immutable_v3 ON automation_executions;
CREATE TRIGGER execution_result_immutable_v3 BEFORE UPDATE ON automation_executions
FOR EACH ROW EXECUTE FUNCTION guard_execution_result_immutability_v3();
