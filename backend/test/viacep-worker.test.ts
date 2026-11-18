import { expect, it, vi } from "vitest";
import type pg from "pg";
import type { Message } from "amqplib";
import { handleMessage, processMessage } from "../src/worker.js";

it("selects explicit SQL-null evidence with execution results", async () => {
  const h = harness([]);
  await processMessage(h.pool, h.message);
  const selection = h.calls.find((call) =>
    call.sql.includes("FROM automation_executions x"),
  )?.sql;
  expect(selection).toContain(
    "x.result,x.result IS NULL AS result_is_sql_null",
  );
});

const eventId = "11111111-1111-1111-1111-111111111111";
const ids = [
  "22222222-2222-2222-2222-222222222222",
  "33333333-3333-3333-3333-333333333333",
];
const graph = (source: "event" | "fixed" = "event", expected = "SP") => ({
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
      config: {
        cep:
          source === "event"
            ? { source, fieldPath: "address.cep" }
            : { source, value: "01001-000" },
      },
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
        expectedValue: expected,
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
});
const row = (id = ids[0], g: unknown = graph()) => ({
  id,
  schema_version: 3,
  trigger_type: "receipt.v1",
  action_type: "record-receipt.v1",
  revision_version: 3,
  revision_trigger: "receipt.v1",
  revision_action: "record-receipt.v1",
  graph: g,
  result: null as unknown,
  result_is_sql_null: true,
});
const found = {
  status: "found" as const,
  address: { cep: "01001-000", uf: "SP" },
};
function harness(
  rows: ReturnType<typeof row>[],
  generation = 0,
  cep = "01001-000",
  settings: {
    missingV3?: boolean;
    terminal?: boolean;
    fail?: "COMMIT" | "write";
  } = {},
) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const written = new Set<string>();
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    calls.push({ sql, params });
    if (
      (settings.fail === "COMMIT" && sql === "COMMIT") ||
      (settings.fail === "write" &&
        sql.startsWith("UPDATE automation_executions SET result"))
    )
      throw new Error("private-canary");
    if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql))
      return { rowCount: null, rows: [] };
    if (sql.startsWith("SELECT id,content"))
      return {
        rowCount: 1,
        rows: [{ id: eventId, content: { message: "ok", address: { cep } } }],
      };
    if (sql.includes("FROM retry_dispositions"))
      return generation
        ? {
            rowCount: 1,
            rows: [
              {
                generation,
                attempt: generation,
                state: settings.terminal ? "completed" : "retry_scheduled",
              },
            ],
          }
        : { rowCount: 0, rows: [] };
    if (sql.includes("SELECT processed_at"))
      return {
        rowCount: 1,
        rows: [{ processed_at: settings.terminal ? new Date() : null }],
      };
    if (sql.includes("FROM automation_executions x"))
      return { rowCount: rows.length, rows };
    if (sql.startsWith("UPDATE automation_executions SET result")) {
      written.add(params[0] as string);
      return { rowCount: 1, rows: [] };
    }
    if (sql.includes("schema_version=3 AND result IS NULL")) {
      const missing =
        settings.missingV3 ||
        rows.some(
          (r) =>
            r.schema_version === 3 &&
            r.result_is_sql_null &&
            !written.has(r.id),
        );
      return {
        rowCount: missing ? 1 : 0,
        rows: missing ? [{ "?column?": 1 }] : [],
      };
    }
    if (sql.startsWith("SELECT 1 FROM receipts"))
      return { rowCount: 0, rows: [] };
    if (
      sql.startsWith("INSERT INTO") ||
      sql.startsWith("UPDATE retry_publications")
    )
      return { rowCount: 1, rows: [] };
    throw new Error(`unexpected mock query: ${sql}`);
  });
  const pool = {
    connect: async () => ({ query, release: vi.fn() }),
  } as unknown as pg.Pool;
  const message = {
    content: Buffer.from(JSON.stringify({ version: 1, eventId, generation })),
  } as Message;
  const results = () =>
    calls
      .filter((c) =>
        c.sql.startsWith("UPDATE automation_executions SET result"),
      )
      .map((c) => JSON.parse(c.params[1] as string));
  const disposition = () =>
    calls.find((c) => c.sql.includes("INSERT INTO retry_dispositions"))?.params;
  return { pool, message, calls, results, disposition };
}

