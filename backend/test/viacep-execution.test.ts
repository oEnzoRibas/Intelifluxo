import { describe, expect, it, vi } from "vitest";
import {
  prepareViaCepExecution,
  finalizeViaCepExecution,
  type ViaCepExecutionInput,
  type ViaCepEventAggregate,
} from "../src/viacep-execution.js";
import { parseExecutionResultV3 } from "../src/execution-result-v3.js";
import type { ViaCepResult } from "../src/viacep-transport.js";
const id = "11111111-1111-1111-1111-111111111111";
const receipt = {
  kind: "local-receipt.v1" as const,
  eventId: id,
  message: "ok",
};
const completed: ViaCepEventAggregate = {
  state: "completed",
  outcome: "success",
  peerOutcome: "success",
  actionOutcome: "success",
  receipt,
};
const scheduled: ViaCepEventAggregate = {
  state: "scheduled",
  outcome: "transient",
  peerOutcome: "transient",
  actionOutcome: "success",
  receipt: null,
};
function input(): ViaCepExecutionInput {
  return {
    executionId: id,
    eventId: id,
    eventContent: { address: { cep: "01001-000" } },
    schemaVersion: 3,
    revisionVersion: 3,
    triggerType: "receipt.v1",
    revisionTrigger: "receipt.v1",
    actionType: "record-receipt.v1",
    revisionAction: "record-receipt.v1",
    persistedResult: null,
    resultIsSqlNull: true,
    timeoutMs: 1200,
    graph: {
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
          config: { cep: { source: "event", fieldPath: "address.cep" } },
        },
        {
          id: "condition",
          kind: "condition",
          type: "condition.v2",
          position: { x: 0, y: 0 },
          config: {
            input: {
              source: "step",
              nodeId: "lookup",
              fieldPath: "address.uf",
            },
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
    },
  };
}
const found = (uf = "SP"): ViaCepResult => ({
  status: "found",
  address: { cep: "01001-000", uf },
});
function check(value: ReturnType<typeof finalizeViaCepExecution>) {
  expect(parseExecutionResultV3(value, id, false)).toEqual(value);
  return value;
}
describe("ViaCEP execution", () => {
  it("covers practical own, action and peer raw outcome combinations", async () => {
    const ranks = {
      success: 0,
      transient: 1,
      unknown: 2,
      permanent: 3,
    } as const;
    const outcomes = ["success", "transient", "unknown", "permanent"] as const;
    for (const [status, own] of [
      ["found", "success"],
      ["timeout", "transient"],
      ["unknown", "unknown"],
      ["not_found", "permanent"],
    ] as const) {
      const p = await prepareViaCepExecution(input(), async () =>
        status === "found" ? found() : { status },
      );
      for (const actionOutcome of outcomes)
        for (const peerOutcome of outcomes) {
          const outcome = outcomes.find(
            (v) =>
              ranks[v] ===
              Math.max(ranks[own], ranks[actionOutcome], ranks[peerOutcome]),
          )!;
          const aggregate: ViaCepEventAggregate =
            outcome === "success"
              ? completed
              : outcome === "transient"
                ? {
                    state: "scheduled",
                    outcome,
                    actionOutcome,
                    peerOutcome,
                    receipt: null,
                  }
                : {
                    state: "blocked",
                    reason: outcome,
                    outcome,
                    actionOutcome,
                    peerOutcome,
                    receipt: null,
                  };
          const r = check(finalizeViaCepExecution(p, aggregate));
          if (own !== "success") {
            const code =
              own === "transient"
                ? "viacep_timeout"
                : own === "unknown"
                  ? "viacep_unknown"
                  : "viacep_not_found";
            expect(r.lookup?.failure?.code).toBe(code);
            expect(r.failure?.code).toBe(
              own === outcome ? code : "event_peer_failure",
            );
          } else if (outcome !== "success") {
            expect(r.failure?.code).toBe(
              actionOutcome === outcome
                ? `action_${outcome}`
                : "event_peer_failure",
            );
          }
          if (outcome === "transient") {
            const exhausted = check(
              finalizeViaCepExecution(p, {
                state: "blocked",
                reason: "exhausted",
                outcome,
                actionOutcome,
                peerOutcome,
                receipt: null,
              }),
            );
            if (own === "transient")
              expect(exhausted.lookup?.failure?.code).toBe("retry_exhausted");
            expect(exhausted.failure?.classification).toBe("exhausted");
          }
        }
    }
  });
  it("retains unknown lookup under permanent action and peer aggregation", async () => {
    const p = await prepareViaCepExecution(input(), async () => ({
      status: "unknown",
    }));
    const r = check(
      finalizeViaCepExecution(p, {
        state: "blocked",
        reason: "permanent",
        outcome: "permanent",
        actionOutcome: "permanent",
        peerOutcome: "permanent",
        receipt: null,
      }),
    );
    expect(r.lookup?.failure).toEqual({
      classification: "unknown",
      code: "viacep_unknown",
      nodeId: "lookup",
    });
    expect(r.failure).toEqual({
      classification: "permanent",
      code: "event_peer_failure",
      nodeId: null,
    });
  });
  it("compares terminal receipt fields independently of property order", async () => {
    const p = await prepareViaCepExecution(input(), async () => found());
    const x = input();
    x.persistedResult = check(finalizeViaCepExecution(p, completed));
    x.resultIsSqlNull = false;
    const next = await prepareViaCepExecution(x, async () => found());
    expect(
      check(
        finalizeViaCepExecution(next, {
          ...completed,
          receipt: { message: "ok", eventId: id, kind: "local-receipt.v1" },
        }),
      ),
    ).toEqual(x.persistedResult);
    expect(() =>
      finalizeViaCepExecution(next, {
        ...completed,
        receipt: { ...receipt, message: "different" },
      }),
    ).toThrow("execution invariant");
    const extraReceipt = { ...receipt, extra: true };
    expect(() =>
      finalizeViaCepExecution(next, {
        ...completed,
        receipt: extraReceipt,
      }),
    ).toThrow("execution invariant");
  });
  it("rejects prior condition wrong node, wrong code and recomputation mismatch", async () => {
    const x = input();
    const config = (
      x.graph as {
        nodes: {
          config?: { expectedType?: string; expectedValue?: unknown };
        }[];
      }
    ).nodes[2].config!;
    config.expectedType = "number";
    config.expectedValue = 1;
    const p = await prepareViaCepExecution(x, async () => found());
    const prior = check(
      finalizeViaCepExecution(p, {
        state: "blocked",
        reason: "permanent",
        outcome: "permanent",
        actionOutcome: "success",
        peerOutcome: "success",
        receipt: null,
      }),
    );
    for (const failure of [
      {
        classification: "permanent",
        code: "condition_type_mismatch",
        nodeId: "other",
      },
      {
        classification: "permanent",
        code: "invalid_condition_value",
        nodeId: "condition",
      },
    ]) {
      const next = {
        ...x,
        persistedResult: { ...prior, failure },
        resultIsSqlNull: false,
      };
      const call = vi.fn(async () => found());
      await expect(prepareViaCepExecution(next, call)).rejects.toThrow(
        "execution invariant",
      );
      expect(call).not.toHaveBeenCalled();
    }
    const changed = input();
    changed.persistedResult = prior;
    changed.resultIsSqlNull = false;
    await expect(
      prepareViaCepExecution(changed, async () => found()),
    ).rejects.toThrow("execution invariant");
  });
  it("preserves a transient diagnostic on peer exhaustion", async () => {
    const p = await prepareViaCepExecution(input(), async () => ({
      status: "timeout",
    }));
    const result = check(
      finalizeViaCepExecution(p, {
        state: "blocked",
        reason: "exhausted",
        outcome: "transient",
        peerOutcome: "transient",
        actionOutcome: "success",
        receipt: null,
      }),
    );
    expect(result.failure?.code).toBe("retry_exhausted");
    expect(result.lookup?.failure?.code).toBe("retry_exhausted");
  });
  it("does not retry a terminal not-found observation", async () => {
    const p = await prepareViaCepExecution(input(), async () => ({
      status: "not_found",
    }));
    const x = input();
    x.persistedResult = finalizeViaCepExecution(p, {
      state: "blocked",
      reason: "permanent",
      outcome: "permanent",
      peerOutcome: "permanent",
      actionOutcome: "success",
      receipt: null,
    });
    x.resultIsSqlNull = false;
    const call = vi.fn(async () => found());
    const next = await prepareViaCepExecution(x, call);
    expect(call).not.toHaveBeenCalled();
    expect(
      check(
        finalizeViaCepExecution(next, {
          state: "blocked",
          reason: "permanent",
          outcome: "permanent",
          peerOutcome: "permanent",
          actionOutcome: "success",
          receipt: null,
        }),
      ).failure?.code,
    ).toBe("viacep_not_found");
  });
  it("does not execute event CEP accessors", async () => {
    const getter = vi.fn(() => {
      throw new Error("secret");
    });
    const x = input();
    x.eventContent = {
      address: Object.defineProperty({}, "cep", {
        enumerable: true,
        get: getter,
      }),
    };
    const call = vi.fn(async () => found());
    const p = await prepareViaCepExecution(x, call);
    expect(getter).not.toHaveBeenCalled();
    expect(call).not.toHaveBeenCalled();
    expect(
      check(
        finalizeViaCepExecution(p, {
          state: "blocked",
          reason: "permanent",
          outcome: "permanent",
          peerOutcome: "permanent",
          actionOutcome: "success",
          receipt: null,
        }),
      ).failure?.code,
    ).toBe("invalid_cep");
  });
  it.each(["event", "fixed"])(
    "resolves %s CEP once and forwards timeout",
    async (source) => {
      const x = input();
      if (source === "fixed")
        (
          x.graph as {
            nodes: {
              id: string;
              config: {
                cep: unknown;
                input: { nodeId: string };
                expectedType: string;
                expectedValue: number;
              };
            }[];
            edges: { source: string; target: string }[];
          }
        ).nodes[1].config.cep = {
          source: "fixed",
          value: "01001-000",
        };
      const call = vi.fn(async () => found());
      const p = await prepareViaCepExecution(x, call);
      expect(call).toHaveBeenCalledExactlyOnceWith("01001000", {
        timeoutMs: 1200,
      });
      expect(check(finalizeViaCepExecution(p, completed)).action.status).toBe(
        "executed",
      );
    },
  );
  it("FALSE is ignored even on peer failure", async () => {
    const p = await prepareViaCepExecution(input(), async () => found("RJ"));
    expect(
      check(
        finalizeViaCepExecution(p, {
          state: "blocked",
          reason: "permanent",
          outcome: "permanent",
          peerOutcome: "permanent",
          actionOutcome: "permanent",
          receipt: null,
        }),
      ).action.status,
    ).toBe("ignored");
  });
  it.each([
    undefined,
    null,
    42,
    "01001-000\n",
    Object.create({ cep: "01001000" }),
  ])("invalid event CEP %s never calls provider", async (value) => {
    const x = input();
    x.eventContent = {
      address:
        typeof value === "object" && value !== null ? value : { cep: value },
    };
    const call = vi.fn(async () => found());
    const p = await prepareViaCepExecution(x, call);
    expect(call).not.toHaveBeenCalled();
    const r = check(
      finalizeViaCepExecution(p, {
        state: "blocked",
        reason: "permanent",
        outcome: "permanent",
        peerOutcome: "permanent",
        actionOutcome: "success",
        receipt: null,
      }),
    );
    expect(r.failure?.code).toBe("invalid_cep");
  });
  it.each([
    ["not_found", "viacep_not_found", "permanent"],
    ["timeout", "viacep_timeout", "transient"],
    ["transport", "viacep_transport", "transient"],
    ["http_transient", "viacep_http_transient", "transient"],
    ["http_permanent", "viacep_http_permanent", "permanent"],
    ["invalid_response", "viacep_invalid_response", "permanent"],
    ["security_rejected", "viacep_security_rejected", "permanent"],
    ["unknown", "viacep_unknown", "unknown"],
  ] as const)("maps %s", async (status, code, classification) => {
    const p = await prepareViaCepExecution(input(), async () => ({ status }));
    const aggregate: ViaCepEventAggregate =
      classification === "transient"
        ? scheduled
        : {
            state: "blocked",
            reason: classification,
            outcome: classification,
            peerOutcome: classification,
            actionOutcome: "success",
            receipt: null,
          };
    const r = check(finalizeViaCepExecution(p, aggregate));
    expect(r.failure).toMatchObject({ code, classification, nodeId: "lookup" });
  });
  it("retains and detaches found observation across attempts", async () => {
    const first = await prepareViaCepExecution(input(), async () => found());
    const prior = check(finalizeViaCepExecution(first, scheduled));
    const x = input();
    x.persistedResult = prior;
    x.resultIsSqlNull = false;
    const call = vi.fn(async () => found("RJ"));
    const p = await prepareViaCepExecution(x, call);
    expect(call).not.toHaveBeenCalled();
    const next = check(finalizeViaCepExecution(p, completed));
    expect(next.lookup).toEqual(prior.lookup);
    expect(next.lookup).not.toBe(prior.lookup);
  });
  it.each([
    [null, false],
    [{}, false],
    [{}, true],
  ] as const)("rejects corrupt SQL/JSON evidence", async (value, sql) => {
    const x = input();
    x.persistedResult = value;
    x.resultIsSqlNull = sql;
    const call = vi.fn(async () => found());
    await expect(prepareViaCepExecution(x, call)).rejects.toThrow(
      /^execution invariant$/,
    );
    expect(call).not.toHaveBeenCalled();
  });
  it("rejects mismatched pinned CEP and node before lookup", async () => {
    const first = await prepareViaCepExecution(input(), async () => found());
    const prior = finalizeViaCepExecution(first, completed);
    for (const mode of ["cep", "node"]) {
      const x = input();
      x.persistedResult = prior;
      x.resultIsSqlNull = false;
      if (mode === "cep") x.eventContent = { address: { cep: "20000000" } };
      else {
        (
          x.graph as {
            nodes: {
              id: string;
              config: {
                cep: unknown;
                input: { nodeId: string };
                expectedType: string;
                expectedValue: number;
              };
            }[];
            edges: { source: string; target: string }[];
          }
        ).nodes[1].id = "other";
        (
          x.graph as {
            nodes: {
              id: string;
              config: {
                cep: unknown;
                input: { nodeId: string };
                expectedType: string;
                expectedValue: number;
              };
            }[];
            edges: { source: string; target: string }[];
          }
        ).edges[0].target = "other";
        (
          x.graph as {
            nodes: {
              id: string;
              config: {
                cep: unknown;
                input: { nodeId: string };
                expectedType: string;
                expectedValue: number;
              };
            }[];
            edges: { source: string; target: string }[];
          }
        ).edges[1].source = "other";
        (
          x.graph as {
            nodes: {
              id: string;
              config: {
                cep: unknown;
                input: { nodeId: string };
                expectedType: string;
                expectedValue: number;
              };
            }[];
            edges: { source: string; target: string }[];
          }
        ).nodes[2].config.input.nodeId = "other";
      }
      const call = vi.fn(async () => found());
      await expect(prepareViaCepExecution(x, call)).rejects.toThrow(
        "execution invariant",
      );
      expect(call).not.toHaveBeenCalled();
    }
  });
  it("returns strict unsupported envelope", async () => {
    const x = input();
    x.revisionVersion = 2;
    const call = vi.fn(async () => found());
    const p = await prepareViaCepExecution(x, call);
    expect(call).not.toHaveBeenCalled();
    const fixed = check(finalizeViaCepExecution(p, scheduled));
    expect(fixed).toMatchObject({
      lookup: null,
      decision: null,
      action: { nodeId: null, status: "not_executed" },
      failure: { code: "unsupported_execution_contract" },
    });
    expect(check(finalizeViaCepExecution(p, completed))).toEqual(fixed);
    expect(
      check(
        finalizeViaCepExecution(p, {
          state: "blocked",
          reason: "permanent",
          outcome: "permanent",
          actionOutcome: "permanent",
          peerOutcome: "success",
          receipt: null,
        }),
      ),
    ).toEqual(fixed);
  });
  it.each([
    [
      {
        state: "scheduled",
        outcome: "transient",
        peerOutcome: "transient",
        actionOutcome: "transient",
        receipt: null,
      },
      "action_transient",
      "pending",
    ],
    [
      {
        state: "scheduled",
        outcome: "transient",
        peerOutcome: "transient",
        actionOutcome: "success",
        receipt: null,
      },
      "event_peer_failure",
      "pending",
    ],
    [
      {
        state: "blocked",
        reason: "permanent",
        outcome: "permanent",
        peerOutcome: "permanent",
        actionOutcome: "permanent",
        receipt: null,
      },
      "action_permanent",
      "not_executed",
    ],
    [
      {
        state: "blocked",
        reason: "unknown",
        outcome: "unknown",
        peerOutcome: "unknown",
        actionOutcome: "success",
        receipt: null,
      },
      "event_peer_failure",
      "not_executed",
    ],
    [
      {
        state: "blocked",
        reason: "exhausted",
        outcome: "transient",
        peerOutcome: "transient",
        actionOutcome: "transient",
        receipt: null,
      },
      "retry_exhausted",
      "not_executed",
    ],
  ] as [ViaCepEventAggregate, string, string][])(
    "finalizes downstream action or peer",
    async (aggregate, code, status) => {
      const p = await prepareViaCepExecution(input(), async () => found());
      const r = check(finalizeViaCepExecution(p, aggregate));
      expect(r.action.status).toBe(status);
      expect(r.failure?.code).toBe(code);
    },
  );
  it.each([
    ["exhausted", "retry_exhausted"],
    ["permanent", "event_peer_failure"],
  ] as const)("finalizes transient lookup on %s", async (reason, code) => {
    const p = await prepareViaCepExecution(input(), async () => ({
      status: "timeout",
    }));
    const r = check(
      finalizeViaCepExecution(p, {
        state: "blocked",
        reason,
        outcome: reason === "exhausted" ? "transient" : reason,
        peerOutcome: reason === "exhausted" ? "transient" : reason,
        actionOutcome: "success",
        receipt: null,
      }),
    );
    expect(r.failure?.code).toBe(code);
    expect(r.lookup?.failure?.code).toBe(
      reason === "exhausted" ? "retry_exhausted" : "viacep_timeout",
    );
  });
  it("propagates condition type failure", async () => {
    const x = input();
    (
      x.graph as {
        nodes: {
          id: string;
          config: {
            cep: unknown;
            input: { nodeId: string };
            expectedType: string;
            expectedValue: number;
          };
        }[];
        edges: { source: string; target: string }[];
      }
    ).nodes[2].config.expectedType = "number";
    (
      x.graph as {
        nodes: {
          id: string;
          config: {
            cep: unknown;
            input: { nodeId: string };
            expectedType: string;
            expectedValue: number;
          };
        }[];
        edges: { source: string; target: string }[];
      }
    ).nodes[2].config.expectedValue = 1;
    const p = await prepareViaCepExecution(x, async () => found());
    expect(
      check(
        finalizeViaCepExecution(p, {
          state: "blocked",
          reason: "permanent",
          outcome: "permanent",
          peerOutcome: "permanent",
          actionOutcome: "success",
          receipt: null,
        }),
      ).failure,
    ).toMatchObject({ code: "condition_type_mismatch", nodeId: "condition" });
  });
  it.each(["extra", "hole", "accessor", "symbol"])(
    "rejects unsafe graph array %s before lookup",
    async (mode) => {
      const x = input();
      const nodes = (x.graph as { nodes: unknown[] }).nodes;
      const getter = vi.fn(() => ({}));
      if (mode === "extra")
        Object.defineProperty(nodes, "4294967295", {
          value: 1,
          enumerable: true,
        });
      if (mode === "hole") delete nodes[1];
      if (mode === "accessor")
        Object.defineProperty(nodes, "1", { get: getter, enumerable: true });
      if (mode === "symbol")
        Object.defineProperty(nodes, Symbol(), { value: 1, enumerable: true });
      const call = vi.fn(async () => found());
      await expect(prepareViaCepExecution(x, call)).rejects.toThrow(
        "execution invariant",
      );
      expect(call).not.toHaveBeenCalled();
      expect(getter).not.toHaveBeenCalled();
    },
  );
  it.each(["accessor", "extra"])(
    "rejects malformed provider address %s without leaking or invoking getter",
    async (mode) => {
      const getter = vi.fn(() => "secret");
      const address = { cep: "01001-000" };
      if (mode === "accessor")
        Object.defineProperty(address, "uf", { get: getter, enumerable: true });
      else Object.assign(address, { secret: "sensitive" });
      await expect(
        prepareViaCepExecution(input(), async () => ({
          status: "found",
          address,
        })),
      ).rejects.toThrow(/^execution invariant$/);
      expect(getter).not.toHaveBeenCalled();
    },
  );
  it("rejects aggregate contradictions including ignored branch", async () => {
    for (const uf of ["SP", "RJ"]) {
      const p = await prepareViaCepExecution(input(), async () => found(uf));
      for (const aggregate of [
        {
          state: "scheduled",
          outcome: "transient",
          actionOutcome: "permanent",
          peerOutcome: "transient",
          receipt: null,
        },
        {
          state: "scheduled",
          outcome: "transient",
          actionOutcome: "success",
          peerOutcome: "success",
          receipt: null,
        },
        {
          state: "blocked",
          reason: "unknown",
          outcome: "unknown",
          actionOutcome: "permanent",
          peerOutcome: "unknown",
          receipt: null,
        },
        {
          state: "blocked",
          reason: "exhausted",
          outcome: "transient",
          actionOutcome: "unknown",
          peerOutcome: "transient",
          receipt: null,
        },
      ])
        expect(() =>
          finalizeViaCepExecution(p, aggregate as ViaCepEventAggregate),
        ).toThrow("execution invariant");
    }
  });
  it("rejects prior decision inconsistent with recomputation", async () => {
    const x = input();
    const p = await prepareViaCepExecution(x, async () => found());
    x.persistedResult = finalizeViaCepExecution(p, completed);
    x.resultIsSqlNull = false;
    const graph = x.graph as {
      nodes: { config?: { expectedValue?: string } }[];
    };
    graph.nodes[2].config!.expectedValue = "RJ";
    const call = vi.fn(async () => found());
    await expect(prepareViaCepExecution(x, call)).rejects.toThrow(
      "execution invariant",
    );
    expect(call).not.toHaveBeenCalled();
  });
  it("reuses terminal ignored and executed results without mutation", async () => {
    for (const uf of ["SP", "RJ"]) {
      const p = await prepareViaCepExecution(input(), async () => found(uf));
      const prior = check(finalizeViaCepExecution(p, completed));
      const x = input();
      x.persistedResult = prior;
      x.resultIsSqlNull = false;
      const call = vi.fn(async () => found());
      const next = await prepareViaCepExecution(x, call);
      expect(call).not.toHaveBeenCalled();
      expect(check(finalizeViaCepExecution(next, completed))).toEqual(prior);
      if (uf === "RJ")
        expect(check(finalizeViaCepExecution(next, scheduled))).toEqual(prior);
      else
        expect(() => finalizeViaCepExecution(next, scheduled)).toThrow(
          "execution invariant",
        );
    }
  });
});
