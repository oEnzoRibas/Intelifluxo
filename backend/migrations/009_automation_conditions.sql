-- Replace the old checks atomically. Existing revisions are never rewritten.
ALTER TABLE automation_definition_revisions DROP CONSTRAINT IF EXISTS automation_definition_revisions_schema_version_check;
ALTER TABLE automation_definition_revisions DROP CONSTRAINT IF EXISTS automation_graph_valid;

CREATE OR REPLACE FUNCTION automation_graph_guard_v2(g jsonb, enabled boolean, schema_version integer, trigger_type text, action_type text)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE n jsonb; e jsonb; c jsonb; p text; part text; op text; et text;
 ids text[] := ARRAY[]::text[]; edges text[] := ARRAY[]::text[];
 tid text; cid text; aid text; eid text; s text; k text; typ text; t text; port text;
BEGIN
 IF schema_version = 1 THEN RETURN automation_graph_guard(g, enabled, trigger_type, action_type); END IF;
 IF schema_version <> 2 OR g IS NULL OR jsonb_typeof(g) IS DISTINCT FROM 'object'
  OR NOT (g ?& ARRAY['version','nodes','edges']) OR g - ARRAY['version','nodes','edges'] <> '{}'::jsonb
  OR g->'version' IS DISTINCT FROM '2'::jsonb OR jsonb_typeof(g->'nodes') IS DISTINCT FROM 'array'
  OR jsonb_typeof(g->'edges') IS DISTINCT FROM 'array' THEN RETURN false; END IF;
 IF jsonb_array_length(g->'nodes') <> 4 OR jsonb_array_length(g->'edges') <> 4 THEN RETURN false; END IF;
 FOR n IN SELECT value FROM jsonb_array_elements(g->'nodes') LOOP
  IF jsonb_typeof(n) IS DISTINCT FROM 'object' OR NOT (n ?& ARRAY['id','kind','type','position'])
   OR jsonb_typeof(n->'id') IS DISTINCT FROM 'string' OR jsonb_typeof(n->'kind') IS DISTINCT FROM 'string'
   OR jsonb_typeof(n->'type') IS DISTINCT FROM 'string' OR jsonb_typeof(n->'position') IS DISTINCT FROM 'object'
   OR NOT (n->'position' ?& ARRAY['x','y']) OR (n->'position') - ARRAY['x','y'] <> '{}'::jsonb
   OR jsonb_typeof(n->'position'->'x') IS DISTINCT FROM 'number' OR jsonb_typeof(n->'position'->'y') IS DISTINCT FROM 'number'
   OR (n->'position'->>'x')::numeric NOT BETWEEN -10000 AND 10000 OR (n->'position'->>'y')::numeric NOT BETWEEN -10000 AND 10000 THEN RETURN false; END IF;
  s := n->>'id'; k := n->>'kind'; typ := n->>'type';
  IF s !~ '^[A-Za-z][A-Za-z0-9_-]{0,63}$' OR s = ANY(ids) THEN RETURN false; END IF;
  ids := array_append(ids, s);
  IF k = 'condition' THEN
   IF NOT (n ? 'config') OR n - ARRAY['id','kind','type','position','config'] <> '{}'::jsonb OR typ <> 'condition.v1' OR cid IS NOT NULL THEN RETURN false; END IF;
   cid := s; c := n->'config';
   IF jsonb_typeof(c) IS DISTINCT FROM 'object' OR NOT (c ?& ARRAY['fieldPath','operator']) OR jsonb_typeof(c->'fieldPath') IS DISTINCT FROM 'string' OR jsonb_typeof(c->'operator') IS DISTINCT FROM 'string' THEN RETURN false; END IF;
   p := c->>'fieldPath'; op := c->>'operator';
   IF length(p) > 256 OR cardinality(string_to_array(p,'.')) NOT BETWEEN 1 AND 8 THEN RETURN false; END IF;
   FOREACH part IN ARRAY string_to_array(p,'.') LOOP
    IF part !~ '^[A-Za-z_][A-Za-z0-9_]{0,63}$' OR part IN ('__proto__','prototype','constructor') THEN RETURN false; END IF;
   END LOOP;
   IF op = 'exists' THEN
    IF c - ARRAY['fieldPath','operator'] <> '{}'::jsonb THEN RETURN false; END IF;
   ELSE
    IF op NOT IN ('equals','not_equals','greater_than','less_than','contains') OR NOT (c ?& ARRAY['expectedType','expectedValue']) OR c - ARRAY['fieldPath','operator','expectedType','expectedValue'] <> '{}'::jsonb OR jsonb_typeof(c->'expectedType') IS DISTINCT FROM 'string' THEN RETURN false; END IF;
    et := c->>'expectedType';
    IF et NOT IN ('string','number','boolean','null') OR jsonb_typeof(c->'expectedValue') IS DISTINCT FROM et OR (op IN ('greater_than','less_than') AND et <> 'number') OR (op = 'contains' AND et <> 'string') THEN RETURN false; END IF;
    IF et = 'string' AND length(c->>'expectedValue') > 1024 THEN RETURN false; END IF;
    IF et = 'number' AND abs((c->>'expectedValue')::numeric) > 1.7976931348623157e308::numeric THEN RETURN false; END IF;
   END IF;
  ELSE
   IF n - ARRAY['id','kind','type','position'] <> '{}'::jsonb THEN RETURN false; END IF;
   IF k = 'trigger' AND typ = 'receipt.v1' AND typ = trigger_type AND tid IS NULL THEN tid := s;
   ELSIF k = 'action' AND typ = 'record-receipt.v1' AND typ = action_type AND aid IS NULL THEN aid := s;
   ELSIF k = 'end' AND typ = 'end.v1' AND eid IS NULL THEN eid := s;
   ELSE RETURN false; END IF;
  END IF;
 END LOOP;
 IF tid IS NULL OR cid IS NULL OR aid IS NULL OR eid IS NULL THEN RETURN false; END IF;
 FOR e IN SELECT value FROM jsonb_array_elements(g->'edges') LOOP
  IF jsonb_typeof(e) IS DISTINCT FROM 'object' OR NOT (e ?& ARRAY['source','target']) OR jsonb_typeof(e->'source') IS DISTINCT FROM 'string' OR jsonb_typeof(e->'target') IS DISTINCT FROM 'string' THEN RETURN false; END IF;
  s := e->>'source'; t := e->>'target';
  IF s = cid THEN
   IF NOT (e ? 'sourcePort') OR e - ARRAY['source','target','sourcePort'] <> '{}'::jsonb OR jsonb_typeof(e->'sourcePort') IS DISTINCT FROM 'string' OR e->>'sourcePort' NOT IN ('TRUE','FALSE') THEN RETURN false; END IF;
   port := e->>'sourcePort';
  ELSE
   IF e - ARRAY['source','target'] <> '{}'::jsonb THEN RETURN false; END IF;
   port := '';
  END IF;
  p := s || ':' || port || ':' || t;
  IF p = ANY(edges) THEN RETURN false; END IF;
  edges := array_append(edges,p);
 END LOOP;
 RETURN (tid || '::' || cid) = ANY(edges) AND (cid || ':TRUE:' || aid) = ANY(edges)
    AND (cid || ':FALSE:' || eid) = ANY(edges) AND (aid || '::' || eid) = ANY(edges);