it("blocks outbound lookup and persists a permanent security failure by default", async () => {
  const h = harness([row()]);
  const lookup = vi.fn(async () => found);
  await processMessage(h.pool, h.message, undefined, { viacepLookup: lookup });
  expect(lookup).not.toHaveBeenCalled();
  expect(h.results()[0].failure).toMatchObject({
    code: "viacep_security_rejected",
    classification: "permanent",
  });
  expect(h.disposition()?.slice(3, 5)).toEqual(["permanent", "blocked"]);
  expect(h.calls.some((c) => c.sql === "COMMIT")).toBe(true);
});

it.each([
  ["event", "SP", "TRUE", "executed"],
  ["fixed", "RJ", "FALSE", "ignored"],
] as const)(
  "persists %s CEP and %s condition",
  async (source, expected, branch, status) => {
    const h = harness([row(ids[0], graph(source, expected))]);
    const lookup = vi.fn(async () => found);
    await processMessage(h.pool, h.message, undefined, {
      viacepExternalExecutionEnabled: true,
      viacepLookup: lookup,
      viacepTimeoutMs: 1234,
    });
    expect(lookup).toHaveBeenCalledWith("01001000", { timeoutMs: 1234 });
    expect(h.results()[0]).toMatchObject({
      decision: { outcome: branch },
      action: { status },
    });
    expect(h.calls.some((c) => c.sql.includes("INSERT INTO receipts"))).toBe(
      true,
    );
    const check = h.calls.findIndex((c) =>
      c.sql.includes("schema_version=3 AND result IS NULL"),
    );
    expect(check).toBeGreaterThan(
      h.calls.findIndex((c) =>
        c.sql.startsWith("UPDATE automation_executions"),
      ),
    );
    expect(check).toBeLessThan(
      h.calls.findIndex((c) =>
        c.sql.includes("INSERT INTO retry_dispositions"),
      ),
    );
  },
);

it.each([
  ["timeout", "transient", "retry_scheduled"],
  ["http_permanent", "permanent", "blocked"],
  ["unknown", "unknown", "blocked"],
] as const)("maps %s to %s", async (status, outcome, state) => {
  const h = harness([row()]);
  await processMessage(h.pool, h.message, undefined, {
    viacepExternalExecutionEnabled: true,
    viacepLookup: async () => ({ status }),
  });
  expect(h.disposition()?.slice(3, 5)).toEqual([outcome, state]);
  expect(h.results()[0].failure.classification).toBe(outcome);
  expect(h.calls.some((c) => c.sql.includes("INSERT INTO receipts"))).toBe(
    false,
  );
});

it("rejects invalid CEP without lookup", async () => {
  const h = harness([row()], 0, "bad");
  const lookup = vi.fn(async () => found);
  await processMessage(h.pool, h.message, undefined, {
    viacepExternalExecutionEnabled: true,
    viacepLookup: lookup,
  });
  expect(lookup).not.toHaveBeenCalled();
  expect(h.results()[0].failure.code).toBe("invalid_cep");
});

it.each([
  [0, "retry_scheduled", 1000, "transient"],
  [1, "retry_scheduled", 2000, "transient"],
  [2, "blocked", null, "exhausted"],
] as const)(
  "decides retry attempt %i",
  async (generation, state, delay, classification) => {
    const h = harness([row()], generation);
    await processMessage(h.pool, h.message, undefined, {
      viacepExternalExecutionEnabled: true,
      viacepLookup: async () => ({ status: "timeout" }),
    });
    expect(h.disposition()?.slice(2)).toEqual([
      generation + 1,
      "transient",
      state,
      delay,
      classification === "exhausted" ? "exhausted" : null,
    ]);
    expect(h.results()[0].failure.classification).toBe(classification);
  },
);

