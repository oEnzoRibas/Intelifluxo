-- Complement the v2 envelope shape guard without changing its semantics for legacy rows.
ALTER TABLE automation_executions ADD CONSTRAINT automation_execution_target_valid_v2
CHECK (
  schema_version <> 2 OR result IS NULL OR (
    CASE result->'action'->>'status'
      WHEN 'executed' THEN result->'decision'->>'targetNodeId' = result->'action'->>'nodeId'
      WHEN 'pending' THEN result->'decision'->>'targetNodeId' = result->'action'->>'nodeId'
      WHEN 'ignored' THEN result->'decision'->>'targetNodeId' <> result->'action'->>'nodeId'
      WHEN 'not_executed' THEN result->'decision' = 'null'::jsonb OR
        (result->'decision'->>'outcome' = 'TRUE' AND
         result->'action'->>'nodeId' IS NOT NULL AND
         result->'decision'->>'targetNodeId' = result->'action'->>'nodeId')
      ELSE false
    END
  ) IS TRUE
) NOT VALID;
