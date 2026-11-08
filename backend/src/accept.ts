import { randomUUID } from "node:crypto";
import type pg from "pg";
import { content, type Input } from "./contract.js";
import { transaction } from "./db.js";

export async function accept(pool: pg.Pool, input: Input) {
  return transaction(pool, async (client) => {
    const id = randomUUID();
    const value = JSON.stringify(content(input));
    const inserted = await client.query(
      `INSERT INTO events(id, scope, idempotency_key, content) VALUES ($1,$2,$3,$4::jsonb)
       ON CONFLICT (scope,idempotency_key) DO NOTHING RETURNING id`,
      [id, input.scope, input.idempotencyKey, value],
    );
    if (!inserted.rowCount) {
      const existing = await client.query(
        "SELECT id, content = $3::jsonb AS same FROM events WHERE scope=$1 AND idempotency_key=$2",
        [input.scope, input.idempotencyKey, value],
      );
      return {
        id: existing.rows[0].id as string,
        replay: true,
        conflict: !existing.rows[0].same,
      };
    }
    await client.query(
      "INSERT INTO target_snapshots VALUES ($1,'local-receipt',1)",
      [id],
    );
    await client.query(
      "INSERT INTO audit(event_id,action) VALUES ($1,'accepted')",
      [id],
    );
    await client.query("INSERT INTO outbox(event_id) VALUES ($1)", [id]);
    return { id, replay: false, conflict: false };
  });
}