it("reuses found observation on retry with transient peer", async () => {
  const first = harness([row()]);
  await processMessage(first.pool, first.message, undefined, {
    viacepExternalExecutionEnabled: true,
    viacepLookup: async () => found,
    handler: async () => "transient",
  });
  const r = row();
  r.result = first.results()[0];
  r.result_is_sql_null = false;
  const retry = harness([r], 1);
  const lookup = vi.fn(async () => found);
  await processMessage(retry.pool, retry.message, undefined, {
    viacepExternalExecutionEnabled: true,
    viacepLookup: lookup,
    handler: async () => "transient",
  });
  expect(lookup).not.toHaveBeenCalled();
  expect(retry.results()[0].lookup).toEqual(first.results()[0].lookup);
});

it("preserves a frozen ignored execution while retrying only its transient peer", async () => {
  const rows = [row(ids[0], graph("event", "RJ")), row(ids[1])];
  const first = harness(rows);
  const firstLookup = vi
    .fn()
    .mockResolvedValueOnce(found)
    .mockResolvedValueOnce({ status: "timeout" });
  await processMessage(first.pool, first.message, undefined, {
    viacepExternalExecutionEnabled: true,
    viacepLookup: firstLookup,
  });
  expect(firstLookup).toHaveBeenCalledTimes(2);
  expect(first.disposition()?.[4]).toBe("retry_scheduled");
  const persisted = first.results();
  expect(persisted[0].action.status).toBe("ignored");
  const snapshot = structuredClone(persisted[0]);
  const freeze = (value: unknown): void => {
    if (value && typeof value === "object") {
      Object.values(value).forEach(freeze);
      Object.freeze(value);
    }
  };
  freeze(persisted[0]);
  const retryRows = rows.map((r, i) => ({
    ...r,
    result: persisted[i],
    result_is_sql_null: false,
  }));
  const retry = harness(retryRows, 1);
  const lookup = vi.fn(async () => ({ status: "timeout" as const }));
  await processMessage(retry.pool, retry.message, undefined, {
    viacepExternalExecutionEnabled: true,
    viacepLookup: lookup,
  });
  expect(
    retry.calls.some((c) => c.sql.includes("FROM automation_executions x")),
  ).toBe(true);
  expect(retry.calls.some((c) => c.sql.includes("SELECT processed_at"))).toBe(
    true,
  );
  expect(lookup).toHaveBeenCalledTimes(1);
  expect(
    retry.calls
      .filter((c) => c.sql.startsWith("UPDATE automation_executions"))
      .map((c) => c.params[0]),
  ).toEqual(ids);
  expect(retry.results()[0]).toEqual(snapshot);
  expect(persisted[0]).toEqual(snapshot);
  expect(retry.results()[1].failure.code).toBe("viacep_timeout");
  expect(retry.disposition()?.[4]).toBe("retry_scheduled");
});

it("plans all finalizations before issuing any result writes", async () => {
  const initial = harness([row(ids[1])]);
  await processMessage(initial.pool, initial.message, undefined, {
    viacepExternalExecutionEnabled: true,
    viacepLookup: async () => found,
  });
  const executed = initial.results()[0];
  expect(executed.action.status).toBe("executed");
  // The unsupported first execution finalizes successfully, but its unknown
  // outcome contradicts the second execution's already-executed terminal result.
  const later = { ...row(ids[1]), result: executed, result_is_sql_null: false };
  const h = harness([row(ids[0], {}), later], 1);
  await expect(processMessage(h.pool, h.message)).rejects.toThrow(
    "execution invariant",
  );
  expect(h.calls.some((c) => c.sql.startsWith("INSERT INTO receipts"))).toBe(
    false,
  );
  expect(
    h.calls.some((c) => c.sql.startsWith("UPDATE automation_executions")),
  ).toBe(false);
  expect(h.disposition()).toBeUndefined();
  expect(h.calls.at(-1)?.sql).toBe("ROLLBACK");
});

