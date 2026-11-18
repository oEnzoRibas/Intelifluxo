import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { api } from "../src/api.js";
import { connectBroker } from "../src/broker.js";
import { relayOnce } from "../src/relay.js";
import { scheduleOnce } from "../src/scheduler.js";
import { assertDemoSafety } from "../scripts/demo-safety.js";

const graph = {
  version: 3,
  nodes: [
    {
      id: "trigger",
      kind: "trigger",
      type: "receipt.v1",
      position: { x: 0, y: 0 },
    },
    {
      id: "lookup",
      kind: "lookup",
      type: "viacep-address.v1",
      position: { x: 0, y: 0 },
      config: { cep: { source: "fixed", value: "01001-000" } },
    },
    {
      id: "condition",
      kind: "condition",
      type: "condition.v2",
      position: { x: 0, y: 0 },
      config: {
        input: { source: "step", nodeId: "lookup", fieldPath: "address.uf" },
        operator: "equals",
        expectedType: "string",
        expectedValue: "SP",
      },
    },
    {
      id: "action",
      kind: "action",
      type: "record-receipt.v1",
      position: { x: 0, y: 0 },
    },
    { id: "end", kind: "end", type: "end.v1", position: { x: 0, y: 0 } },
  ],
  edges: [
    { source: "trigger", target: "lookup" },
    { source: "lookup", target: "condition" },
    { source: "condition", sourcePort: "TRUE", target: "action" },
    { source: "condition", sourcePort: "FALSE", target: "end" },
    { source: "action", target: "end" },
  ],
};
type Signal = { type: string; redelivered?: boolean };
describe.skipIf(
  process.env.INTEGRATION !== "1" ||
    process.env.VIACEP_RECOVERY_INTEGRATION !== "true",
)("ViaCEP process recovery", () => {
  const schema = `viacep_recovery_${randomUUID().replaceAll("-", "")}`;
  const queue = `viacep-recovery.${randomUUID()}`;
  let admin: pg.Pool,
    pool: pg.Pool,
    broker: Awaited<ReturnType<typeof connectBroker>>,
    channel: Awaited<ReturnType<typeof broker.createConfirmChannel>>,
    app: ReturnType<typeof api>;
  let schemaOwned = false,
    queueOwned = false;
  const children = new Set<ChildProcess>();
  const wait = async (fn: () => boolean | Promise<boolean>, label: string) => {
    const until = Date.now() + 15000;
    while (Date.now() < until) {
      if (await fn()) return;
      await new Promise((r) => setTimeout(r, 40));
    }
    throw new Error(`timeout: ${label}`);
  };
  const run = (mode: string) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "test/fixtures/viacep-recovery-worker-child.ts"],
      {
        env: {
          ...process.env,
          PGOPTIONS: `-c search_path=${schema} -c statement_timeout=10000`,
          RECOVERY_QUEUE: queue,
          RECOVERY_MODE: mode,
        },
        stdio: ["ignore", "ignore", "ignore", "ipc"],
      },
    );
    children.add(child);
    const signals: Signal[] = [];
    let failed = false;
    child.on("message", (message: Signal) => signals.push(message));
    child.on("error", () => {
      failed = true;
    });
    child.on("exit", () => children.delete(child));
    return { child, signals, failed: () => failed };
  };
  const until = async (p: ReturnType<typeof run>, type: string) =>
    wait(() => {
      if (p.signals.some((s) => s.type === type)) return true;
      if (
        p.failed() ||
        p.child.exitCode !== null ||
        p.child.signalCode !== null
      )
        throw new Error(`child exited before ${type}`);
      return false;
    }, type);
  const stop = async (child: ChildProcess) => {
    if (child.exitCode === null && child.signalCode === null) {
      if (!child.kill("SIGKILL")) throw new Error("kill failed");
      await wait(
        () => child.exitCode !== null || child.signalCode !== null,
        "child exit",
      );
    }
  };
  const finish = async (p: ReturnType<typeof run>) => {
    await until(p, "acked");
    await wait(
      () => p.child.exitCode !== null || p.child.signalCode !== null,
      "clean exit",
    );
    expect(p.child.exitCode).toBe(0);
  };
  beforeAll(async () => {
    assertDemoSafety(process.env);
    for (const gate of ["VIACEP_WRITES_ENABLED", "CONDITIONS_WRITES_ENABLED"])
      if (process.env[gate] !== "false")
        throw new Error(`${gate} must be false`);
    if (process.env.AUTOMATION_SNAPSHOTS_ENABLED !== "true")
      throw new Error("snapshots required");
    admin = new pg.Pool({
      connectionString: process.env.DATABASE_URL,
      connectionTimeoutMillis: 5000,
      statement_timeout: 10000,
    });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    schemaOwned = true;
    pool = new pg.Pool({
      connectionString: process.env.DATABASE_URL,
      options: `-c search_path=${schema}`,
      connectionTimeoutMillis: 5000,
      statement_timeout: 10000,
    });
    const dir = new URL("../migrations/", import.meta.url);
    for (const name of (await readdir(dir))
      .filter((n) => n.endsWith(".sql"))
      .sort())
      await pool.query(await readFile(new URL(name, dir), "utf8"));
    app = api(pool, true);
    broker = await connectBroker();
    channel = await broker.createConfirmChannel();
    await channel.assertQueue(queue, { durable: true });
    queueOwned = true;
  }, 30000);
  afterAll(async () => {
    const errors: unknown[] = [];
    const attempt = async (f: () => Promise<unknown>) => {
      try {
        await f();
      } catch (e) {
        errors.push(e);
      }
    };
    for (const child of children) await attempt(() => stop(child));
    if (channel && queueOwned) await attempt(() => channel.deleteQueue(queue));
    if (channel) await attempt(() => channel.close());
    if (broker) await attempt(() => broker.close());
    if (app) await attempt(() => app.close());
    if (pool) await attempt(() => pool.end());
    if (admin && schemaOwned)
      await attempt(() =>
        admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`),
      );
    if (admin) await attempt(() => admin.end());
    if (errors.length) throw new Error("recovery cleanup failed");
  }, 60000);
  const setup = async () => {
    const automation = randomUUID(),
      scope = randomUUID();
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      await c.query(
        "INSERT INTO automation_definitions(id,scope,current_revision) VALUES ($1,$2,1)",
        [automation, scope],
      );
      await c.query(
        "INSERT INTO automation_definition_revisions (automation_id,revision,name,active,schema_version,trigger_type,action_type,graph) VALUES ($1,1,'pinned',true,3,'receipt.v1','record-receipt.v1',$2)",
        [automation, JSON.stringify(graph)],
      );
      await c.query("COMMIT");
    } finally {
      c.release();
    }
    const response = await app.inject({
      method: "POST",
      url: "/events",
      payload: {
        scope,
        idempotencyKey: randomUUID(),
        type: "receipt.v1",
        target: "local-receipt",
        message: "recovery",
      },
    });
    expect(response.statusCode).toBe(202);
    const id: string = response.json().id;
    expect(await relayOnce(pool, channel, queue, [], id)).toBe(1);
    return id;
  };
  const state = async (id: string) => ({
    result: (
      await pool.query(
        "SELECT result FROM automation_executions WHERE event_id=$1",
        [id],
      )
    ).rows[0].result,
    dispositions: (
      await pool.query(
        "SELECT generation,attempt,state FROM retry_dispositions WHERE event_id=$1",
        [id],
      )
    ).rows,
    receipts: (
      await pool.query("SELECT 1 FROM receipts WHERE event_id=$1", [id])
    ).rowCount,
  });
  const requeued = async () =>
    wait(
      async () => (await channel.checkQueue(queue)).messageCount === 1,
      "requeue",
    );
  const calls = (p: ReturnType<typeof run>) =>
    p.signals.filter((s) => s.type === "lookup").length;
  it.each([
    ["lookup", "lookupBarrier"],
    ["beforeCommit", "beforeCommit"],
  ])(
    "rolls back after kill at %s",
    async (mode, barrier) => {
      const id = await setup();
      const first = run(mode);
      await until(first, barrier);
      expect(calls(first)).toBe(1);
      await stop(first.child);
      await requeued();
      expect(await state(id)).toEqual({
        result: null,
        dispositions: [],
        receipts: 0,
      });
      const second = run("finish");
      await finish(second);
      expect(
        second.signals.find((s) => s.type === "delivery")?.redelivered,
      ).toBe(true);
      expect(calls(second)).toBe(1);
      const done = await state(id);
      expect(done.result.lookup).toMatchObject({
        status: "found",
        address: { uf: "SP" },
      });
      expect(done.dispositions).toEqual([
        { generation: 0, attempt: 1, state: "completed" },
      ]);
      expect(done.receipts).toBe(1);
      expect((await channel.checkQueue(queue)).messageCount).toBe(0);
    },
    60000,
  );
  it("deduplicates committed work after death before ack", async () => {
    const id = await setup();
    const first = run("after");
    await until(first, "afterCommit");
    expect(calls(first)).toBe(1);
    const committed = await state(id);
    expect(committed.result.lookup.status).toBe("found");
    expect(committed.receipts).toBe(1);
    expect(committed.dispositions[0].state).toBe("completed");
    await stop(first.child);
    await requeued();
    const second = run("finish");
    await finish(second);
    expect(second.signals.find((s) => s.type === "delivery")?.redelivered).toBe(
      true,
    );
    expect(calls(second)).toBe(0);
    expect(await state(id)).toEqual(committed);
    expect((await channel.checkQueue(queue)).messageCount).toBe(0);
  }, 60000);
  it("reuses found observation across crash and event-level retry", async () => {
    const id = await setup();
    const first = run("retry");
    await until(first, "afterCommit");
    expect(calls(first)).toBe(1);
    const scheduled = await state(id);
    expect(scheduled.result.lookup.status).toBe("found");
    expect(scheduled.dispositions).toEqual([
      { generation: 0, attempt: 1, state: "retry_scheduled" },
    ]);
    expect(scheduled.receipts).toBe(0);
    await stop(first.child);
    await requeued();
    const duplicate = run("finish");
    await finish(duplicate);
    expect(
      duplicate.signals.find((s) => s.type === "delivery")?.redelivered,
    ).toBe(true);
    expect(calls(duplicate)).toBe(0);
    expect(await state(id)).toEqual(scheduled);
    await pool.query(
      "UPDATE retry_dispositions SET next_eligible_at=now() WHERE event_id=$1",
      [id],
    );
    expect(await scheduleOnce(pool, 100, id)).toBe(1);
    expect(await relayOnce(pool, channel, queue, [], id)).toBe(1);
    const retry = run("finish");
    await finish(retry);
    expect(calls(retry)).toBe(0);
    const done = await state(id);
    expect(done.result.lookup).toEqual(scheduled.result.lookup);
    expect(done.dispositions).toEqual([
      { generation: 1, attempt: 2, state: "completed" },
    ]);
    expect(done.receipts).toBe(1);
    expect(
      (
        await pool.query(
          "SELECT generation,processed_at FROM retry_publications WHERE event_id=$1",
          [id],
        )
      ).rows,
    ).toEqual([{ generation: 1, processed_at: expect.any(Date) }]);
    expect((await channel.checkQueue(queue)).messageCount).toBe(0);
  }, 60000);
});
