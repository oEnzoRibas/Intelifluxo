-- V1 and V2 remain governed by the existing function, unchanged. For V3,
-- reduce the condition and topology to V2 only after checking the lookup and
-- five-edge topology; this keeps scalar operator rules in one authority.
CREATE OR REPLACE FUNCTION automation_graph_guard_v3(g jsonb, enabled boolean, schema_version integer, trigger_type text, action_type text)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE n jsonb; e jsonb; lookup_node jsonb; condition_node jsonb; cep jsonb; input jsonb;
 nodes jsonb := '[]'::jsonb; edges text[] := ARRAY[]::text[]; ids text[] := ARRAY[]::text[];
 tid text; lid text; cid text; aid text; eid text; s text; t text; port text; p text; part text;
BEGIN
 IF schema_version IN (1, 2) THEN RETURN automation_graph_guard_v2(g, enabled, schema_version, trigger_type, action_type); END IF;
 IF schema_version IS DISTINCT FROM 3 OR jsonb_typeof(g) IS DISTINCT FROM 'object'
  OR NOT (g ?& ARRAY['version','nodes','edges']) OR g - ARRAY['version','nodes','edges'] <> '{}'::jsonb
  OR g->'version' IS DISTINCT FROM '3'::jsonb OR jsonb_typeof(g->'nodes') IS DISTINCT FROM 'array'
  OR jsonb_typeof(g->'edges') IS DISTINCT FROM 'array' THEN RETURN false; END IF;
 IF jsonb_array_length(g->'nodes') <> 5 OR jsonb_array_length(g->'edges') <> 5 THEN RETURN false; END IF;
 FOR n IN SELECT value FROM jsonb_array_elements(g->'nodes') LOOP
  IF jsonb_typeof(n) IS DISTINCT FROM 'object' OR jsonb_typeof(n->'id') IS DISTINCT FROM 'string'
   OR (n->>'id') !~ '^[A-Za-z][A-Za-z0-9_-]{0,63}$' OR (n->>'id') = ANY(ids) THEN RETURN false; END IF;
  s := n->>'id'; ids := array_append(ids,s);
  IF n->>'kind' = 'lookup' THEN
   IF lid IS NOT NULL OR n->'type' IS DISTINCT FROM '"viacep-address.v1"'::jsonb
    OR NOT (n ?& ARRAY['id','kind','type','position','config']) OR n - ARRAY['id','kind','type','position','config'] <> '{}'::jsonb
    OR jsonb_typeof(n->'position') IS DISTINCT FROM 'object' OR NOT (n->'position' ?& ARRAY['x','y'])
    OR (n->'position') - ARRAY['x','y'] <> '{}'::jsonb OR jsonb_typeof(n->'position'->'x') IS DISTINCT FROM 'number'
    OR jsonb_typeof(n->'position'->'y') IS DISTINCT FROM 'number'
    OR (n->'position'->>'x')::numeric NOT BETWEEN -10000 AND 10000 OR (n->'position'->>'y')::numeric NOT BETWEEN -10000 AND 10000 THEN RETURN false; END IF;
   lid := s; lookup_node := n;
  ELSIF n->>'kind' = 'condition' THEN
   IF cid IS NOT NULL OR n->'type' IS DISTINCT FROM '"condition.v2"'::jsonb OR NOT (n ? 'config') THEN RETURN false; END IF;
   cid := s; condition_node := n;
  ELSE
   IF n->>'kind' = 'trigger' AND tid IS NULL THEN tid := s;
   ELSIF n->>'kind' = 'action' AND aid IS NULL THEN aid := s;
   ELSIF n->>'kind' = 'end' AND eid IS NULL THEN eid := s;
   ELSE RETURN false; END IF;
   nodes := nodes || jsonb_build_array(n);
  END IF;
 END LOOP;
 IF tid IS NULL OR lid IS NULL OR cid IS NULL OR aid IS NULL OR eid IS NULL THEN RETURN false; END IF;
 IF jsonb_typeof(lookup_node->'config') IS DISTINCT FROM 'object' OR NOT (lookup_node->'config' ? 'cep') OR (lookup_node->'config') - 'cep' <> '{}'::jsonb THEN RETURN false; END IF;
 cep := lookup_node->'config'->'cep';
 IF jsonb_typeof(cep) IS DISTINCT FROM 'object' THEN RETURN false; END IF;
 IF cep->'source' = '"fixed"'::jsonb THEN
  IF NOT (cep ?& ARRAY['source','value']) OR cep - ARRAY['source','value'] <> '{}'::jsonb OR jsonb_typeof(cep->'value') IS DISTINCT FROM 'string'
   OR (cep->>'value') !~ '^([0-9]{8}|[0-9]{5}-[0-9]{3})$' OR length(cep->>'value') NOT IN (8,9) THEN RETURN false; END IF;
 ELSIF cep->'source' = '"event"'::jsonb THEN
  IF NOT (cep ?& ARRAY['source','fieldPath']) OR cep - ARRAY['source','fieldPath'] <> '{}'::jsonb OR jsonb_typeof(cep->'fieldPath') IS DISTINCT FROM 'string' THEN RETURN false; END IF;
  p := cep->>'fieldPath';
  IF length(p) > 256 OR cardinality(string_to_array(p,'.')) NOT BETWEEN 1 AND 8 THEN RETURN false; END IF;
  FOREACH part IN ARRAY string_to_array(p,'.') LOOP
   IF part !~ '^[A-Za-z_][A-Za-z0-9_]{0,63}$' OR part IN ('__proto__','prototype','constructor') THEN RETURN false; END IF;
  END LOOP;
 ELSE RETURN false; END IF;
 IF jsonb_typeof(condition_node->'config') IS DISTINCT FROM 'object' THEN RETURN false; END IF;
 input := condition_node->'config'->'input';
 IF jsonb_typeof(input) IS DISTINCT FROM 'object' OR jsonb_typeof(input->'fieldPath') IS DISTINCT FROM 'string' THEN RETURN false; END IF;
 IF input->'source' = '"event"'::jsonb THEN
  IF NOT (input ?& ARRAY['source','fieldPath']) OR input - ARRAY['source','fieldPath'] <> '{}'::jsonb THEN RETURN false; END IF;
 ELSIF input->'source' = '"step"'::jsonb THEN
  IF NOT (input ?& ARRAY['source','nodeId','fieldPath']) OR input - ARRAY['source','nodeId','fieldPath'] <> '{}'::jsonb OR input->'nodeId' IS DISTINCT FROM to_jsonb(lid) THEN RETURN false; END IF;
 ELSE RETURN false; END IF;
 IF condition_node->'config' ? 'fieldPath' THEN RETURN false; END IF;
 nodes := nodes || jsonb_build_array(jsonb_set(jsonb_set(condition_node, '{type}', '"condition.v1"'::jsonb), '{config}', ((condition_node->'config') - 'input') || jsonb_build_object('fieldPath', input->'fieldPath')));
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
 IF NOT ((tid || '::' || lid) = ANY(edges) AND (lid || '::' || cid) = ANY(edges)
  AND (cid || ':TRUE:' || aid) = ANY(edges) AND (cid || ':FALSE:' || eid) = ANY(edges) AND (aid || '::' || eid) = ANY(edges)) THEN RETURN false; END IF;
 RETURN automation_graph_guard_v2(jsonb_build_object('version',2,'nodes',nodes,'edges',jsonb_build_array(
  jsonb_build_object('source',tid,'target',cid), jsonb_build_object('source',cid,'target',aid,'sourcePort','TRUE'),
  jsonb_build_object('source',cid,'target',eid,'sourcePort','FALSE'), jsonb_build_object('source',aid,'target',eid))), enabled, 2, trigger_type, action_type);
EXCEPTION WHEN others THEN RETURN false;
END $$;

-- Atomic replacement: no interval exists without a write-time guard.
ALTER TABLE automation_definition_revisions DROP CONSTRAINT IF EXISTS automation_graph_valid_v2;
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'automation_definition_revisions'::regclass AND conname = 'automation_graph_valid_v3') THEN
  ALTER TABLE automation_definition_revisions ADD CONSTRAINT automation_graph_valid_v3 CHECK (automation_graph_guard_v3(graph, active, schema_version, trigger_type, action_type) IS TRUE) NOT VALID;
 END IF;
END $$;