it("overrides unknown with permanent peer and performs lookups sequentially", async () => {
  const h = harness([row(ids[0]), row(ids[1])]);
  let active = 0;
  let call = 0;
  const lookup = vi.fn(async () => {
    expect(active).toBe(0);
    active++;
    await Promise.resolve();
    active--;
    return ++call === 1
      ? { status: "unknown" as const }
      : { status: "not_found" as const };
  });
  await processMessage(h.pool, h.message, undefined, {
    viacepExternalExecutionEnabled: true,
    viacepLookup: lookup,
  });
  expect(h.results()[0].failure).toMatchObject({
    classification: "permanent",
    code: "event_peer_failure",
  });
  expect(h.disposition()?.[3]).toBe("permanent");
  expect(
    h.calls
      .filter((c) => c.sql.startsWith("UPDATE automation_executions"))
      .map((c) => c.params[0]),
  ).toEqual(ids);
});

it.each([null, {}, { kind: "invalid" }])(
  "rolls back malformed or JSON-null prior",
  async (prior) => {
    const r = row();
    r.result = prior;
    r.result_is_sql_null = false;
    const h = harness([r]);
    const lookup = vi.fn(async () => found);
    await expect(
      processMessage(h.pool, h.message, undefined, {
        viacepExternalExecutionEnabled: true,
        viacepLookup: lookup,
      }),
    ).rejects.toThrow("execution invariant");
    expect(lookup).not.toHaveBeenCalled();
    expect(h.disposition()).toBeUndefined();
    expect(h.calls.some((c) => c.sql.includes("INSERT INTO receipts"))).toBe(
      false,
    );
    expect(h.calls.at(-1)?.sql).toBe("ROLLBACK");
  },
);

it("persists unsupported fallback and rolls back before commit errors", async () => {
  const h = harness([row(ids[0], {})]);
  await processMessage(h.pool, h.message);
  expect(h.results()[0].failure.code).toBe("unsupported_execution_contract");
  expect(h.disposition()?.[3]).toBe("unknown");
  const rollback = harness([row()]);
  await expect(
    processMessage(
      rollback.pool,
      rollback.message,
      async () => {
        throw new Error("abort");
      },
      { viacepExternalExecutionEnabled: true, viacepLookup: async () => found },
    ),
  ).rejects.toThrow("abort");
  expect(rollback.calls.at(-1)?.sql).toBe("ROLLBACK");
  expect(rollback.calls.some((c) => c.sql === "COMMIT")).toBe(false);
});

it("combines v1, v2 and v3 in execution order and preserves legacy FALSE", async () => {
  const v1 = {
    ...row(ids[0]),
    schema_version: 1,
    revision_version: 1,
    graph: null,
    graph_is_sql_null: true,
  };
  const base = graph();
  const v2graph = {
    version: 2,
    nodes: base.nodes
      .filter((n) => n.kind !== "lookup")
      .map((n) =>
        n.kind === "condition"
          ? {
              ...n,
              type: "condition.v1",
              config: {
                fieldPath: "message",
                operator: "equals",
                expectedType: "string",
                expectedValue: "no",
              },
            }
          : n,
      ),
    edges: [
      { source: "trigger", target: "condition" },
      ...base.edges.filter(
        (e) => e.source === "condition" || e.source === "action",
      ),
    ],
  };
  const v2 = {
    ...row(ids[1]),
    schema_version: 2,
    revision_version: 2,
    graph: v2graph,
  };
  const third = "44444444-4444-4444-4444-444444444444";
  const h = harness([v1, v2, row(third)]);
  await processMessage(h.pool, h.message, undefined, {
    viacepExternalExecutionEnabled: true,
    viacepLookup: async () => found,
  });
  expect(h.results()).toMatchObject([
    { kind: "local-receipt.v1", message: "ok" },
    { decision: { outcome: "FALSE" }, action: { status: "ignored" } },
    { decision: { outcome: "TRUE" }, action: { status: "executed" } },
  ]);
  expect(
    h.calls
      .filter((c) => c.sql.startsWith("UPDATE automation_executions"))
      .map((c) => c.params[0]),
  ).toEqual([ids[0], ids[1], third]);
  expect(
    h.calls.findIndex((c) => c.sql.startsWith("INSERT INTO receipts")),
  ).toBeLessThan(
    h.calls.findIndex((c) => c.sql.startsWith("UPDATE automation_executions")),
  );
  expect(h.calls.at(-1)?.sql).toBe("COMMIT");
});

