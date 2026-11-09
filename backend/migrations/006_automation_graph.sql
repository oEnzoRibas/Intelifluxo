ALTER TABLE automation_definition_revisions ADD COLUMN IF NOT EXISTS graph jsonb;

-- This guard deliberately accepts SQL NULL only for pre-graph revisions and old writers.
CREATE OR REPLACE FUNCTION automation_graph_guard(g jsonb, enabled boolean, trigger_type text, action_type text)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE n jsonb; e jsonb; ids text[] := ARRAY[]::text[]; pairs text[] := ARRAY[]::text[];
  tid text; aid text; cid text; s text; t text; k text; typ text; x numeric; y numeric;
BEGIN
 IF g IS NULL THEN RETURN true; END IF;
 IF jsonb_typeof(g) IS DISTINCT FROM 'object' OR NOT (g ?& ARRAY['version','nodes','edges']) OR (g - ARRAY['version','nodes','edges']) <> '{}'::jsonb OR g->'version' IS DISTINCT FROM '1'::jsonb OR jsonb_typeof(g->'nodes') IS DISTINCT FROM 'array' OR jsonb_typeof(g->'edges') IS DISTINCT FROM 'array' THEN RETURN false; END IF;
 IF jsonb_array_length(g->'nodes') NOT IN (2,3) OR jsonb_array_length(g->'edges') <> jsonb_array_length(g->'nodes') - 1 THEN RETURN false; END IF;
 FOR n IN SELECT value FROM jsonb_array_elements(g->'nodes') LOOP
  IF jsonb_typeof(n) IS DISTINCT FROM 'object' OR NOT (n ?& ARRAY['id','kind','type','position']) OR (n - ARRAY['id','kind','type','position']) <> '{}'::jsonb OR jsonb_typeof(n->'id') IS DISTINCT FROM 'string' OR jsonb_typeof(n->'kind') IS DISTINCT FROM 'string' OR jsonb_typeof(n->'type') IS DISTINCT FROM 'string' OR jsonb_typeof(n->'position') IS DISTINCT FROM 'object' OR NOT ((n->'position') ?& ARRAY['x','y']) OR ((n->'position') - ARRAY['x','y']) <> '{}'::jsonb OR jsonb_typeof(n->'position'->'x') IS DISTINCT FROM 'number' OR jsonb_typeof(n->'position'->'y') IS DISTINCT FROM 'number' THEN RETURN false; END IF;
  s := n->>'id'; k := n->>'kind'; typ := n->>'type';
  IF s !~ '^[A-Za-z][A-Za-z0-9_-]{0,63}$' OR s = ANY(ids) THEN RETURN false; END IF;
  ids := array_append(ids,s); x := (n->'position'->>'x')::numeric; y := (n->'position'->>'y')::numeric;
  IF x NOT BETWEEN -10000 AND 10000 OR y NOT BETWEEN -10000 AND 10000 THEN RETURN false; END IF;
  IF k = 'trigger' AND typ = trigger_type AND tid IS NULL THEN tid := s;
  ELSIF k = 'action' AND typ = action_type AND aid IS NULL THEN aid := s;
  ELSIF k = 'condition' AND typ = 'condition-placeholder.v1' AND cid IS NULL THEN cid := s;
  ELSE RETURN false; END IF;
 END LOOP;
 IF tid IS NULL OR aid IS NULL OR (enabled AND cid IS NOT NULL) THEN RETURN false; END IF;
 FOR e IN SELECT value FROM jsonb_array_elements(g->'edges') LOOP
  IF jsonb_typeof(e) IS DISTINCT FROM 'object' OR NOT (e ?& ARRAY['source','target']) OR (e - ARRAY['source','target']) <> '{}'::jsonb OR jsonb_typeof(e->'source') IS DISTINCT FROM 'string' OR jsonb_typeof(e->'target') IS DISTINCT FROM 'string' THEN RETURN false; END IF;
  s := e->>'source'; t := e->>'target';
  IF NOT (s = ANY(ids)) OR NOT (t = ANY(ids)) OR s = t OR (s || ':' || t) = ANY(pairs) THEN RETURN false; END IF;
  pairs := array_append(pairs,s || ':' || t);
 END LOOP;
 IF cid IS NULL THEN RETURN (tid || ':' || aid) = ANY(pairs); END IF;
 RETURN (tid || ':' || cid) = ANY(pairs) AND (cid || ':' || aid) = ANY(pairs);
EXCEPTION WHEN others THEN RETURN false;
END $$;
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'automation_definition_revisions'::regclass AND conname = 'automation_graph_valid') THEN
  ALTER TABLE automation_definition_revisions ADD CONSTRAINT automation_graph_valid CHECK (automation_graph_guard(graph, active, trigger_type, action_type) IS TRUE) NOT VALID;
 END IF;
END $$;
