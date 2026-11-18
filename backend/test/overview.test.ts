import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import type pg from "pg";
import { api } from "../src/api.js";
import { overviewSql, parseOverview } from "../src/overview.js";
function fixture(period: "24h" | "7d" | "30d" = "24h") {
  const [seconds, n] = {
    "24h": [86400, 24],
    "7d": [604800, 7],
    "30d": [2592000, 30],
  }[period];
  const start = Date.parse("2026-01-01T00:00:00Z");
  const stamp = (time: number) =>
    new Date(time).toISOString().replace(".000Z", ".000000Z");
  return {
    version: 1,
    period,
    window: {
      start: stamp(start),
      end: stamp(start + seconds * 1000),
      timestamp: "createdAt",
    },
    automations: { total: 0, active: 0 },
    executions: {
      total: 0,
      success: 0,
      failed: 0,
      skipped: 0,
      pendingOrUnknown: 0,
      successRate: null,
      successRateDenominator: "success_plus_failed",
    },
    buckets: Array.from({ length: n }, (_, i) => ({
      start: stamp(start + (i * seconds * 1000) / n),
      end: stamp(start + ((i + 1) * seconds * 1000) / n),
      executions: 0,
    })),
    recent: [],
    executionFailures: [],
    eventAttention: {
      scope: "current",
      timestamp: "eventCreatedAt",
      items: [],
    },
    limitations: {
      completionTime: {
        value: null,
        reason: "completion_timestamp_not_persisted",
      },
      listLimit: 10,
    },
  };
}
describe("overview route", () => {
  it("validates periods and bodies before querying and rejects other methods", async () => {
    const query = vi.fn();
    const app = api({ query } as unknown as pg.Pool);
    for (const suffix of [
      "period=",
      "period=1d",
      "period=24h&period=24h",
      "extra=1",
      "period=7d%0a",
    ])
      expect((await app.inject(`/overview?${suffix}`)).statusCode).toBe(400);
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/overview",
          headers: { "content-type": "application/json" },
          payload: "{}",
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (await app.inject({ method: "POST", url: "/overview" })).statusCode,
    ).toBe(404);
    expect(query).not.toHaveBeenCalled();
    await app.close();
  });
  it("binds periods and rejects invalid full database shapes", async () => {
    const query = vi.fn();
    const app = api({ query } as unknown as pg.Pool);
    for (const [period, seconds, count] of [
      ["24h", 86400, 24],
      ["7d", 604800, 7],
      ["30d", 2592000, 30],
    ] as const) {
      query.mockResolvedValueOnce({ rows: [{ overview: fixture(period) }] });
      const response = await app.inject(`/overview?period=${period}`);
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual(fixture(period));
      expect(query).toHaveBeenLastCalledWith(overviewSql, [
        seconds,
        count,
        period,
      ]);
    }
    const valid = fixture();
    for (const invalid of [
      { ...valid, secret: "x" },
      { ...valid, window: { ...valid.window, extra: 1 } },
      { ...valid, executions: { ...valid.executions, successRate: 2 } },
      { ...valid, buckets: [] },
      {
        ...valid,
        eventAttention: {
          ...valid.eventAttention,
          items: [
            {
              eventId: "x",
              eventCreatedAt: valid.window.start,
              status: "blocked",
            },
          ],
        },
      },
      { ...valid, limitations: {} },
      {},
      null,
    ]) {
      query.mockResolvedValueOnce({ rows: [{ overview: invalid }] });
      expect((await app.inject("/overview")).statusCode).toBe(503);
    }
    query.mockResolvedValueOnce({ rows: [] });
    expect((await app.inject("/overview")).json()).toEqual({
      error: "unavailable",
    });
    query.mockRejectedValueOnce(new Error("private"));
    expect((await app.inject("/overview")).json()).toEqual({
      error: "unavailable",
    });
    await app.close();
  });
  it("validates nested execution and event units without leaking extra fields", () => {
    const v = fixture();
    const id = "00000000-0000-0000-0000-000000000001";
    const execution = {
      executionId: id,
      automationId: id,
      automationName: "Pinned",
      revision: 1,
      status: "failed",
      createdAt: v.window.start,
    };
    const filled = {
      ...v,
      executions: { ...v.executions, total: 1, failed: 1, successRate: 0 },
      buckets: v.buckets.map((b, i) => ({ ...b, executions: i === 0 ? 1 : 0 })),
      recent: [execution],
      executionFailures: [execution],
      eventAttention: {
        ...v.eventAttention,
        items: [
          {
            eventId: id,
            eventCreatedAt: "2020-01-01T00:00:00.000000Z",
            status: "blocked",
          },
        ],
      },
    };
    expect(parseOverview(filled)).toEqual(filled);
    expect(() =>
      parseOverview({
        ...filled,
        executionFailures: [{ ...execution, status: "success" }],
      }),
    ).toThrow();
    expect(() =>
      parseOverview({
        ...filled,
        recent: [{ ...execution, payload: { secret: true } }],
      }),
    ).toThrow();
    expect(() =>
      parseOverview({
        ...filled,
        eventAttention: {
          ...filled.eventAttention,
          items: [{ ...filled.eventAttention.items[0], disposition: "x" }],
        },
      }),
    ).toThrow();
  });
  it("uses a single grouped bucket scan and an ordered created-at index migration", async () => {
    expect(overviewSql).toContain("bucket_counts AS");
    expect(overviewSql).not.toMatch(
      /SELECT count\(\*\)::integer FROM executions e WHERE/,
    );
    expect(overviewSql).not.toMatch(/\bcontent\b|SELECT\s+x\.\*/i);
    const migration = await readFile(
      new URL(
        "../migrations/018_overview_execution_indexes.sql",
        import.meta.url,
      ),
      "utf8",
    );
    const runner = await readFile(
      new URL("../src/migrate.ts", import.meta.url),
      "utf8",
    );
    expect(migration).toMatch(
      /ON automation_executions\(created_at DESC, id DESC\)/,
    );
    expect(runner.indexOf("017_validate_viacep_execution.sql")).toBeLessThan(
      runner.indexOf("018_overview_execution_indexes.sql"),
    );
  });
});