it("keeps the baseline receipt when all decisions are FALSE", async () => {
  const h = harness([
    row(ids[0], graph("event", "RJ")),
    row(ids[1], graph("fixed", "RJ")),
  ]);
  await processMessage(h.pool, h.message, undefined, {
    viacepExternalExecutionEnabled: true,
    viacepLookup: async () => found,
  });
  expect(h.results().map((r) => r.action.status)).toEqual([
    "ignored",
    "ignored",
  ]);
  expect(
    h.calls.filter((c) => c.sql.includes("INSERT INTO receipts")),
  ).toHaveLength(1);
  expect(h.disposition()?.[4]).toBe("completed");
});

it.each(["transient", "unknown", "permanent"] as const)(
  "action %s participates in aggregate precedence without receipts",
  async (actionOutcome) => {
    const h = harness([row(ids[0]), row(ids[1])]);
    let count = 0;
    await processMessage(h.pool, h.message, undefined, {
      viacepExternalExecutionEnabled: true,
      viacepLookup: async () => (++count === 1 ? found : { status: "timeout" }),
      handler: async () => actionOutcome,
    });
    expect(h.disposition()?.[3]).toBe(actionOutcome);
    expect(h.calls.some((c) => c.sql.includes("INSERT INTO receipts"))).toBe(
      false,
    );
    expect(h.results()[0].failure).toMatchObject({
      classification: actionOutcome,
      code: `action_${actionOutcome}`,
    });
    expect(h.results()[1].failure.classification).toBe(actionOutcome);
  },
);

it.each(["executed", "ignored"] as const)(
  "terminal %s redelivery makes no provider call",
  async (status) => {
    const first = harness([
      row(ids[0], graph("event", status === "ignored" ? "RJ" : "SP")),
    ]);
    await processMessage(first.pool, first.message, undefined, {
      viacepExternalExecutionEnabled: true,
      viacepLookup: async () => found,
    });
    expect(first.results()[0].action.status).toBe(status);
    const r = row();
    r.result = first.results()[0];
    r.result_is_sql_null = false;
    const h = harness([r], 1, "01001-000", { terminal: true });
    const lookup = vi.fn(async () => found);
    await processMessage(h.pool, h.message, undefined, {
      viacepExternalExecutionEnabled: true,
      viacepLookup: lookup,
    });
    expect(lookup).not.toHaveBeenCalled();
    expect(h.results()).toHaveLength(0);
    expect(h.calls.at(-1)?.sql).toBe("COMMIT");
  },
);

it("rejects a prior observation mismatched to the pinned CEP before lookup", async () => {
  const first = harness([row()]);
  await processMessage(first.pool, first.message, undefined, {
    viacepExternalExecutionEnabled: true,
    viacepLookup: async () => found,
    handler: async () => "transient",
  });
  const r = row();
  r.result = first.results()[0];
  r.result_is_sql_null = false;
  const h = harness([r], 1, "22222-222");
  const lookup = vi.fn(async () => found);
  await expect(
    processMessage(h.pool, h.message, undefined, {
      viacepExternalExecutionEnabled: true,
      viacepLookup: lookup,
    }),
  ).rejects.toThrow(/^execution invariant$/);
  expect(lookup).not.toHaveBeenCalled();
  expect(h.disposition()).toBeUndefined();
  expect(h.calls.at(-1)?.sql).toBe("ROLLBACK");
});

it("rolls back on the v3 SQL NULL assertion before disposition", async () => {
  const h = harness([row()], 0, "01001-000", { missingV3: true });
  await expect(
    processMessage(h.pool, h.message, undefined, {
      viacepExternalExecutionEnabled: true,
      viacepLookup: async () => found,
    }),
  ).rejects.toThrow(/^execution invariant$/);
  expect(h.results()).toHaveLength(1);
  expect(h.disposition()).toBeUndefined();
  expect(h.calls.at(-1)?.sql).toBe("ROLLBACK");
  expect(h.calls.some((c) => c.sql === "COMMIT")).toBe(false);
});

