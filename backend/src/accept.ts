import { randomUUID } from "node:crypto";
import type pg from "pg";
import { content, type Input } from "./contract.js";
import { transaction } from "./db.js";

export async function accept(
  pool: pg.Pool,
  input: Input,
  snapshotsEnabled = false,
) {
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
    if (snapshotsEnabled) {
      // One statement observes a consistent snapshot of all current revisions.
      await client.query(
        "INSERT INTO event_automation_context(event_id,trigger_type) VALUES ($1,'receipt.v1')",
        [id],
      );
      await client.query(
        `INSERT INTO automation_executions(id,event_id,automation_id,revision,schema_version,trigger_type,action_type)
       SELECT gen_random_uuid(),$1,d.id,r.revision,r.schema_version,r.trigger_type,r.action_type
       FROM automation_definitions d JOIN automation_definition_revisions r
       ON r.automation_id=d.id AND r.revision=d.current_revision
       WHERE d.scope=$2 AND r.active AND r.trigger_type='receipt.v1'`,
        [id, input.scope],
      );
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
