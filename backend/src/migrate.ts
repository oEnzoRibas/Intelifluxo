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
  const upgraded = await pool.query<{ present: boolean }>(
    "SELECT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'automation_definition_revisions'::regclass AND conname = 'automation_graph_valid_v2') AS present",
  );
  if (!upgraded.rows[0].present) {
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
  if (!upgraded.rows[0].present) {
    await pool.query(
      await readFile(
        new URL("../migrations/009_automation_conditions.sql", import.meta.url),
        "utf8",
      ),
    );
  }
  await pool.query(
    await readFile(
      new URL(
        "../migrations/010_validate_automation_conditions.sql",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  console.log("migration applied");
} finally {
  await pool.end();
}