EXCEPTION WHEN others THEN RETURN false;
END $$;

CREATE OR REPLACE FUNCTION automation_result_guard_v2(v integer, event_id uuid, result jsonb)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE d jsonb; a jsonb; f jsonb; r jsonb; status text; outcome text;
BEGIN
 IF v = 1 THEN RETURN true; END IF;
 IF v <> 2 THEN RETURN false; END IF;
 IF result IS NULL THEN RETURN true; END IF;
 IF jsonb_typeof(result) IS DISTINCT FROM 'object' OR NOT (result ?& ARRAY['kind','eventId','decision','action','failure']) OR result - ARRAY['kind','eventId','decision','action','failure'] <> '{}'::jsonb OR result->'kind' IS DISTINCT FROM '"condition-execution.v1"'::jsonb OR jsonb_typeof(result->'eventId') IS DISTINCT FROM 'string' OR result->>'eventId' IS DISTINCT FROM event_id::text THEN RETURN false; END IF;
 d := result->'decision'; a := result->'action'; f := result->'failure';
 IF d <> 'null'::jsonb THEN
  IF jsonb_typeof(d) IS DISTINCT FROM 'object' OR NOT (d ?& ARRAY['nodeId','outcome','sourcePort','targetNodeId']) OR d - ARRAY['nodeId','outcome','sourcePort','targetNodeId'] <> '{}'::jsonb OR jsonb_typeof(d->'nodeId') IS DISTINCT FROM 'string' OR jsonb_typeof(d->'targetNodeId') IS DISTINCT FROM 'string' OR (d->>'nodeId') !~ '^[A-Za-z][A-Za-z0-9_-]{0,63}$' OR (d->>'targetNodeId') !~ '^[A-Za-z][A-Za-z0-9_-]{0,63}$' OR jsonb_typeof(d->'outcome') IS DISTINCT FROM 'string' OR d->>'outcome' NOT IN ('TRUE','FALSE') OR d->'outcome' IS DISTINCT FROM d->'sourcePort' THEN RETURN false; END IF;
  outcome := d->>'outcome';
 END IF;
 IF jsonb_typeof(a) IS DISTINCT FROM 'object' OR NOT (a ?& ARRAY['nodeId','status','receipt']) OR a - ARRAY['nodeId','status','receipt'] <> '{}'::jsonb OR (a->'nodeId' <> 'null'::jsonb AND (jsonb_typeof(a->'nodeId') IS DISTINCT FROM 'string' OR (a->>'nodeId') !~ '^[A-Za-z][A-Za-z0-9_-]{0,63}$')) OR jsonb_typeof(a->'status') IS DISTINCT FROM 'string' OR a->>'status' NOT IN ('pending','executed','ignored','not_executed') THEN RETURN false; END IF;
 status := a->>'status'; r := a->'receipt';
 IF f <> 'null'::jsonb THEN
  IF jsonb_typeof(f) IS DISTINCT FROM 'object' OR NOT (f ?& ARRAY['classification','code','nodeId']) OR f - ARRAY['classification','code','nodeId'] <> '{}'::jsonb OR jsonb_typeof(f->'classification') IS DISTINCT FROM 'string' OR f->>'classification' NOT IN ('transient','permanent','unknown','exhausted') OR jsonb_typeof(f->'code') IS DISTINCT FROM 'string' OR f->>'code' NOT IN ('invalid_condition_config','invalid_condition_value','condition_type_mismatch','unsupported_execution_contract','action_transient','action_permanent','action_unknown','event_peer_failure','retry_exhausted') OR (f->'nodeId' <> 'null'::jsonb AND (jsonb_typeof(f->'nodeId') IS DISTINCT FROM 'string' OR (f->>'nodeId') !~ '^[A-Za-z][A-Za-z0-9_-]{0,63}$')) THEN RETURN false; END IF;
 END IF;
 IF status = 'executed' THEN
  IF outcome IS DISTINCT FROM 'TRUE' OR f <> 'null'::jsonb OR a->'nodeId' = 'null'::jsonb OR jsonb_typeof(r) IS DISTINCT FROM 'object' OR NOT (r ?& ARRAY['kind','eventId','message']) OR r - ARRAY['kind','eventId','message'] <> '{}'::jsonb OR r->'kind' IS DISTINCT FROM '"local-receipt.v1"'::jsonb OR r->>'eventId' IS DISTINCT FROM event_id::text OR jsonb_typeof(r->'message') IS DISTINCT FROM 'string' THEN RETURN false; END IF;
 ELSE
  IF r IS DISTINCT FROM 'null'::jsonb THEN RETURN false; END IF;
  IF status = 'ignored' THEN RETURN outcome = 'FALSE' AND f = 'null'::jsonb AND a->'nodeId' <> 'null'::jsonb; END IF;
  IF status = 'pending' THEN RETURN outcome = 'TRUE' AND f <> 'null'::jsonb AND f->>'classification' = 'transient' AND a->'nodeId' <> 'null'::jsonb; END IF;
  IF outcome = 'FALSE' OR f = 'null'::jsonb THEN RETURN false; END IF;
 END IF;
 RETURN true;
EXCEPTION WHEN others THEN RETURN false;
END $$;

ALTER TABLE automation_definition_revisions ADD CONSTRAINT automation_graph_valid_v2 CHECK (automation_graph_guard_v2(graph, active, schema_version, trigger_type, action_type) IS TRUE) NOT VALID;
ALTER TABLE automation_executions ADD CONSTRAINT automation_execution_result_valid_v2 CHECK (automation_result_guard_v2(schema_version, event_id, result) IS TRUE) NOT VALID;
ALTER TABLE automation_executions ADD CONSTRAINT automation_execution_types_valid_v2 CHECK (schema_version <> 2 OR (trigger_type = 'receipt.v1' AND action_type = 'record-receipt.v1')) NOT VALID;
