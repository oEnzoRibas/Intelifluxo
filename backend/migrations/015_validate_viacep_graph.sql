-- Separate transaction: validation takes a weaker lock than installation.
ALTER TABLE automation_definition_revisions VALIDATE CONSTRAINT automation_graph_valid_v3;
