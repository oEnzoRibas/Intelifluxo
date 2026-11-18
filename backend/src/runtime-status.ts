import { request } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CONTROL_HOST,
  CONTROL_PORT,
  workspaceIdentity,
} from "./runtime-supervisor-singleton.js";

export const SNAPSHOT_PATH = "/runtime-snapshot";
export const MAX_SNAPSHOT_AGE_MS = 15_000;
export const MAX_FUTURE_SKEW_MS = 5_000;
const names = [
  "supervisor",
  "database",
  "rabbitmq",
  "api",
  "frontend",
  "worker",
  "relay",
  "scheduler",
] as const;
type Name = (typeof names)[number];
type State =
  "starting" | "ready" | "degraded" | "stopping" | "unknown" | "unavailable";
type Component = { state: State; reasonCode: string | null };
export type Snapshot = {
  version: 1;
  state: State;
  observedAt: string;
  components: Record<Name, Component>;
};
export type Capabilities = {
  automationSnapshots: boolean;
  conditionsWrites: boolean;
  viacepWrites: boolean;
  viacepExternalExecution: boolean;
};
// Only combinations emitted by the supervisor or its conservative fallback.
const dependencyStates = {
  ready: [null],
  unknown: [
    "BOOTSTRAP_PENDING",
    "DEPENDENCY_UNVERIFIED",
    "SUPERVISOR_UNAVAILABLE",
  ],
};
const endpointStates = {
  ready: [null],
  unknown: ["READINESS_PENDING", "CHILD_RESTARTING", "SUPERVISOR_UNAVAILABLE"],
  unavailable: ["CHILD_TERMINAL"],
};
const childStates = {
  ready: [null],
  starting: ["CHILD_STARTING", "CHILD_RESTARTING"],
  unavailable: ["CHILD_TERMINAL"],
  unknown: ["SUPERVISOR_UNAVAILABLE"],
};
const compatibility: Record<Name, Partial<Record<State, (string | null)[]>>> = {
  supervisor: {
    starting: ["BOOTSTRAP_PENDING"],
    ready: [null],
    degraded: [
      "BOOTSTRAP_PENDING",
      "LISTENER_ERROR",
      "CHILD_RESTARTING",
      "CHILD_TERMINAL",
      "READINESS_PENDING",
    ],
    stopping: ["SUPERVISOR_STOPPING"],
    unknown: ["SUPERVISOR_UNAVAILABLE"],
  },
  database: dependencyStates,
  rabbitmq: dependencyStates,
  api: endpointStates,
  frontend: endpointStates,
  worker: childStates,
  relay: childStates,
  scheduler: childStates,
};
const component = (state: State, reasonCode: string | null): Component => ({
  state,
  reasonCode,
});
export function initialSnapshot(): Snapshot {
  return {
    version: 1,
    state: "starting",
    observedAt: new Date().toISOString(),
    components: {
      supervisor: component("starting", "BOOTSTRAP_PENDING"),
      database: component("unknown", "BOOTSTRAP_PENDING"),
      rabbitmq: component("unknown", "BOOTSTRAP_PENDING"),
      api: component("unknown", "READINESS_PENDING"),
      frontend: component("unknown", "READINESS_PENDING"),
      worker: component("starting", "CHILD_STARTING"),
      relay: component("starting", "CHILD_STARTING"),
      scheduler: component("starting", "CHILD_STARTING"),
    },
  };
}
export function fallbackSnapshot(): Snapshot {
  const components = Object.fromEntries(
    names.map((n) => [
      n,
      component(
        n === "api" ? "ready" : "unknown",
        n === "api" ? null : "SUPERVISOR_UNAVAILABLE",
      ),
    ]),
  ) as Record<Name, Component>;
  return {
    version: 1,
    state: "unknown",
    observedAt: new Date().toISOString(),
    components,
  };
}
function exact(
  value: unknown,
  keys: string[],
): value is Record<string, unknown> {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join(",") === [...keys].sort().join(",")
  );
}
function freshTimestamp(timestamp: string, now: number): boolean {
  const time = Date.parse(timestamp);
  return (
    Number.isFinite(now) &&
    Number.isFinite(time) &&
    time > now - MAX_SNAPSHOT_AGE_MS &&
    time <= now + MAX_FUTURE_SKEW_MS
  );
}
export function validSnapshot(
  value: unknown,
  now = Date.now(),
): value is Snapshot {
  if (
    !exact(value, ["version", "state", "observedAt", "components"]) ||
    value.version !== 1 ||
    typeof value.state !== "string" ||
    !Object.hasOwn(compatibility.supervisor, value.state) ||
    typeof value.observedAt !== "string" ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value.observedAt) ||
    !freshTimestamp(value.observedAt, now) ||
    !exact(value.components, [...names])
  )
    return false;
  return (
    names.every((name) => {
      const c = (value.components as Record<string, unknown>)[name];
      return (
        exact(c, ["state", "reasonCode"]) &&
        typeof c.state === "string" &&
        Object.hasOwn(compatibility[name], c.state) &&
        compatibility[name][c.state as State]!.some(
          (reason) => reason === c.reasonCode,
        )
      );
    }) &&
    (value.components as Record<string, Component>).supervisor.state ===
      value.state &&
    (value.state !== "ready" ||
      names.every(
        (name) =>
          (value.components as Record<string, Component>)[name].state ===
          "ready",
      )) &&
    (value.state !== "unknown" ||
      names.every((name) => {
        const c = (value.components as Record<string, Component>)[name];
        return name === "api"
          ? c.state === "ready" && c.reasonCode === null
          : c.state === "unknown" && c.reasonCode === "SUPERVISOR_UNAVAILABLE";
      })) &&
    (value.state !== "starting" ||
      names.every((name) => {
        const c = (value.components as Record<string, Component>)[name];
        const initial = initialSnapshot().components[name];
        return c.state === initial.state && c.reasonCode === initial.reasonCode;
      })) &&
    (value.state !== "degraded" ||
      (value.components as Record<string, Component>).supervisor.reasonCode !==
        "READINESS_PENDING" ||
      names
        .slice(1)
        .some(
          (name) =>
            (value.components as Record<string, Component>)[name].state !==
            "ready",
        )) &&
    (value.state !== "degraded" ||
      (value.components as Record<string, Component>).supervisor.reasonCode !==
        "CHILD_RESTARTING" ||
      names
        .slice(1)
        .some(
          (name) =>
            (value.components as Record<string, Component>)[name].reasonCode ===
            "CHILD_RESTARTING",
        )) &&
    (value.state !== "degraded" ||
      (value.components as Record<string, Component>).supervisor.reasonCode !==
        "CHILD_TERMINAL" ||
      names
        .slice(1)
        .some(
          (name) =>
            (value.components as Record<string, Component>)[name].reasonCode ===
            "CHILD_TERMINAL",
        ))
  );
}
export function publicStatus(snapshot: Snapshot, capabilities: Capabilities) {
  if (!validSnapshot(snapshot)) snapshot = fallbackSnapshot();
  const components = { ...snapshot.components, api: component("ready", null) };
  const canSubmit =
    snapshot.state === "ready" &&
    capabilities.automationSnapshots &&
    names.every((n) => components[n].state === "ready");
  return {
    version: 1 as const,
    state: snapshot.state,
    canSubmit,
    observedAt: snapshot.observedAt,
    components,
    capabilities,
  };
}
/** Loopback is unauthenticated: validation limits disclosure, not local spoofing. */
export async function readRuntimeSnapshot(
  testPort?: number,
  testRoot?: string,
): Promise<Snapshot> {
  let workspace: string;
  try {
    workspace = await workspaceIdentity(
      testRoot ?? resolve(dirname(fileURLToPath(import.meta.url)), "../.."),
    );
  } catch {
    return fallbackSnapshot();
  }
  const port = testPort ?? CONTROL_PORT;
  return new Promise((done) => {
    let finished = false;
    let size = 0;
    const chunks: Buffer[] = [];
    const finish = (value: Snapshot) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      req.destroy();
      done(value);
    };
    const req = request(
      {
        host: CONTROL_HOST,
        port,
        path: SNAPSHOT_PATH,
        method: "GET",
        maxHeaderSize: 4096,
        headers: { host: `${CONTROL_HOST}:${port}`, connection: "close" },
      },
      (res) => {
        if (
          res.statusCode !== 200 ||
          res.headers["content-type"] !== "application/json"
        )
          return finish(fallbackSnapshot());
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > 8192) finish(fallbackSnapshot());
          else chunks.push(chunk);
        });
        res.on("error", () => finish(fallbackSnapshot()));
        res.on("aborted", () => finish(fallbackSnapshot()));
        res.on("end", () => {
          try {
            const v: unknown = JSON.parse(
              Buffer.concat(chunks).toString("utf8"),
            );
            if (
              exact(v, ["product", "protocol", "workspace", "snapshot"]) &&
              v.product === "intelifluxo" &&
              v.protocol === 1 &&
              v.workspace === workspace &&
              validSnapshot(v.snapshot)
            )
              return finish(v.snapshot);
          } catch {
            /* invalid response */
          }
          finish(fallbackSnapshot());
        });
      },
    );
    const timer = setTimeout(() => finish(fallbackSnapshot()), 1000);
    req.on("error", () => finish(fallbackSnapshot()));
    req.end();
  });
}
