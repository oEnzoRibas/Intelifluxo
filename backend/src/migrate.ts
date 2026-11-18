import { readFile } from "node:fs/promises";
import { database } from "./db.js";

const pool = database();
try {
  await pool.query(
    await readFile(
      new URL("../migrations/001_init.sql", import.meta.url),
      "utf8",
    ),
  );
  await pool.query(
    await readFile(
      new URL("../migrations/002_retry_dispositions.sql", import.meta.url),
      "utf8",
    ),
  );
  await pool.query(
    await readFile(
      new URL("../migrations/003_retry_publications.sql", import.meta.url),
      "utf8",
    ),
  );
  await pool.query(
    await readFile(
      new URL("../migrations/004_automation_definitions.sql", import.meta.url),
      "utf8",
    ),
  );
  await pool.query(
    await readFile(
      new URL("../migrations/005_automation_executions.sql", import.meta.url),
      "utf8",
    ),
  );
  // Constraint generations are detected independently of graph function definitions.
  // Execution constraints also identify a completed 009 when the graph constraint
  // was lost and must be recovered by 014.
  const generations = await pool.query<{
    graph_upgraded: boolean;
    execution_v2: boolean;
    execution_v3: boolean;
  }>(`SELECT
    EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'automation_definition_revisions'::regclass AND conname IN ('automation_graph_valid_v2', 'automation_graph_valid_v3')) AS graph_upgraded,
    EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'automation_executions'::regclass AND conname IN ('automation_execution_result_valid_v2', 'automation_execution_types_valid_v2', 'automation_execution_target_valid_v2')) AS execution_v2,
    EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'automation_executions'::regclass AND conname IN ('automation_execution_result_valid_v3', 'automation_execution_types_valid_v3', 'automation_execution_target_valid_v3')) AS execution_v3`);
  const state = generations.rows[0];
  const conditionsInstalled =
    state.graph_upgraded || state.execution_v2 || state.execution_v3;
  if (!conditionsInstalled) {
    await pool.query(
      await readFile(
        new URL("../migrations/006_automation_graph.sql", import.meta.url),
        "utf8",
      ),
    );
    await pool.query(
      await readFile(
        new URL(
          "../migrations/007_validate_automation_graph.sql",
          import.meta.url,
        ),
        "utf8",
      ),
    );
  }
  await pool.query(
    await readFile(
      new URL(
        "../migrations/008_immutable_event_and_execution.sql",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  if (!conditionsInstalled) {
    await pool.query(
      await readFile(
        new URL("../migrations/009_automation_conditions.sql", import.meta.url),
        "utf8",
      ),
    );
  }
  // Only validate surviving v2 checks; v3 supersedes the execution set.
  await pool.query(`DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'automation_definition_revisions'::regclass AND conname = 'automation_graph_valid_v2') THEN
      ALTER TABLE automation_definition_revisions VALIDATE CONSTRAINT automation_graph_valid_v2;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'automation_executions'::regclass AND conname IN ('automation_execution_result_valid_v3', 'automation_execution_types_valid_v3', 'automation_execution_target_valid_v3')) THEN
      IF EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'automation_executions'::regclass AND conname = 'automation_execution_result_valid_v2') THEN
        ALTER TABLE automation_executions VALIDATE CONSTRAINT automation_execution_result_valid_v2;
      END IF;
      IF EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'automation_executions'::regclass AND conname = 'automation_execution_types_valid_v2') THEN
        ALTER TABLE automation_executions VALIDATE CONSTRAINT automation_execution_types_valid_v2;
      END IF;
    END IF;
  END $$`);
  const targets = await pool.query<{ v2: boolean; v3: boolean }>(`SELECT
    EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'automation_executions'::regclass AND conname = 'automation_execution_target_valid_v2') AS v2,
    EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'automation_executions'::regclass AND conname IN ('automation_execution_result_valid_v3', 'automation_execution_types_valid_v3', 'automation_execution_target_valid_v3')) AS v3`);
  if (!targets.rows[0].v3) {
    if (!targets.rows[0].v2) {
      await pool.query(
        await readFile(
          new URL(
            "../migrations/011_execution_result_targets.sql",
            import.meta.url,
          ),
          "utf8",
        ),
      );
    }
    await pool.query(
      await readFile(
        new URL(
          "../migrations/012_validate_execution_result_targets.sql",
          import.meta.url,
        ),
        "utf8",
      ),
    );
  }
  await pool.query(
    await readFile(
      new URL(
        "../migrations/013_viacep_result_immutability.sql",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  await pool.query(
    await readFile(
      new URL("../migrations/014_viacep_graph.sql", import.meta.url),
      "utf8",
    ),
  );
  await pool.query(
    await readFile(
      new URL("../migrations/015_validate_viacep_graph.sql", import.meta.url),
      "utf8",
    ),
  );
  // 016 repairs a partial v3 set and drops remaining v2 checks atomically;
  // 017 validates the complete set, including after an interrupted validation.
  await pool.query(
    await readFile(
      new URL("../migrations/016_viacep_execution.sql", import.meta.url),
      "utf8",
    ),
  );
  await pool.query(
    await readFile(
      new URL(
        "../migrations/017_validate_viacep_execution.sql",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  await pool.query(
    await readFile(
      new URL(
        "../migrations/018_overview_execution_indexes.sql",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  await pool.query(
    await readFile(
      new URL("../migrations/019_forms.sql", import.meta.url),
      "utf8",
    ),
  );
  await pool.query(
    await readFile(
      new URL("../migrations/020_google_forms.sql", import.meta.url),
      "utf8",
    ),
  );
  console.log("migration applied");
} finally {
  await pool.end();
}
