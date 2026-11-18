import { createServer, type Server, type RequestListener } from "node:http";
import { describe, expect, it } from "vitest";
import type pg from "pg";
import { api } from "../src/api.js";
import {
  acquireSupervisorSingleton,
  workspaceIdentity,
} from "../src/runtime-supervisor-singleton.js";
import {
  fallbackSnapshot,
  initialSnapshot,
  publicStatus,
  readRuntimeSnapshot,
  validSnapshot,
  MAX_SNAPSHOT_AGE_MS,
  MAX_FUTURE_SKEW_MS,
} from "../src/runtime-status.js";

const capabilities = {
  automationSnapshots: true,
  conditionsWrites: false,
  viacepWrites: true,
  viacepExternalExecution: false,
} as const;
const root = process.cwd();
const ready = () => {
  const snapshot = initialSnapshot();
  snapshot.state = "ready";
  for (const component of Object.values(snapshot.components)) {
    component.state = "ready";
    component.reasonCode = null;
  }
  return snapshot;
};
async function serve(
  handler: RequestListener,
): Promise<{ server: Server; port: number }> {
  const server = createServer(handler);
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  return { server, port: (server.address() as { port: number }).port };
}
describe("runtime status", () => {
  it("enforces timestamp bounds and coherent state and reason contracts", () => {
    const now = Date.now();
    for (const [offset, valid] of [
      [-MAX_SNAPSHOT_AGE_MS + 1, true],
      [-MAX_SNAPSHOT_AGE_MS, false],
      [-MAX_SNAPSHOT_AGE_MS - 1, false],
      [MAX_FUTURE_SKEW_MS, true],
      [MAX_FUTURE_SKEW_MS + 1, false],
    ] as const) {
      const s = ready();
      s.observedAt = new Date(now + offset).toISOString();
      expect(validSnapshot(s, now)).toBe(valid);
    }
    const stopping = ready();
    stopping.state = "stopping";
    stopping.components.supervisor = {
      state: "stopping",
      reasonCode: "SUPERVISOR_STOPPING",
    };
    expect(validSnapshot(stopping, now)).toBe(true);
    stopping.components.supervisor.reasonCode = null;
    expect(validSnapshot(stopping, now)).toBe(false);
    const s = ready();
    s.components.worker = { state: "starting", reasonCode: "CHILD_RESTARTING" };
    expect(validSnapshot(s, now)).toBe(false);
    s.state = "degraded";
    expect(validSnapshot(s, now)).toBe(false);
    s.components.supervisor = {
      state: "degraded",
      reasonCode: "CHILD_RESTARTING",
    };
    expect(validSnapshot(s, now)).toBe(true);
    s.components.api.reasonCode = "READINESS_PENDING";
    expect(validSnapshot(s, now)).toBe(false);
  });
  it("rejects contradictory whole snapshots", () => {
    expect(validSnapshot(initialSnapshot())).toBe(true);
    expect(validSnapshot(fallbackSnapshot())).toBe(true);
    const s = ready();
    s.state = "degraded";
    s.components.supervisor = {
      state: "degraded",
      reasonCode: "CHILD_RESTARTING",
    };
    expect(validSnapshot(s)).toBe(false);
    s.components.worker = { state: "starting", reasonCode: "CHILD_RESTARTING" };
    expect(validSnapshot(s)).toBe(true);
    const fallback = fallbackSnapshot();
    fallback.components.worker = { state: "ready", reasonCode: null };
    expect(validSnapshot(fallback)).toBe(false);
  });
  it("rejects incompatible state and reason pairs", () => {
    for (const [name, state, reasonCode] of [
      ["database", "unknown", "SUPERVISOR_STOPPING"],
      ["worker", "starting", "CHILD_TERMINAL"],
      ["worker", "starting", "BOOTSTRAP_PENDING"],
      ["api", "unknown", "DEPENDENCY_UNVERIFIED"],
      ["supervisor", "degraded", "SUPERVISOR_STOPPING"],
      ["database", "starting", "BOOTSTRAP_PENDING"],
      ["api", "starting", "CHILD_STARTING"],
      ["database", "unavailable", "DEPENDENCY_UNAVAILABLE"],
      ["worker", "ready", "CHILD_STARTING"],
      ["worker", "starting", null],
    ] as const) {
      const s = initialSnapshot();
      const components = s.components as Record<
        string,
        { state: string; reasonCode: string | null }
      >;
      components[name] = { state, reasonCode };
      if (name === "supervisor") s.state = state as typeof s.state;
      expect(validSnapshot(s), `${name}/${state}/${reasonCode}`).toBe(false);
    }
  });
  it("uses returned API readiness for submission and fails closed when stale", () => {
    const s = ready();
    s.components.api = { state: "unknown", reasonCode: "READINESS_PENDING" };
    const status = publicStatus(s, capabilities);
    expect(status.components.api.state).toBe("ready");
    expect(status.canSubmit).toBe(false);
    s.observedAt = new Date(
      Date.now() - MAX_SNAPSHOT_AGE_MS - 1000,
    ).toISOString();
    expect(publicStatus(s, capabilities)).toMatchObject({
      state: "unknown",
      canSubmit: false,
    });
  });
  it("rejects stale and future responses from a responsive singleton", async () => {
    for (const offset of [
      -MAX_SNAPSHOT_AGE_MS - 1000,
      MAX_FUTURE_SKEW_MS + 1000,
    ]) {
      const snapshot = ready();
      snapshot.observedAt = new Date(Date.now() + offset).toISOString();
      const workspace = await workspaceIdentity(root);
      const { server, port } = await serve((_req, res) => {
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            product: "intelifluxo",
            protocol: 1,
            workspace,
            snapshot,
          }),
        );
      });
      try {
        const result = await readRuntimeSnapshot(port, root);
        expect(publicStatus(result, capabilities)).toMatchObject({
          state: "unknown",
          canSubmit: false,
        });
      } finally {
        await new Promise<void>((done) => server.close(() => done()));
      }
    }
  });
  it("produces the exact ready contract and respects flags", () => {
    const s = ready();
    expect(publicStatus(s, capabilities)).toEqual({
      version: 1,
      state: "ready",
      canSubmit: true,
      observedAt: s.observedAt,
      components: s.components,
      capabilities,
    });
    expect(
      publicStatus(s, { ...capabilities, automationSnapshots: false })
        .canSubmit,
    ).toBe(false);
    s.state = "degraded";
    expect(publicStatus(s, capabilities).canSubmit).toBe(false);
  });
  it("exposes a fixed read-only snapshot with matching workspace", async () => {
    const owner = await acquireSupervisorSingleton({
      workspaceRoot: root,
      testPort: 0,
      onOpen: () => {},
    });
    if (owner.kind !== "owned") throw new Error("no owner");
    try {
      owner.setSnapshot?.(ready());
      expect((await readRuntimeSnapshot(owner.port, root)).state).toBe("ready");
      const response = await fetch(
        `http://127.0.0.1:${owner.port}/runtime-snapshot`,
        { method: "POST" },
      );
      expect(response.status).toBe(405);
    } finally {
      await owner.close();
    }
  });
  it("falls back for absent, malformed, oversized and timed out supervisors", async () => {
    const absent = await serve((_req, res) => res.end());
    await new Promise<void>((done) => absent.server.close(() => done()));
    expect((await readRuntimeSnapshot(absent.port, root)).state).toBe(
      "unknown",
    );
    for (const body of [
      "not json",
      "x".repeat(9000),
      JSON.stringify({
        product: "intelifluxo",
        protocol: 1,
        workspace: await workspaceIdentity(root),
        snapshot: { ...ready(), secret: "secret" },
      }),
    ]) {
      const { server, port } = await serve((_req, res) => {
        res.setHeader("content-type", "application/json");
        res.end(body);
      });
      try {
        expect((await readRuntimeSnapshot(port, root)).state).toBe("unknown");
      } finally {
        server.close();
      }
    }
    const hung = await serve(() => {});
    try {
      expect((await readRuntimeSnapshot(hung.port, root)).state).toBe(
        "unknown",
      );
    } finally {
      hung.server.closeAllConnections();
      hung.server.close();
    }
  });
  it("rejects extra keys and reason codes", () => {
    expect(validSnapshot({ ...ready(), path: root })).toBe(false);
    const s = ready();
    s.components.worker.reasonCode = "secret";
    expect(validSnapshot(s)).toBe(false);
    expect(JSON.stringify(fallbackSnapshot())).not.toContain(root);
  });
  it("reports the trusted enabled external capability", async () => {
    const app = api({} as pg.Pool, false, true, true, true);
    try {
      const result = await app.inject({
        method: "GET",
        url: "/runtime/status",
      });
      expect(result.json().capabilities).toEqual({
        automationSnapshots: false,
        conditionsWrites: true,
        viacepWrites: true,
        viacepExternalExecution: true,
      });
    } finally {
      await app.close();
    }
  });
  it("serves API fallback without changing status or adding controls", async () => {
    const app = api({} as pg.Pool, false, true, false);
    try {
      const res = await app.inject({ method: "GET", url: "/runtime/status" });
      expect(res.statusCode).toBe(200);
      const status = res.json();
      expect(status.capabilities).toEqual({
        automationSnapshots: false,
        conditionsWrites: true,
        viacepWrites: false,
        viacepExternalExecution: false,
      });
      expect(status.canSubmit).toBe(false);
      expect(status.components.api).toEqual({
        state: "ready",
        reasonCode: null,
      });
      expect(
        (await app.inject({ method: "GET", url: "/runtime/status?extra=1" }))
          .statusCode,
      ).toBe(400);
      expect(
        (await app.inject({ method: "POST", url: "/runtime/status" }))
          .statusCode,
      ).toBe(404);
      expect(
        (await app.inject({ method: "GET", url: "/status" })).json().profile,
      ).toBe("local-development-only");
      expect(
        (await app.inject({ method: "GET", url: "/events/status" })).statusCode,
      ).toBe(400);
    } finally {
      await app.close();
    }
  });
});
