import type pg from "pg";
import { transaction } from "./db.js";

// Lock events in the same order as the worker, then recheck eligibility against
// the database wall clock. Each committed generation has exactly one outbox row.
export async function scheduleOnce(
  pool: pg.Pool,
  limit = 100,
  eventId?: string,
): Promise<number> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
    throw new Error("invalid scheduler limit");
  return transaction(pool, async (client) => {
    const candidates = await client.query(
      `SELECT e.id FROM events e JOIN retry_dispositions d ON d.event_id=e.id
       WHERE d.state='retry_scheduled' AND d.next_eligible_at <= clock_timestamp() AND ($2::uuid IS NULL OR e.id=$2)
       AND (d.generation=0 OR EXISTS (SELECT 1 FROM retry_publications p WHERE p.event_id=e.id AND p.generation=d.generation AND p.processed_at IS NOT NULL))
       ORDER BY d.next_eligible_at,e.id FOR UPDATE OF e SKIP LOCKED LIMIT $1`,
      [limit, eventId ?? null],
    );
    let released = 0;
    for (const row of candidates.rows) {
      const updated = await client.query(
        `UPDATE retry_dispositions d SET generation=generation+1
         WHERE event_id=$1 AND state='retry_scheduled' AND next_eligible_at <= clock_timestamp()
         AND generation < 2147483647 AND attempt < 2147483647
         AND (generation=0 OR EXISTS (SELECT 1 FROM retry_publications p WHERE p.event_id=d.event_id AND p.generation=d.generation AND p.processed_at IS NOT NULL))
         RETURNING generation`,
        [row.id],
      );
      if (!updated.rowCount) continue;
      await client.query(
        "INSERT INTO retry_publications(event_id,generation) VALUES ($1,$2)",
        [row.id, updated.rows[0].generation],
      );
      released++;
    }
    return released;
  });
}
