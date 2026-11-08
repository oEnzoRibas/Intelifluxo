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
  console.log("migration applied");
} finally {
  await pool.end();
}