it.each([
  ["found", "found", "none"],
  ["not_found", "not_found", "viacep_not_found"],
  ["timeout", "failed", "viacep_timeout"],
  ["transport", "failed", "viacep_transport"],
  ["http_transient", "failed", "viacep_http_transient"],
  ["http_permanent", "failed", "viacep_http_permanent"],
  ["invalid_response", "failed", "viacep_invalid_response"],
  ["security_rejected", "failed", "viacep_security_rejected"],
  ["unknown", "failed", "viacep_unknown"],
] as const)("telemetry bounds %s lookup", async (status, outcome, code) => {
  const h = harness([row()]);
  const records: import("../src/worker-telemetry.js").TelemetryRecord[] = [];
  await processMessage(h.pool, h.message, undefined, {
    viacepExternalExecutionEnabled: true,
    viacepLookup: async () => (status === "found" ? found : { status }),
    telemetry: (record) => records.push(record),
    now: () => 10,
  });
  expect(records.filter((r) => r.event === "lookup_attempted")).toHaveLength(1);
  expect(records.find((r) => r.event === "lookup_finished")).toMatchObject({
    outcome,
    code,
    durationMs: 0,
  });
  expect(JSON.stringify(records)).not.toContain("01001");
});

it("reports invalid CEP without a lookup and tolerates a throwing sink", async () => {
  const h = harness([row()], 0, "private-canary");
  const lookup = vi.fn(async () => found);
  const records: import("../src/worker-telemetry.js").TelemetryRecord[] = [];
  await processMessage(h.pool, h.message, undefined, {
    viacepExternalExecutionEnabled: true,
    viacepLookup: lookup,
    telemetry: (r) => {
      records.push(r);
      throw new Error("private-canary");
    },
  });
  expect(lookup).not.toHaveBeenCalled();
  expect(records.find((r) => r.event === "lookup_rejected")).toMatchObject({
    code: "invalid_cep",
  });
  expect(JSON.stringify(records)).not.toContain("private-canary");
  expect(h.calls.some((c) => c.sql === "COMMIT")).toBe(true);
});

it.each([
  [0, 1000],
  [1, 2000],
  [2, null],
] as const)(
  "emits one committed retry disposition at generation %i",
  async (generation, delay) => {
    const h = harness([row(), row(ids[1])], generation);
    const records: import("../src/worker-telemetry.js").TelemetryRecord[] = [];
    await processMessage(h.pool, h.message, undefined, {
      viacepExternalExecutionEnabled: true,
      viacepLookup: async () => ({ status: "timeout" }),
      telemetry: (r) => {
        if (r.event === "retry_scheduled" || r.event === "retry_exhausted")
          expect(h.calls.at(-1)?.sql).toBe("COMMIT");
        records.push(r);
      },
    });
    const disposition = records.filter(
      (r) => r.event === "retry_scheduled" || r.event === "retry_exhausted",
    );
    expect(disposition).toHaveLength(1);
    expect(disposition[0].event).toBe(
      delay === null ? "retry_exhausted" : "retry_scheduled",
    );
    if (delay !== null) expect(disposition[0].delayMs).toBe(delay);
  },
);

it("does not claim a disposition if beforeCommit fails", async () => {
  const h = harness([row()]);
  const records: import("../src/worker-telemetry.js").TelemetryRecord[] = [];
  await expect(
    processMessage(
      h.pool,
      h.message,
      async () => {
        throw new Error("private-canary");
      },
      {
        viacepExternalExecutionEnabled: true,
        viacepLookup: async () => ({ status: "timeout" }),
        telemetry: (r) => records.push(r),
      },
    ),
  ).rejects.toThrow();
  expect(records.some((r) => r.event === "retry_scheduled")).toBe(false);
  expect(records.find((r) => r.event === "transaction_finished")?.outcome).toBe(
    "not_confirmed",
  );
  expect(JSON.stringify(records)).not.toContain("private-canary");
});

