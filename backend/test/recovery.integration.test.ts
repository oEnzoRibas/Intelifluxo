import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { Message } from "amqplib";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { api } from "../src/api.js";
import { withCleanup } from "../src/cleanup.js";
import { connectBroker } from "../src/broker.js";
import {
  boundedSteps,
  connectDemoBroker,
  deadline,
  queueDeclaration,
  watchedChannel,
  destroyBroker,
  isolatedQueue,
} from "./automation-demo-bounds.js";
import { assertDemoSafety } from "../scripts/demo-safety.js";
import { scheduleOnce } from "../src/scheduler.js";
import { processMessage } from "../src/worker.js";

describe.skipIf(process.env.RECOVERY_INTEGRATION !== "true")(
  "real process recovery",
  () => {
    const schema = `recovery_${randomUUID().replaceAll("-", "")}`;
    const queue = isolatedQueue();
    let admin: pg.Pool, pool: pg.Pool;
    let broker: Awaited<ReturnType<typeof connectBroker>>;
    let channel: Awaited<ReturnType<typeof broker.createChannel>>;
    const declaration = queueDeclaration(queue);
    let schemaOwned = false;
    const children = new Set<ChildProcess>();
    const env = {
      ...process.env,
      PGOPTIONS: `-c search_path=${schema} -c statement_timeout=10000`,
      AUTOMATION_SNAPSHOTS_ENABLED: "true",
    };
    const run = (mode: "relay" | "worker" | "barrier") => {
      const appName = `recovery_${randomUUID()}`;
      const child = spawn(
        process.execPath,
        ["--import", "tsx", "test/recovery-worker-child.ts", mode],
        {
          env: { ...env, RECOVERY_QUEUE: queue, PGAPPNAME: appName },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      children.add(child);
      let output = "";
      child.stdout!.on("data", (data: Buffer) => {
        output = (output + data.toString()).slice(-8192);
      });
      child.stderr!.on("data", (data: Buffer) => {
        output = (output + data.toString()).slice(-8192);
      });
      let error: Error | undefined;
      child.on("error", (cause) => {
        error = cause;
        if (!child.pid) children.delete(child);
      });
      child.once("exit", () => children.delete(child));
      return {
        child,
        appName,
        output: () => output.slice(-8192),
        error: () => error,
      };
    };
    const wait = async (
      condition: () => boolean | Promise<boolean>,
      label: string,
    ) => {
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline) {
        if (await condition()) return;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw new Error(`timed out waiting for ${label}`);
    };
    const stop = async (child: ChildProcess) => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      if (!child.kill("SIGKILL")) throw new Error("failed to terminate child");
      await wait(
        () => child.exitCode !== null || child.signalCode !== null,
        "child termination",
      );
    };
    const waitFor = async (
      proc: ReturnType<typeof run>,
      condition: () => boolean | Promise<boolean>,
      label: string,
    ) => {
      try {
        await wait(async () => {
          if (proc.error())
            throw new Error(`${label}: spawn error: ${proc.error()?.message}`);
          if (proc.child.exitCode !== null || proc.child.signalCode !== null)
            throw new Error(
              `${label}: child exited (${proc.child.exitCode ?? proc.child.signalCode}); ${proc.output()}`,
            );
          return condition();
        }, label);
      } catch (cause) {
        throw new Error(`${label}: ${proc.output()}`, { cause });
      }
    };
    const finish = async (proc: ReturnType<typeof run>) => {
      await wait(
        () =>
          !!proc.error() ||
          proc.child.exitCode !== null ||
          proc.child.signalCode !== null,
        "process exit",
      );
      if (proc.error()) throw proc.error();
      expect(proc.child.exitCode, proc.output()).toBe(0);
    };
    beforeAll(async () => {
      assertDemoSafety(process.env);
      if (process.env.AUTOMATION_SNAPSHOTS_ENABLED !== "true")
        throw new Error("AUTOMATION_SNAPSHOTS_ENABLED must be explicitly true");
      if (!process.env.DATABASE_URL || !process.env.AMQP_URL)
        throw new Error("disposable DATABASE_URL and AMQP_URL required");
      admin = new pg.Pool({
        connectionString: process.env.DATABASE_URL,
        connectionTimeoutMillis: 10000,
        statement_timeout: 10000,
      });
      await admin.query(`CREATE SCHEMA "${schema}"`);
      schemaOwned = true;
      pool = new pg.Pool({
        connectionString: process.env.DATABASE_URL,
        options: `-c search_path=${schema}`,
        connectionTimeoutMillis: 10000,
        statement_timeout: 10000,
      });
      for (const file of [
        "001_init.sql",
        "002_retry_dispositions.sql",
        "003_retry_publications.sql",
        "004_automation_definitions.sql",
        "005_automation_executions.sql",
      ])
        await pool.query(
          await readFile(
            new URL(`../migrations/${file}`, import.meta.url),
            "utf8",
          ),
        );
      broker = await connectDemoBroker();
      channel = await deadline(
        "create channel",
        () => watchedChannel(broker.createChannel()),
        undefined,
        () => destroyBroker(broker),
      );
      await declaration.declare(channel, () => destroyBroker(broker));
    }, 30000);
    afterAll(async () => {
      await withCleanup(
        async () => {},
        () =>
          boundedSteps(
            [
              [
                "children",
                async () => {
                  await Promise.all([...children].map(stop));
                },
              ],
              [
                "queue",
                async () => {
                  await declaration.cleanup();
                },
              ],
              [
                "channel",
                async () => {
                  await channel?.close();
                },
              ],
              [
                "broker",
                async () => {
                  await broker?.close();
                },
              ],
              [
                "pool",
                async () => {
                  await pool?.end();
                },
              ],
              [
                "schema",
                async () => {
                  if (schemaOwned && admin)
                    await admin.query(
                      `DROP SCHEMA IF EXISTS "${schema}" CASCADE`,
                    );
                },
              ],
              [
                "admin",
                async () => {
                  await admin?.end();
                },
              ],
            ],
            () => destroyBroker(broker),
          ),
      );
    }, 90000);
    it("recovers committed unacked work and a retry published before relay death", async () => {
      const app = api(pool, true);
      try {
        const config = {
          name: "recovery",
          schemaVersion: 1,
          trigger: { type: "receipt.v1" },
          action: { type: "record-receipt.v1" },
        };
        const created = await app.inject({
          method: "POST",
          url: "/automations",
          payload: { ...config, scope: "recovery" },
        });
        expect(created.statusCode).toBe(201);
        const automationId = created.json().id;
        expect(
          (
            await app.inject({
              method: "PUT",
              url: `/automations/${automationId}`,
              payload: { ...config, active: true, expectedRevision: 1 },
            })
          ).statusCode,
        ).toBe(200);
        const make = async (message: string) => {
          const response = await app.inject({
            method: "POST",
            url: "/events",
            payload: {
              scope: "recovery",
              idempotencyKey: randomUUID(),
              type: "receipt.v1",
              target: "local-receipt",
              message,
            },
          });
          expect(response.statusCode).toBe(202);
          const eventId = response.json().id as string;
          const execution = (
            await app.inject({
              method: "GET",
              url: `/executions?eventId=${eventId}`,
            })
          ).json().items[0];
          expect(execution).toMatchObject({
            automationId,
            revision: 2,
            status: "accepted",
          });
          return { eventId, executionId: execution.id as string, message };
        };
        const completed = async (item: Awaited<ReturnType<typeof make>>) => {
          const items = (
            await app.inject({
              method: "GET",
              url: `/executions?eventId=${item.eventId}`,
            })
          ).json().items;
          if (items[0]?.status !== "completed") return false;
          expect(items).toHaveLength(1);
          expect(items[0]).toMatchObject({
            id: item.executionId,
            automationId,
            revision: 2,
            result: {
              kind: "local-receipt.v1",
              eventId: item.eventId,
              message: item.message,
            },
          });
          expect(
            (
              await pool.query("SELECT 1 FROM receipts WHERE event_id=$1", [
                item.eventId,
              ])
            ).rowCount,
          ).toBe(1);
          return true;
        };
        const first = await make("commit barrier");
        await finish(run("relay"));
        const paused = run("barrier");
        await waitFor(
          paused,
          () => paused.output().includes("READY"),
          "barrier worker readiness",
        );
        await waitFor(
          paused,
          () => paused.output().includes("COMMITTED_UNACKED"),
          "commit barrier",
        );
        expect(await completed(first)).toBe(true);
        await stop(paused.child);
        await wait(
          async () =>
            (
              await deadline(
                "check queue",
                () => channel.checkQueue(queue),
                undefined,
                () => destroyBroker(broker),
              )
            ).messageCount === 1,
          "unacked message requeued after worker death",
        );
        const redelivery = await deadline(
          "get delivery",
          () => channel.get(queue, { noAck: false }),
          undefined,
          () => destroyBroker(broker),
        );
        expect(redelivery).not.toBe(false);
        if (!redelivery) throw new Error("missing redelivery");
        expect(redelivery.fields.redelivered).toBe(true);
        channel.nack(redelivery, false, true);
        const worker = run("worker");
        await waitFor(
          worker,
          () => worker.output().includes("READY"),
          "restarted worker readiness",
        );
        await waitFor(
          worker,
          () => worker.output().includes("ACKED"),
          "redelivery acknowledged",
        );
        await stop(worker.child);
        expect(await completed(first)).toBe(true);

        const second = await make("retry barrier");
        await pool.query(
          "UPDATE outbox SET confirmed_at=now() WHERE event_id=$1",
          [second.eventId],
        );
        await processMessage(
          pool,
          {
            content: Buffer.from(
              JSON.stringify({ version: 1, eventId: second.eventId }),
            ),
          } as Message,
          undefined,
          { handler: async () => "transient" },
        );
        await pool.query(
          "UPDATE retry_dispositions SET next_eligible_at=now() WHERE event_id=$1",
          [second.eventId],
        );
        expect(await scheduleOnce(pool, 100, second.eventId)).toBe(1);
        const lock = await pool.connect();
        try {
          await lock.query("BEGIN");
          await lock.query(
            "SELECT 1 FROM retry_publications WHERE event_id=$1 FOR UPDATE",
            [second.eventId],
          );
          const relay = run("relay");
          await waitFor(
            relay,
            async () =>
              (
                await deadline(
                  "check queue",
                  () => channel.checkQueue(queue),
                  undefined,
                  () => destroyBroker(broker),
                )
              ).messageCount === 1,
            "retry publication before database confirmation",
          );
          expect(
            (
              await pool.query(
                "SELECT confirmed_at FROM retry_publications WHERE event_id=$1",
                [second.eventId],
              )
            ).rows[0].confirmed_at,
          ).toBeNull();
          await stop(relay.child);
          // A disconnected client can leave a server-side UPDATE waiting on our
          // lock. Terminate only this test child's tagged session before unlock.
          await admin.query(
            "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name=$1 AND datname=current_database() AND usename=current_user AND pid <> pg_backend_pid()",
            [relay.appName],
          );
          await wait(
            async () =>
              (
                await admin.query(
                  "SELECT 1 FROM pg_stat_activity WHERE application_name=$1 AND datname=current_database() AND usename=current_user",
                  [relay.appName],
                )
              ).rowCount === 0,
            "relay database session termination",
          );
        } finally {
          await lock.query("ROLLBACK");
          lock.release();
        }
        await finish(run("relay"));
        expect(
          (
            await deadline(
              "check retry queue",
              () => channel.checkQueue(queue),
              undefined,
              () => destroyBroker(broker),
            )
          ).messageCount,
        ).toBe(2);
        const restarted = run("worker");
        await waitFor(
          restarted,
          () => restarted.output().includes("READY"),
          "retry worker readiness",
        );
        await waitFor(restarted, () => completed(second), "retry result");
        await waitFor(
          restarted,
          () => (restarted.output().match(/ACKED/g) ?? []).length === 2,
          "both retry deliveries acknowledged",
        );
        await stop(restarted.child);
        expect(await completed(second)).toBe(true);
        expect(
          (
            await pool.query(
              "SELECT confirmed_at,processed_at FROM retry_publications WHERE event_id=$1",
              [second.eventId],
            )
          ).rows[0],
        ).toMatchObject({
          confirmed_at: expect.any(Date),
          processed_at: expect.any(Date),
        });
      } finally {
        await app.close();
      }
    }, 90000);
  },
);
