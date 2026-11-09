-- Run in a separate transaction from 006: VALIDATE uses a weaker lock than ADD.
ALTER TABLE automation_definition_revisions VALIDATE CONSTRAINT automation_graph_valid;