it.each(["write", "COMMIT", "beforeCommit"] as const)(
  "does not acknowledge or claim retry on %s failure",
  async (failure) => {
    const h = harness([row()], 0, "01001-000", {
      fail: failure === "beforeCommit" ? undefined : failure,
    });
    const records: import("../src/worker-telemetry.js").TelemetryRecord[] = [];
    const ack = vi.fn();
    await expect(
      handleMessage(
        h.pool,
        { ack } as never,
        h.message,
        undefined,
        failure === "beforeCommit"
          ? async () => {
              throw new Error("private-canary");
            }
          : undefined,
        {
          viacepExternalExecutionEnabled: true,
          viacepLookup: async () => ({ status: "timeout" }),
          telemetry: (r) => records.push(r),
        },
      ),
    ).rejects.toThrow();
    expect(ack).not.toHaveBeenCalled();
    expect(
      records.some(
        (r) =>
          r.event === "retry_scheduled" ||
          r.event === "retry_exhausted" ||
          r.event === "event_blocked",
      ),
    ).toBe(false);
    expect(
      records.find((r) => r.event === "transaction_finished")?.outcome,
    ).toBe("not_confirmed");
  },
);

it("emits post-commit telemetry before the hook and acknowledgement", async () => {
  const h = harness([row()]);
  const order: string[] = [];
  await handleMessage(
    h.pool,
    { ack: () => order.push("ack") } as never,
    h.message,
    async () => {
      order.push("hook");
    },
    undefined,
    {
      viacepExternalExecutionEnabled: true,
      viacepLookup: async () => ({ status: "timeout" }),
      telemetry: (r) => {
        if (r.event === "retry_scheduled") {
          expect(h.calls.at(-1)?.sql).toBe("COMMIT");
          order.push("telemetry");
        }
      },
    },
  );
  expect(order).toEqual(["telemetry", "hook", "ack"]);
});

it.each(["throw", "nan", "infinity"] as const)(
  "omits durations for unavailable %s clock endpoints",
  async (kind) => {
    const h = harness([row()]);
    const records: import("../src/worker-telemetry.js").TelemetryRecord[] = [];
    await processMessage(h.pool, h.message, undefined, {
      viacepExternalExecutionEnabled: true,
      viacepLookup: async () => found,
      telemetry: (r) => records.push(r),
      now: () => {
        if (kind === "throw") throw new Error("clock secret");
        return kind === "nan" ? NaN : Infinity;
      },
    });
    const lookup = records.find((r) => r.event === "lookup_finished")!;
    const transaction = records.find(
      (r) => r.event === "transaction_finished",
    )!;
    expect(lookup).not.toHaveProperty("durationMs");
    expect(transaction).not.toHaveProperty("durationMs");
    expect(transaction).not.toHaveProperty("lockWaitMs");
    expect(transaction).not.toHaveProperty("lockHeldMs");
    expect(JSON.stringify(records)).not.toContain("clock secret");
  },
);

it("reports reused found observation on peer retry without another lookup", async () => {
  const first = harness([row()]);
  await processMessage(first.pool, first.message, undefined, {
    viacepExternalExecutionEnabled: true,
    viacepLookup: async () => found,
    handler: async () => "transient",
  });
  const r = row();
  r.result = first.results()[0];
  r.result_is_sql_null = false;
  const h = harness([r], 1);
  const lookup = vi.fn(async () => found);
  const records: import("../src/worker-telemetry.js").TelemetryRecord[] = [];
  await processMessage(h.pool, h.message, undefined, {
    viacepExternalExecutionEnabled: true,
    viacepLookup: lookup,
    handler: async () => "transient",
    telemetry: (r) => records.push(r),
  });
  expect(lookup).not.toHaveBeenCalled();
  expect(records.filter((r) => r.event === "lookup_reused")).toHaveLength(1);
  expect(
    records.some(
      (r) => r.event === "lookup_attempted" || r.event === "lookup_finished",
    ),
  ).toBe(false);
});

it.each(["permanent", "unknown"] as const)(
  "emits one blocked disposition for %s",
  async (status) => {
    const h = harness([row()]);
    const records: import("../src/worker-telemetry.js").TelemetryRecord[] = [];
    await processMessage(h.pool, h.message, undefined, {
      handler: async () => status,
      viacepExternalExecutionEnabled: true,
      viacepLookup: async () => found,
      telemetry: (r) => records.push(r),
    });
    expect(records.filter((r) => r.event === "event_blocked")).toHaveLength(1);
  },
);

