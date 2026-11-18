-- Row-local v3 contract only. Pinned graph/input correspondence and event-level
-- lifecycle/aggregate disposition remain application invariants under the event lock.
BEGIN;

CREATE OR REPLACE FUNCTION automation_failure_guard_v3(f jsonb)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE c text; k text;
BEGIN
 IF jsonb_typeof(f) IS DISTINCT FROM 'object' OR NOT (f ?& ARRAY['classification','code','nodeId'])
    OR f - ARRAY['classification','code','nodeId'] <> '{}'::jsonb
    OR jsonb_typeof(f->'classification') IS DISTINCT FROM 'string'
    OR jsonb_typeof(f->'code') IS DISTINCT FROM 'string'
    OR (f->'nodeId' IS DISTINCT FROM 'null'::jsonb AND
        (jsonb_typeof(f->'nodeId') IS DISTINCT FROM 'string' OR f->>'nodeId' !~ '^[A-Za-z][A-Za-z0-9_-]{0,63}$')) THEN RETURN false; END IF;
 c := f->>'classification'; k := f->>'code';
 RETURN CASE
  WHEN k IN ('invalid_condition_config','invalid_condition_value','condition_type_mismatch','action_permanent',
             'invalid_cep','viacep_not_found','viacep_http_permanent','viacep_invalid_response','viacep_security_rejected') THEN c = 'permanent'
  WHEN k IN ('action_transient','viacep_timeout','viacep_transport','viacep_http_transient') THEN c = 'transient'
  WHEN k IN ('unsupported_execution_contract','action_unknown','viacep_unknown') THEN c = 'unknown'
  WHEN k = 'retry_exhausted' THEN c = 'exhausted'
  WHEN k = 'event_peer_failure' THEN c IN ('transient','permanent','unknown','exhausted') AND f->'nodeId' = 'null'::jsonb
  ELSE false END;
END $$;

CREATE OR REPLACE FUNCTION automation_result_guard_v3(v integer, event_id uuid, result jsonb)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE l jsonb; addr jsonb; lf jsonb; d jsonb; a jsonb; f jsonb; r jsonb;
        item record; cep text; ls text; outcome text; status text;