it("records a finalizer invariant once and rolls back without leaking the error", async () => {
  const execution = await import("../src/viacep-execution.js");
  const spy = vi
    .spyOn(execution, "finalizeViaCepExecution")
    .mockImplementation(() => {
      throw new Error("finalizer-secret");
    });
  const h = harness([row()]);
  const records: import("../src/worker-telemetry.js").TelemetryRecord[] = [];
  try {
    await expect(
      processMessage(h.pool, h.message, undefined, {
        viacepExternalExecutionEnabled: true,
        viacepLookup: async () => found,
        telemetry: (r) => records.push(r),
      }),
    ).rejects.toThrow("finalizer-secret");
    expect(
      records.filter((r) => r.event === "execution_invariant"),
    ).toHaveLength(1);
    expect(JSON.stringify(records)).not.toContain("finalizer-secret");
    expect(h.disposition()).toBeUndefined();
    expect(h.calls.at(-1)?.sql).toBe("ROLLBACK");
  } finally {
    spy.mockRestore();
  }
});

it.each([1, 2])("reports unsupported legacy v%i contract", async (version) => {
  const r = row();
  r.schema_version = version;
  r.revision_version = version;
  r.trigger_type = "invalid";
  const h = harness([r]);
  const records: import("../src/worker-telemetry.js").TelemetryRecord[] = [];
  await processMessage(h.pool, h.message, undefined, {
    telemetry: (r) => records.push(r),
  });
  expect(
    records.filter((r) => r.event === "unsupported_execution_contract"),
  ).toHaveLength(1);
});

it("does not emit a disposition on redelivery", async () => {
  const h = harness([row()], 1, "01001-000", { terminal: true });
  const records: import("../src/worker-telemetry.js").TelemetryRecord[] = [];
  await processMessage(h.pool, h.message, undefined, {
    telemetry: (r) => records.push(r),
  });
  expect(
    records.some((r) =>
      ["event_blocked", "retry_scheduled", "retry_exhausted"].includes(r.event),
    ),
  ).toBe(false);
});

it.each([
  [1, "transaction_finished", "durationMs"],
  [6, "transaction_finished", "durationMs"],
  [2, "transaction_finished", "lockWaitMs"],
  [3, "transaction_finished", "lockWaitMs"],
  [3, "transaction_finished", "lockHeldMs"],
  [7, "transaction_finished", "lockHeldMs"],
  [4, "lookup_finished", "durationMs"],
  [5, "lookup_finished", "durationMs"],
] as const)(
  "omits %s clock endpoint from %s.%s",
  async (badCall, event, property) => {
    const h = harness([row()]);
    let count = 0;
    const records: import("../src/worker-telemetry.js").TelemetryRecord[] = [];
    await processMessage(h.pool, h.message, undefined, {
      viacepExternalExecutionEnabled: true,
      viacepLookup: async () => found,
      now: () => (++count === badCall ? NaN : count),
      telemetry: (r) => records.push(r),
    });
    expect(records.find((r) => r.event === event)).not.toHaveProperty(property);
  },
);

it("does not report unsupported contract for a legacy condition evaluation failure", async () => {
  const base = graph();
  const g = {
    version: 2,
    nodes: base.nodes
      .filter((n) => n.kind !== "lookup")
      .map((n) =>
        n.kind === "condition"
          ? {
              ...n,
              type: "condition.v1",
              config: {
                fieldPath: "address",
                operator: "equals",
                expectedType: "string",
                expectedValue: "x",
              },
            }
          : n,
      ),
    edges: [
      { source: "trigger", target: "condition" },
      ...base.edges.filter(
        (e) => e.source === "condition" || e.source === "action",
      ),
    ],
  };
  const r = { ...row(), schema_version: 2, revision_version: 2, graph: g };
  const h = harness([r]);
  const records: import("../src/worker-telemetry.js").TelemetryRecord[] = [];
  await processMessage(h.pool, h.message, undefined, {
    telemetry: (r) => records.push(r),
  });
  expect(h.results()[0].failure).not.toBeNull();
  expect(
    records.some((r) => r.event === "unsupported_execution_contract"),
  ).toBe(false);
});