BEGIN
 IF v IN (1,2) THEN RETURN automation_result_guard_v2(v,event_id,result); END IF;
 IF v IS DISTINCT FROM 3 THEN RETURN false; END IF;
 IF result IS NULL THEN RETURN true; END IF;
 IF jsonb_typeof(result) IS DISTINCT FROM 'object' OR NOT (result ?& ARRAY['kind','eventId','lookup','decision','action','failure'])
    OR result - ARRAY['kind','eventId','lookup','decision','action','failure'] <> '{}'::jsonb
    OR result->'kind' IS DISTINCT FROM '"viacep-condition-execution.v1"'::jsonb
    OR jsonb_typeof(result->'eventId') IS DISTINCT FROM 'string' OR result->>'eventId' IS DISTINCT FROM event_id::text THEN RETURN false; END IF;
 l := result->'lookup'; d := result->'decision'; a := result->'action'; f := result->'failure';
 IF f IS DISTINCT FROM 'null'::jsonb AND NOT automation_failure_guard_v3(f) THEN RETURN false; END IF;
 IF l = 'null'::jsonb THEN
  IF d IS DISTINCT FROM 'null'::jsonb OR f IS DISTINCT FROM
     '{"classification":"unknown","code":"unsupported_execution_contract","nodeId":null}'::jsonb
     OR a IS DISTINCT FROM '{"nodeId":null,"status":"not_executed","receipt":null}'::jsonb THEN RETURN false; END IF;
 ELSE
  IF jsonb_typeof(l) IS DISTINCT FROM 'object' OR NOT (l ?& ARRAY['nodeId','kind','status','cep','address','failure'])
     OR l - ARRAY['nodeId','kind','status','cep','address','failure'] <> '{}'::jsonb
     OR jsonb_typeof(l->'nodeId') IS DISTINCT FROM 'string' OR l->>'nodeId' !~ '^[A-Za-z][A-Za-z0-9_-]{0,63}$'
     OR l->'kind' IS DISTINCT FROM '"viacep-address-result.v1"'::jsonb
     OR jsonb_typeof(l->'status') IS DISTINCT FROM 'string' OR l->>'status' NOT IN ('found','not_found','failed') THEN RETURN false; END IF;
  ls := l->>'status'; lf := l->'failure'; addr := l->'address';
  IF l->'cep' IS DISTINCT FROM 'null'::jsonb THEN
   IF jsonb_typeof(l->'cep') IS DISTINCT FROM 'string' OR length(l->>'cep') <> 8 OR l->>'cep' !~ '^[0-9]{8}$' THEN RETURN false; END IF;
  ELSIF ls <> 'failed' THEN RETURN false; END IF;
  IF ls = 'found' THEN
   IF lf IS DISTINCT FROM 'null'::jsonb OR jsonb_typeof(addr) IS DISTINCT FROM 'object' OR NOT (addr ? 'cep')
      OR addr - ARRAY['cep','logradouro','complemento','unidade','bairro','localidade','uf','estado','regiao','ibge','gia','ddd','siafi'] <> '{}'::jsonb THEN RETURN false; END IF;
   FOR item IN SELECT key, value FROM jsonb_each(addr) LOOP
    IF jsonb_typeof(item.value) IS DISTINCT FROM 'string' OR length(item.value #>> '{}') > 1024 THEN RETURN false; END IF;
   END LOOP;
   cep := addr->>'cep';
   IF NOT ((length(cep) = 8 AND cep ~ '^[0-9]{8}$') OR (length(cep) = 9 AND cep ~ '^[0-9]{5}-[0-9]{3}$'))
      OR replace(cep,'-','') IS DISTINCT FROM l->>'cep' THEN RETURN false; END IF;
  ELSE
   IF addr IS DISTINCT FROM 'null'::jsonb OR NOT automation_failure_guard_v3(lf)
      OR lf->>'nodeId' IS DISTINCT FROM l->>'nodeId' THEN RETURN false; END IF;
   IF ls = 'not_found' THEN
    IF lf->>'code' IS DISTINCT FROM 'viacep_not_found' THEN RETURN false; END IF;
   ELSE
    IF lf->>'code' NOT IN ('invalid_cep','viacep_timeout','viacep_transport','viacep_http_transient','viacep_http_permanent','viacep_invalid_response','viacep_security_rejected','viacep_unknown','retry_exhausted') THEN RETURN false; END IF;
    IF (lf->>'code' = 'invalid_cep') IS DISTINCT FROM (l->'cep' = 'null'::jsonb) THEN RETURN false; END IF;
   END IF;
  END IF;
 END IF;
 IF d IS DISTINCT FROM 'null'::jsonb THEN
  IF jsonb_typeof(d) IS DISTINCT FROM 'object' OR NOT (d ?& ARRAY['nodeId','outcome','sourcePort','targetNodeId'])
     OR d - ARRAY['nodeId','outcome','sourcePort','targetNodeId'] <> '{}'::jsonb
     OR jsonb_typeof(d->'nodeId') IS DISTINCT FROM 'string' OR d->>'nodeId' !~ '^[A-Za-z][A-Za-z0-9_-]{0,63}$'
     OR jsonb_typeof(d->'targetNodeId') IS DISTINCT FROM 'string' OR d->>'targetNodeId' !~ '^[A-Za-z][A-Za-z0-9_-]{0,63}$'
     OR jsonb_typeof(d->'outcome') IS DISTINCT FROM 'string' OR d->>'outcome' NOT IN ('TRUE','FALSE')
     OR d->'outcome' IS DISTINCT FROM d->'sourcePort' THEN RETURN false; END IF;
  outcome := d->>'outcome';
  IF ls IS DISTINCT FROM 'found' THEN RETURN false; END IF;
 END IF;
 IF jsonb_typeof(a) IS DISTINCT FROM 'object' OR NOT (a ?& ARRAY['nodeId','status','receipt'])
    OR a - ARRAY['nodeId','status','receipt'] <> '{}'::jsonb
    OR (a->'nodeId' IS DISTINCT FROM 'null'::jsonb AND (jsonb_typeof(a->'nodeId') IS DISTINCT FROM 'string' OR a->>'nodeId' !~ '^[A-Za-z][A-Za-z0-9_-]{0,63}$'))
    OR jsonb_typeof(a->'status') IS DISTINCT FROM 'string' OR a->>'status' NOT IN ('pending','executed','ignored','not_executed') THEN RETURN false; END IF;
 status := a->>'status'; r := a->'receipt';
 IF a->'nodeId' = 'null'::jsonb AND (l <> 'null'::jsonb OR f->>'code' IS DISTINCT FROM 'unsupported_execution_contract') THEN RETURN false; END IF;
 -- Actual executed node identities are distinct; targetNodeId is an edge, not a node role here.
 IF (l <> 'null'::jsonb AND a->'nodeId' <> 'null'::jsonb AND l->>'nodeId' = a->>'nodeId')
    OR (d <> 'null'::jsonb AND (d->>'nodeId' = l->>'nodeId' OR d->>'nodeId' = a->>'nodeId')) THEN RETURN false; END IF;
 IF status = 'executed' THEN
  IF outcome IS DISTINCT FROM 'TRUE' OR f IS DISTINCT FROM 'null'::jsonb OR jsonb_typeof(r) IS DISTINCT FROM 'object'
     OR NOT (r ?& ARRAY['kind','eventId','message']) OR r - ARRAY['kind','eventId','message'] <> '{}'::jsonb
     OR r->'kind' IS DISTINCT FROM '"local-receipt.v1"'::jsonb OR jsonb_typeof(r->'eventId') IS DISTINCT FROM 'string'
     OR r->>'eventId' IS DISTINCT FROM event_id::text OR jsonb_typeof(r->'message') IS DISTINCT FROM 'string' THEN RETURN false; END IF;
 ELSE
  IF r IS DISTINCT FROM 'null'::jsonb THEN RETURN false; END IF;
  IF status = 'ignored' THEN
   IF outcome IS DISTINCT FROM 'FALSE' OR f IS DISTINCT FROM 'null'::jsonb THEN RETURN false; END IF;
  ELSIF status = 'pending' THEN
   IF NOT COALESCE(f->>'classification' = 'transient' AND
      ((ls = 'failed' AND lf->>'classification' = 'transient' AND d = 'null'::jsonb)
       OR (ls = 'found' AND outcome = 'TRUE' AND a->'nodeId' <> 'null'::jsonb)), false) THEN RETURN false; END IF;
  ELSE
   IF f = 'null'::jsonb OR f->>'classification' = 'transient' OR outcome = 'FALSE' THEN RETURN false; END IF;
  END IF;
 END IF;
 -- A non-found lookup mirrors its diagnostic unless a strictly higher-priority
 -- terminal peer blocks it. Found observations remain frozen.
 IF ls IN ('failed','not_found') THEN
  IF f IS DISTINCT FROM lf AND NOT COALESCE((f->>'code' = 'event_peer_failure' AND f->'nodeId' = 'null'::jsonb AND
     ((lf->>'classification' = 'transient' AND f->>'classification' IN ('unknown','permanent','exhausted'))
      OR (lf->>'classification' = 'unknown' AND f->>'classification' = 'permanent'))), false) THEN RETURN false; END IF;
 ELSIF ls = 'found' THEN
  IF status = 'not_executed' AND d = 'null'::jsonb THEN
   IF NOT COALESCE((f->>'code' IN ('invalid_condition_config','invalid_condition_value','condition_type_mismatch')
       AND f->>'nodeId' IS NOT NULL AND f->>'nodeId' <> l->>'nodeId' AND f->>'nodeId' <> a->>'nodeId')
      OR (f->>'code' = 'event_peer_failure' AND f->>'classification' IN ('permanent','unknown','exhausted') AND f->'nodeId' = 'null'::jsonb), false) THEN RETURN false; END IF;
  ELSIF status = 'pending' THEN
   IF NOT COALESCE((f->>'code' = 'action_transient' AND f->>'classification' = 'transient' AND f->>'nodeId' = a->>'nodeId')
      OR (f->>'code' = 'event_peer_failure' AND f->>'classification' = 'transient' AND f->'nodeId' = 'null'::jsonb), false) THEN RETURN false; END IF;
  ELSIF status = 'not_executed' THEN
   IF NOT COALESCE((outcome = 'TRUE' AND f->>'code' IN ('action_permanent','action_unknown','retry_exhausted') AND f->>'nodeId' = a->>'nodeId')
      OR (outcome = 'TRUE' AND f->>'code' = 'event_peer_failure' AND f->>'classification' IN ('permanent','unknown','exhausted') AND f->'nodeId' = 'null'::jsonb), false) THEN RETURN false; END IF;
  END IF;
 END IF;
 RETURN true;
EXCEPTION WHEN others THEN RETURN false;
END $$;

CREATE OR REPLACE FUNCTION automation_target_guard_v3(v integer, result jsonb)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE d jsonb; a jsonb; s text; ls text;
BEGIN
 IF v NOT IN (2,3) OR result IS NULL THEN RETURN true; END IF;
 d := result->'decision'; a := result->'action'; s := a->>'status'; ls := result->'lookup'->>'status';
 IF v = 2 THEN
  RETURN (CASE s
   WHEN 'executed' THEN d->>'targetNodeId' = a->>'nodeId'
   WHEN 'pending' THEN d->>'targetNodeId' = a->>'nodeId'
   WHEN 'ignored' THEN d->>'targetNodeId' <> a->>'nodeId'
   WHEN 'not_executed' THEN d = 'null'::jsonb OR (d->>'outcome' = 'TRUE' AND a->>'nodeId' IS NOT NULL AND d->>'targetNodeId' = a->>'nodeId')
   ELSE false END) IS TRUE;
 END IF;
 RETURN (CASE s
  WHEN 'executed' THEN d->>'outcome' = 'TRUE' AND a->>'nodeId' IS NOT NULL AND d->>'targetNodeId' = a->>'nodeId'
  WHEN 'ignored' THEN d->>'outcome' = 'FALSE' AND a->>'nodeId' IS NOT NULL AND d->>'targetNodeId' <> a->>'nodeId'
  WHEN 'pending' THEN a->>'nodeId' IS NOT NULL AND ((ls = 'failed' AND result->'lookup'->'failure'->>'classification' = 'transient' AND d = 'null'::jsonb) OR (ls = 'found' AND d->>'outcome' = 'TRUE' AND d->>'targetNodeId' = a->>'nodeId'))
  WHEN 'not_executed' THEN d = 'null'::jsonb OR (d->>'outcome' = 'TRUE' AND a->>'nodeId' IS NOT NULL AND d->>'targetNodeId' = a->>'nodeId')
  ELSE false END) IS TRUE;
END $$;

CREATE OR REPLACE FUNCTION automation_execution_types_guard_v3(v integer, trigger_type text, action_type text)
RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
 SELECT v NOT IN (2,3) OR (trigger_type = 'receipt.v1' AND action_type = 'record-receipt.v1')
$$;

-- Install every replacement before removing any v2 check, including on rerun.
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'automation_executions'::regclass AND conname = 'automation_execution_result_valid_v3') THEN
  ALTER TABLE automation_executions ADD CONSTRAINT automation_execution_result_valid_v3 CHECK (automation_result_guard_v3(schema_version,event_id,result) IS TRUE) NOT VALID;
 END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'automation_executions'::regclass AND conname = 'automation_execution_target_valid_v3') THEN
  ALTER TABLE automation_executions ADD CONSTRAINT automation_execution_target_valid_v3 CHECK (automation_target_guard_v3(schema_version,result) IS TRUE) NOT VALID;
 END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'automation_executions'::regclass AND conname = 'automation_execution_types_valid_v3') THEN
  ALTER TABLE automation_executions ADD CONSTRAINT automation_execution_types_valid_v3 CHECK (automation_execution_types_guard_v3(schema_version,trigger_type,action_type) IS TRUE) NOT VALID;
 END IF;
END $$;
ALTER TABLE automation_executions DROP CONSTRAINT IF EXISTS automation_execution_result_valid_v2;
ALTER TABLE automation_executions DROP CONSTRAINT IF EXISTS automation_execution_target_valid_v2;
ALTER TABLE automation_executions DROP CONSTRAINT IF EXISTS automation_execution_types_valid_v2;

-- Separate from migration 013: all committed v3 results, not only found or
-- terminal ones, must survive subsequent updates. DELETE remains unaffected.
CREATE OR REPLACE FUNCTION guard_execution_result_nonnull_v3() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.schema_version = 3 AND OLD.result IS NOT NULL AND NEW.result IS NULL THEN
  RAISE EXCEPTION 'committed v3 execution result cannot be cleared' USING ERRCODE = '23514';
 END IF;
 RETURN NEW;
END $$;
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'automation_executions'::regclass AND tgname = 'execution_result_nonnull_v3' AND NOT tgisinternal) THEN
  CREATE TRIGGER execution_result_nonnull_v3 BEFORE UPDATE ON automation_executions
   FOR EACH ROW EXECUTE FUNCTION guard_execution_result_nonnull_v3();
 END IF;
END $$;
COMMIT;
