import { EventEmitter } from "node:events";
import { createServer, request } from "node:http";
import { acquireSupervisorSingleton } from "../src/runtime-supervisor-singleton.js";
import { describe, expect, it, vi } from "vitest";
import {
  childEnvironment,
  parseSupervisorArgs,
  probeEndpoint,
  runSupervisor,
} from "../src/runtime-supervisor.js";
import type { ChildManagerOptions } from "../src/runtime-children.js";
import {
  MAX_SNAPSHOT_AGE_MS,
  publicStatus,
  readRuntimeSnapshot,
  validSnapshot,
  type Snapshot,
} from "../src/runtime-status.js";

function setup() {
  const trace: string[] = [];
  const signals = new EventEmitter();
  let event!: NonNullable<ChildManagerOptions["onEvent"]>;
  const acquire = vi.fn(async () => ({
    kind: "owned" as const,
    port: 3210,
    setState: (state: string) => trace.push(state),
    close: async () => {
      trace.push("close");
    },
  }));
  const bootstrap = vi.fn(async () => {
    trace.push("bootstrap");
    return {
      phase: "complete" as const,
      outcome: "ready" as const,
      reasonCode: "ready" as const,
      attempts: 1,
    };
  });
  const children = vi.fn((options: ChildManagerOptions) => {
    event = options.onEvent!;
    return {
      start: async () => {
        trace.push("start");
        for (const role of [
          "api",
          "worker",
          "relay",
          "scheduler",
          "frontend",
        ] as const)
          event({ role, state: "started", reason: "spawned" });
      },
      stop: async () => {
        trace.push("stop");
        return { forced: [], remaining: [] };
      },
    };
  });
  const probe = vi.fn(async () => true);
  const preflight = vi.fn(async () => ({
    version: 1 as const,
    state: "ready" as const,
    dependencies: {
      postgres: { state: "ready" as const, reasonCode: null },
      rabbitmq: { state: "ready" as const, reasonCode: null },
    },
    observedAt: new Date().toISOString(),
  }));
  const open = vi.fn(async () => {
    trace.push("open");
    signals.emit("SIGINT");
  });
  const hardExit = vi.fn();
  const dependencies = {
    acquire,
    bootstrap,
    children,
    probe,
    preflight,
    open,
    hardExit,
    signals: signals as never,
    event: (code: string) => trace.push(code),
  };
  return { trace, signals, dependencies, getEvent: () => event };
}
describe("local supervisor", () => {
  it("publishes a coherent degraded snapshot when aggregate preflight fails despite ready dependencies", async () => {
    vi.useFakeTimers();
    try {
      const s = setup();
      const snapshots: Snapshot[] = [];
      const run = runSupervisor({
        args: ["--no-open"],
        env: {},
        stabilityMs: 0,
        dependencies: {
          ...s.dependencies,
          preflight: async () => ({
            ...(await s.dependencies.preflight()),
            state: "unavailable" as const,
          }),
          acquire: async () => ({
            kind: "owned",
            port: 0,
            setState: () => {},
            close: async () => {},
            setSnapshot: (v) => {
              expect(validSnapshot(v)).toBe(true);
              snapshots.push(structuredClone(v));
            },
          }),
        },
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(snapshots.at(-1)).toMatchObject({
        state: "degraded",
        components: {
          api: { state: "unknown", reasonCode: "READINESS_PENDING" },
        },
      });
      s.signals.emit("SIGINT");
      expect(await run).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
  it("fails closed at lease expiry with the timer pending and publishes expired success conservatively through the singleton", async () => {
    const s = setup();
    const start = Date.now();
    let now = start;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    const waits: { ms: number; signal: AbortSignal; resolve: () => void }[] =
      [];
    let releaseProbe!: (value: boolean) => void;
    let block = false;
    let port = 0;
    let workspace = "";
    const open = vi.fn(async () => {});
    const waitFor = async (predicate: () => boolean) => {
      for (let i = 0; i < 100 && !predicate(); i++)
        await new Promise<void>((resolve) => setImmediate(resolve));
      expect(predicate()).toBe(true);
    };
    const run = runSupervisor({
      args: ["--no-open"],
      env: {},
      stabilityMs: 0,
      dependencies: {
        ...s.dependencies,
        open,
        now: () => now,
        acquire: async (options) => {
          workspace = options.workspaceRoot;
          const owner = await acquireSupervisorSingleton({
            ...options,
            testPort: 0,
          });
          if (owner.kind === "owned") port = owner.port;
          return owner;
        },
        wait: (ms, signal) =>
          new Promise<void>((resolve) => {
            waits.push({ ms, signal, resolve });
            signal.addEventListener("abort", () => resolve(), { once: true });
            if (signal.aborted) resolve();
          }),
        probe: async (endpoint) =>
          block && endpoint === "api"
            ? new Promise<boolean>((resolve) => {
                releaseProbe = resolve;
              })
            : true,
      },
    });
    const capabilities = {
      automationSnapshots: true,
      conditionsWrites: false,
      viacepWrites: false,
      viacepExternalExecution: false,
    } as const;
    try {
      await waitFor(() => port > 0 && waits.some((w) => w.ms === 5000));
      const first = await readRuntimeSnapshot(port, workspace);
      expect(first.state).toBe("ready");
      block = true;
      now = start + 5000;
      waits.find((w) => w.ms === 5000)!.resolve();
      await waitFor(() => typeof releaseProbe === "function");
      now = start + MAX_SNAPSHOT_AGE_MS - 1;
      expect(
        publicStatus(await readRuntimeSnapshot(port, workspace), capabilities)
          .canSubmit,
      ).toBe(true);
      expect(
        (await fetch(`http://127.0.0.1:${port}/open`, { method: "POST" }))
          .status,
      ).toBe(200);
      now++;
      expect(
        waits.some((w) => w.ms === MAX_SNAPSHOT_AGE_MS && !w.signal.aborted),
      ).toBe(true);
      expect(
        publicStatus(await readRuntimeSnapshot(port, workspace), capabilities),
      ).toMatchObject({ state: "unknown", canSubmit: false });
      expect(
        (await fetch(`http://127.0.0.1:${port}/open`, { method: "POST" }))
          .status,
      ).toBe(500);
      expect(open).toHaveBeenCalledTimes(1);
      now = start + 5000 + MAX_SNAPSHOT_AGE_MS;
      releaseProbe(true);
      await waitFor(() => waits.filter((w) => w.ms === 5000).length >= 2);
      const expired = await readRuntimeSnapshot(port, workspace);
      expect(validSnapshot(expired)).toBe(true);
      expect(expired).toMatchObject({
        state: "degraded",
        components: {
          supervisor: { state: "degraded", reasonCode: "READINESS_PENDING" },
          database: { state: "unknown", reasonCode: "DEPENDENCY_UNVERIFIED" },
          rabbitmq: { state: "unknown", reasonCode: "DEPENDENCY_UNVERIFIED" },
          api: { state: "unknown", reasonCode: "READINESS_PENDING" },
          frontend: { state: "unknown", reasonCode: "READINESS_PENDING" },
          worker: { state: "ready", reasonCode: null },
          relay: { state: "ready", reasonCode: null },
          scheduler: { state: "ready", reasonCode: null },
        },
      });
      expect(publicStatus(expired, capabilities)).toMatchObject({
        state: "degraded",
        canSubmit: false,
      });
    } finally {
      s.signals.emit("SIGINT");
      await run;
      clock.mockRestore();
    }
  });
  it.each([14000, MAX_SNAPSHOT_AGE_MS, MAX_SNAPSHOT_AGE_MS + 1])(
    "anchors a %i ms initial cycle to its start and never overlaps renewal",
    async (duration) => {
      vi.useFakeTimers();
      try {
        const s = setup();
        const snapshots: Snapshot[] = [];
        let onOpen!: () => void | Promise<void>;
        const releases: Array<() => void> = [];
        let active = 0;
        let maxActive = 0;
        const probe = vi.fn(async (endpoint: "api" | "frontend") => {
          if (endpoint === "api") {
            active++;
            maxActive = Math.max(maxActive, active);
            await new Promise<void>((resolve) => releases.push(resolve));
            active--;
          }
          return true;
        });
        const start = Date.now();
        const run = runSupervisor({
          args: ["--no-open"],
          env: {},
          stabilityMs: 0,
          readinessMs: 30000,
          dependencies: {
            ...s.dependencies,
            probe,
            acquire: async (options) => {
              onOpen = options.onOpen;
              return {
                kind: "owned",
                port: 0,
                setState: () => {},
                setSnapshot: (v) => snapshots.push(structuredClone(v)),
                close: async () => {},
              };
            },
          },
        });
        await vi.advanceTimersByTimeAsync(duration);
        expect(probe).toHaveBeenCalledTimes(2);
        releases[0]!();
        await vi.advanceTimersByTimeAsync(0);
        const published = snapshots.filter((v) => v.state === "ready");
        if (duration < MAX_SNAPSHOT_AGE_MS) {
          expect(published).toHaveLength(1);
          expect(Date.parse(published[0]!.observedAt)).toBe(start);
          expect(
            validSnapshot(published[0], start + MAX_SNAPSHOT_AGE_MS - 1),
          ).toBe(true);
          expect(validSnapshot(published[0], start + MAX_SNAPSHOT_AGE_MS)).toBe(
            false,
          );
          // The overdue renewal starts immediately, but remains the only active cycle.
          await vi.advanceTimersByTimeAsync(1);
          expect(probe).toHaveBeenCalledTimes(4);
          await vi.advanceTimersByTimeAsync(MAX_SNAPSHOT_AGE_MS - duration - 1);
          expect(snapshots.at(-1)?.state).toBe("degraded");
          await expect(Promise.resolve().then(() => onOpen())).rejects.toThrow(
            "NOT_READY",
          );
        } else {
          // A zero-length lease cannot be published ready.
          expect(published).toHaveLength(0);
          expect(snapshots.at(-1)?.state).toBe("degraded");
        }
        expect(maxActive).toBe(1);
        s.signals.emit("SIGINT");
        releases.at(-1)!();
        await vi.advanceTimersByTimeAsync(0);
        expect(await run).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    },
  );
  it("rejects singleton /open after renewal expiry", async () => {
    const s = setup();
    let port = 0;
    let notify!: () => void;
    const listening = new Promise<void>((done) => {
      notify = done;
    });
    const releases: Array<() => void> = [];
    const run = runSupervisor({
      args: ["--no-open"],
      env: {},
      stabilityMs: 0,
      dependencies: {
        ...s.dependencies,
        acquire: async (options) => {
          const owner = await acquireSupervisorSingleton({
            ...options,
            testPort: 0,
          });
          if (owner.kind !== "owned") throw new Error("singleton");
          port = owner.port;
          vi.useFakeTimers();
          notify();
          return owner;
        },
        probe: async (endpoint) => {
          if (endpoint === "api")
            await new Promise<void>((done) => {
              releases.push(done);
            });
          return true;
        },
      },
    });
    try {
      await listening;
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(14000);
      releases[0]!();
      await vi.advanceTimersByTimeAsync(1);
      await vi.advanceTimersByTimeAsync(999);
      const status = await new Promise<number>((done, fail) => {
        const req = request(
          {
            host: "127.0.0.1",
            port,
            path: "/open",
            method: "POST",
            headers: { "content-length": "0" },
          },
          (res) => {
            res.resume();
            res.on("end", () => done(res.statusCode ?? 0));
          },
        );
        req.on("error", fail);
        req.end();
      });
      expect(status).toBe(503);
      expect(s.dependencies.open).not.toHaveBeenCalled();
      s.signals.emit("SIGINT");
      releases.at(-1)!();
      await vi.advanceTimersByTimeAsync(0);
      expect(await run).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(["resolve", "reject"])(
    "times out startup and ignores late %s",
    async (outcome) => {
      vi.useFakeTimers();
      try {
        const s = setup();
        let resolve!: () => void;
        let reject!: (error: Error) => void;
        const start = new Promise<void>((yes, no) => {
          resolve = yes;
          reject = no;
        });
        const stop = vi.fn(async () => ({ forced: [], remaining: [] }));
        const cycle = vi.fn(() => new Promise<never>(() => {}));
        const run = runSupervisor({
          args: ["--no-open"],
          env: {},
          readinessMs: 100,
          dependencies: {
            ...s.dependencies,
            children: () => ({ start: () => start, stop }),
            cycle,
          },
        });
        await vi.advanceTimersByTimeAsync(100);
        expect(await run).toBe(1);
        expect(stop).toHaveBeenCalledOnce();
        expect(s.trace).toContain("READINESS_FAILED");
        if (outcome === "resolve") resolve();
        else reject(new Error("private"));
        await vi.advanceTimersByTimeAsync(0);
        expect(cycle).not.toHaveBeenCalled();
        expect(s.trace).not.toContain("SUPERVISOR_readiness_ready");
      } finally {
        vi.useRealTimers();
      }
    },
  );
  it("expires a stuck renewal, discards stale evidence and retries without overlap", async () => {
    vi.useFakeTimers();
    try {
      const s = setup();
      const snapshots: Snapshot[] = [];
      let onOpen!: () => void | Promise<void>;
      let state = "starting";
      let release!: () => void;
      let block = false;
      const probe = vi.fn(async (endpoint: "api" | "frontend") => {
        if (block && endpoint === "api")
          await new Promise<void>((done) => {
            release = done;
          });
        return true;
      });
      const run = runSupervisor({
        args: ["--no-open"],
        env: {},
        stabilityMs: 0,
        dependencies: {
          ...s.dependencies,
          probe,
          acquire: async (options) => {
            onOpen = options.onOpen;
            return {
              kind: "owned",
              port: 0,
              setState: (next) => {
                state = next;
              },
              setSnapshot: (value) => snapshots.push(structuredClone(value)),
              close: async () => {},
            };
          },
        },
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(state).toBe("ready");
      block = true;
      await vi.advanceTimersByTimeAsync(15000);
      expect(state).toBe("degraded");
      expect(snapshots.at(-1)?.components.api.state).toBe("unknown");
      expect(validSnapshot(snapshots.at(-1))).toBe(true);
      await expect(Promise.resolve().then(() => onOpen())).rejects.toThrow(
        "NOT_READY",
      );
      expect(probe).toHaveBeenCalledTimes(4);
      await vi.advanceTimersByTimeAsync(5000);
      release();
      await vi.advanceTimersByTimeAsync(0);
      expect(state).toBe("degraded");
      block = false;
      await vi.advanceTimersByTimeAsync(5000);
      expect(state).toBe("ready");
      s.signals.emit("SIGINT");
      expect(await run).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
  it("bounds stuck renewal cleanup and hard exits once across failures", async () => {
    vi.useFakeTimers();
    try {
      const s = setup();
      let block = false;
      const run = runSupervisor({
        args: ["--no-open"],
        env: {},
        stabilityMs: 0,
        dependencies: {
          ...s.dependencies,
          acquire: async () => ({
            kind: "owned",
            port: 0,
            setState: () => {},
            close: async () => {
              throw new Error("private");
            },
          }),
          children: (options) => {
            const child = s.dependencies.children(options);
            return {
              ...child,
              stop: async () => ({
                forced: [],
                remaining: ["worker" as const],
              }),
            };
          },
          probe: async (endpoint) =>
            block && endpoint === "api" ? new Promise<boolean>(() => {}) : true,
        },
      });
      await vi.advanceTimersByTimeAsync(0);
      block = true;
      await vi.advanceTimersByTimeAsync(5000);
      s.signals.emit("SIGINT");
      await vi.advanceTimersByTimeAsync(5000);
      expect(await run).toBe(1);
      expect(s.dependencies.hardExit).toHaveBeenCalledOnce();
      expect(s.signals.listenerCount("SIGINT")).toBe(0);
      expect(s.signals.listenerCount("SIGTERM")).toBe(0);
      expect(s.trace.join(" ")).not.toContain("private");
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails at the initial deadline and discards a late successful cycle", async () => {
    vi.useFakeTimers();
    try {
      const s = setup();
      let release!: () => void;
      let cycleSignal!: AbortSignal;
      const cycle = vi.fn(async (options: { signal: AbortSignal }) => {
        cycleSignal = options.signal;
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return [
          {
            status: "fulfilled" as const,
            value: await s.dependencies.preflight(),
          },
          { status: "fulfilled" as const, value: true },
          { status: "fulfilled" as const, value: true },
        ] as [
          PromiseFulfilledResult<
            Awaited<ReturnType<typeof s.dependencies.preflight>>
          >,
          PromiseFulfilledResult<boolean>,
          PromiseFulfilledResult<boolean>,
        ];
      });
      const run = runSupervisor({
        args: [],
        env: {},
        stabilityMs: 0,
        readinessMs: 100,
        dependencies: { ...s.dependencies, cycle },
      });
      await vi.advanceTimersByTimeAsync(100);
      expect(cycleSignal.aborted).toBe(true);
      expect(s.trace).toContain("READINESS_FAILED");
      expect(s.trace).not.toContain("ready");
      release();
      await vi.advanceTimersByTimeAsync(0);
      expect(await run).toBe(1);
      expect(s.trace).not.toContain("SUPERVISOR_readiness_ready");
      expect(s.dependencies.open).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
  it("bounds cleanup of a cycle that ignores abort", async () => {
    vi.useFakeTimers();
    try {
      const s = setup();
      const run = runSupervisor({
        args: ["--no-open"],
        env: {},
        readinessMs: 100,
        dependencies: { ...s.dependencies, cycle: () => new Promise(() => {}) },
      });
      await vi.advanceTimersByTimeAsync(100);
      expect(s.trace).toContain("READINESS_FAILED");
      expect(s.trace).toContain("stop");
      await vi.advanceTimersByTimeAsync(5000);
      expect(await run).toBe(1);
      expect(s.trace).toContain("CLEANUP_STUCK");
      expect(s.dependencies.hardExit).toHaveBeenCalledWith(1);
      expect(s.trace).not.toContain("SUPERVISOR_readiness_ready");
    } finally {
      vi.useRealTimers();
    }
  });
  it("renews and recovers while the one automatic browser open is pending", async () => {
    vi.useFakeTimers();
    try {
      const s = setup();
      const snapshots: Snapshot[] = [];
      const open = vi.fn(() => new Promise<void>(() => {}));
      const run = runSupervisor({
        args: [],
        env: {},
        stabilityMs: 0,
        dependencies: {
          ...s.dependencies,
          open,
          acquire: async () => ({
            kind: "owned",
            port: 0,
            setState: () => {},
            setSnapshot: (v) => snapshots.push(structuredClone(v)),
            close: async () => {},
          }),
        },
      });
      await vi.advanceTimersByTimeAsync(15000);
      expect(snapshots.filter((v) => v.state === "ready")).toHaveLength(4);
      expect(open).toHaveBeenCalledOnce();
      s.getEvent()({ role: "worker", state: "restarting", reason: "exit" });
      s.getEvent()({ role: "worker", state: "started", reason: "spawned" });
      expect(snapshots.at(-1)?.state).toBe("degraded");
      await vi.advanceTimersByTimeAsync(5000);
      expect(snapshots.at(-1)?.state).toBe("ready");
      expect(open).toHaveBeenCalledOnce();
      s.signals.emit("SIGINT");
      expect(await run).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
  it("sanitizes automatic browser rejection without retrying", async () => {
    vi.useFakeTimers();
    try {
      const s = setup();
      const open = vi.fn(async () => {
        throw new Error("secret path");
      });
      const run = runSupervisor({
        args: [],
        env: {},
        stabilityMs: 0,
        dependencies: { ...s.dependencies, open },
      });
      await vi.advanceTimersByTimeAsync(15000);
      expect(open).toHaveBeenCalledOnce();
      expect(s.trace.filter((v) => v === "OPEN_FAILED")).toHaveLength(1);
      expect(s.trace.join(" ")).not.toContain("secret");
      s.signals.emit("SIGINT");
      expect(await run).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
  it("accepts an injected evidence cycle with configured URLs and signal", async () => {
    const s = setup();
    const cycle = vi.fn(
      async () =>
        [
          {
            status: "fulfilled" as const,
            value: await s.dependencies.preflight(),
          },
          { status: "fulfilled" as const, value: true },
          { status: "fulfilled" as const, value: true },
        ] as [
          PromiseFulfilledResult<
            Awaited<ReturnType<typeof s.dependencies.preflight>>
          >,
          PromiseFulfilledResult<boolean>,
          PromiseFulfilledResult<boolean>,
        ],
    );
    expect(
      await runSupervisor({
        args: ["--no-infra"],
        env: { DATABASE_URL: "postgres://host/db", AMQP_URL: "amqp://host" },
        dependencies: { ...s.dependencies, cycle },
        stabilityMs: 0,
      }),
    ).toBe(0);
    expect(cycle).toHaveBeenCalledOnce();
    expect(cycle).toHaveBeenCalledWith(
      expect.objectContaining({
        databaseUrl: "postgres://host/db",
        amqpUrl: "amqp://host",
        signal: expect.any(AbortSignal),
      }),
    );
  });
  it("publishes startup, retry, recovery, and shutdown snapshots", async () => {
    const s = setup();
    const snapshots: Snapshot[] = [];
    const acquire: typeof import("../src/runtime-supervisor-singleton.js").acquireSupervisorSingleton =
      async () => ({
        kind: "owned",
        port: 0,
        setState: () => {},
        setSnapshot: (v) => {
          expect(validSnapshot(v)).toBe(true);
          snapshots.push(structuredClone(v));
        },
        close: async () => {},
      });
    const open = async () => {
      s.getEvent()({ role: "worker", state: "restarting", reason: "exit" });
      s.getEvent()({ role: "worker", state: "started", reason: "spawned" });
      s.signals.emit("SIGINT");
    };
    expect(
      await runSupervisor({
        args: [],
        env: {},
        dependencies: { ...s.dependencies, acquire, open },
        stabilityMs: 0,
      }),
    ).toBe(0);
    expect(snapshots[0]?.state).toBe("starting");
    const degraded = snapshots.find((v) => v.state === "degraded")!;
    expect(degraded.components.worker.state).toBe("starting");
    expect(degraded.components.database.state).toBe("unknown");
    const recovered = snapshots.findLast((v) => v.state === "ready")!;
    expect(recovered.components.worker.state).toBe("ready");
    expect(recovered.components.database.state).toBe("ready");
    expect(snapshots.at(-1)?.state).toBe("stopping");
  });
  it("publishes terminal child failure before shutdown", async () => {
    const s = setup();
    const snapshots: Snapshot[] = [];
    const acquire: typeof import("../src/runtime-supervisor-singleton.js").acquireSupervisorSingleton =
      async () => ({
        kind: "owned",
        port: 0,
        setState: () => {},
        setSnapshot: (v) => {
          expect(validSnapshot(v)).toBe(true);
          snapshots.push(structuredClone(v));
        },
        close: async () => {},
      });
    const open = async () =>
      s.getEvent()({
        role: "relay",
        state: "terminal",
        reason: "terminal_fatal",
      });
    expect(
      await runSupervisor({
        args: [],
        env: {},
        dependencies: { ...s.dependencies, acquire, open },
        stabilityMs: 0,
      }),
    ).toBe(1);
    expect(
      snapshots.some(
        (v) =>
          v.state === "degraded" && v.components.relay.state === "unavailable",
      ),
    ).toBe(true);
    expect(snapshots.at(-1)?.state).toBe("stopping");
  });
  it("renews evidence, degrades on dependency and endpoint loss, and recovers every role", async () => {
    vi.useFakeTimers();
    try {
      const s = setup();
      const snapshots: Snapshot[] = [];
      let healthy = true;
      let api = true;
      let frontend = true;
      const acquire: typeof import("../src/runtime-supervisor-singleton.js").acquireSupervisorSingleton =
        async () => ({
          kind: "owned",
          port: 0,
          setState: () => {},
          setSnapshot: (v) => {
            expect(validSnapshot(v)).toBe(true);
            snapshots.push(structuredClone(v));
          },
          close: async () => {},
        });
      const preflight = async () => ({
        version: 1 as const,
        state: healthy ? ("ready" as const) : ("unavailable" as const),
        dependencies: {
          postgres: {
            state: healthy ? ("ready" as const) : ("unavailable" as const),
            reasonCode: healthy ? null : ("DEPENDENCY_UNAVAILABLE" as const),
          },
          rabbitmq: { state: "ready" as const, reasonCode: null },
        },
        observedAt: new Date().toISOString(),
      });
      const probe = vi.fn(async (endpoint: "api" | "frontend") =>
        endpoint === "api" ? api : frontend,
      );
      const run = runSupervisor({
        args: ["--no-open"],
        env: {},
        stabilityMs: 0,
        dependencies: {
          ...s.dependencies,
          acquire,
          preflight,
          probe,
        },
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(snapshots.at(-1)?.state).toBe("ready");
      const first = snapshots.at(-1)!.observedAt;
      await vi.advanceTimersByTimeAsync(20000);
      expect(snapshots.at(-1)?.state).toBe("ready");
      expect(Date.parse(snapshots.at(-1)!.observedAt) - Date.parse(first)).toBe(
        20000,
      );
      expect(snapshots.filter((v) => v.state === "ready")).toHaveLength(5);
      expect(s.dependencies.bootstrap).toHaveBeenCalledTimes(1);
      healthy = false;
      await vi.advanceTimersByTimeAsync(5000);
      expect(snapshots.at(-1)?.state).toBe("degraded");
      healthy = true;
      api = false;
      await vi.advanceTimersByTimeAsync(5000);
      expect(snapshots.at(-1)?.components.api.state).toBe("unknown");
      api = true;
      frontend = false;
      await vi.advanceTimersByTimeAsync(5000);
      expect(snapshots.at(-1)?.components.frontend.state).toBe("unknown");
      frontend = true;
      await vi.advanceTimersByTimeAsync(5000);
      expect(snapshots.at(-1)?.state).toBe("ready");
      for (const role of [
        "api",
        "frontend",
        "worker",
        "relay",
        "scheduler",
      ] as const) {
        const previousProbes = probe.mock.calls.length;
        s.getEvent()({ role, state: "restarting", reason: "exit" });
        expect(snapshots.at(-1)?.state).toBe("degraded");
        s.getEvent()({ role, state: "started", reason: "spawned" });
        expect(snapshots.at(-1)?.state).toBe("degraded");
        await vi.advanceTimersByTimeAsync(5000);
        expect(snapshots.at(-1)?.state).toBe("ready");
        expect(
          probe.mock.calls.slice(previousProbes).map(([name]) => name),
        ).toEqual(["api", "frontend"]);
      }
      s.signals.emit("SIGINT");
      expect(await run).toBe(0);
      expect(snapshots.at(-1)?.state).toBe("stopping");
    } finally {
      vi.useRealTimers();
    }
  });
  it("degrades on a rejected current probe and cancels the idle renewal on stop", async () => {
    vi.useFakeTimers();
    try {
      const s = setup();
      const snapshots: Snapshot[] = [];
      let reject = false;
      const probe = vi.fn(async (endpoint: "api" | "frontend") => {
        if (reject && endpoint === "api") throw new Error("private");
        return true;
      });
      const run = runSupervisor({
        args: ["--no-open"],
        env: {},
        stabilityMs: 0,
        dependencies: {
          ...s.dependencies,
          probe,
          acquire: async () => ({
            kind: "owned",
            port: 0,
            setState: () => {},
            setSnapshot: (v) => {
              expect(validSnapshot(v)).toBe(true);
              snapshots.push(structuredClone(v));
            },
            close: async () => {},
          }),
        },
      });
      await vi.advanceTimersByTimeAsync(0);
      reject = true;
      await vi.advanceTimersByTimeAsync(5000);
      expect(snapshots.at(-1)?.state).toBe("degraded");
      expect(snapshots.at(-1)?.components.api).toEqual({
        state: "unknown",
        reasonCode: "READINESS_PENDING",
      });
      reject = false;
      await vi.advanceTimersByTimeAsync(5000);
      expect(snapshots.at(-1)?.state).toBe("ready");
      s.signals.emit("SIGINT");
      expect(await run).toBe(0);
      const calls = probe.mock.calls.length;
      await vi.advanceTimersByTimeAsync(20000);
      expect(probe).toHaveBeenCalledTimes(calls);
      expect(snapshots.at(-1)?.state).toBe("stopping");
    } finally {
      vi.useRealTimers();
    }
  });
  it("discards a cycle invalidated by a restart and never overlaps probes", async () => {
    vi.useFakeTimers();
    try {
      const s = setup();
      const snapshots: Snapshot[] = [];
      let release!: (value: boolean) => void;
      let blocked = false;
      let active = 0;
      let max = 0;
      const acquire: typeof import("../src/runtime-supervisor-singleton.js").acquireSupervisorSingleton =
        async () => ({
          kind: "owned",
          port: 0,
          setState: () => {},
          setSnapshot: (v) => {
            expect(validSnapshot(v)).toBe(true);
            snapshots.push(structuredClone(v));
          },
          close: async () => {},
        });
      const probe = async (endpoint: "api" | "frontend") => {
        if (endpoint !== "api") return true;
        active++;
        max = Math.max(max, active);
        try {
          return blocked
            ? await new Promise<boolean>((done) => {
                release = done;
              })
            : true;
        } finally {
          active--;
        }
      };
      const run = runSupervisor({
        args: ["--no-open"],
        env: {},
        stabilityMs: 0,
        dependencies: { ...s.dependencies, acquire, probe },
      });
      await vi.advanceTimersByTimeAsync(0);
      blocked = true;
      await vi.advanceTimersByTimeAsync(5000);
      s.getEvent()({ role: "worker", state: "restarting", reason: "exit" });
      s.getEvent()({ role: "worker", state: "started", reason: "spawned" });
      await vi.advanceTimersByTimeAsync(10000);
      expect(max).toBe(1);
      release(true);
      await vi.advanceTimersByTimeAsync(0);
      expect(snapshots.at(-1)?.state).toBe("degraded");
      blocked = false;
      await vi.advanceTimersByTimeAsync(5000);
      expect(snapshots.at(-1)?.state).toBe("ready");
      s.signals.emit("SIGINT");
      expect(await run).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
  it("discards a rejected stale cycle and retries without publishing its failure", async () => {
    vi.useFakeTimers();
    try {
      const s = setup();
      const snapshots: Snapshot[] = [];
      let rejectProbe!: (error: Error) => void;
      let block = false;
      const run = runSupervisor({
        args: ["--no-open"],
        env: {},
        stabilityMs: 0,
        dependencies: {
          ...s.dependencies,
          acquire: async () => ({
            kind: "owned",
            port: 0,
            setState: () => {},
            setSnapshot: (v) => {
              expect(validSnapshot(v)).toBe(true);
              snapshots.push(structuredClone(v));
            },
            close: async () => {},
          }),
          probe: async (endpoint) =>
            block && endpoint === "api"
              ? new Promise<boolean>((_resolve, reject) => {
                  rejectProbe = reject;
                })
              : true,
        },
      });
      await vi.advanceTimersByTimeAsync(0);
      block = true;
      await vi.advanceTimersByTimeAsync(5000);
      s.getEvent()({ role: "relay", state: "restarting", reason: "exit" });
      s.getEvent()({ role: "relay", state: "started", reason: "spawned" });
      const count = snapshots.length;
      rejectProbe(new Error("probe failed"));
      await vi.advanceTimersByTimeAsync(0);
      expect(snapshots).toHaveLength(count);
      block = false;
      await vi.advanceTimersByTimeAsync(5000);
      expect(snapshots.at(-1)?.state).toBe("ready");
      s.signals.emit("SIGINT");
      expect(await run).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
  it("aborts an active cycle on stop and handles stuck singleton close privately", async () => {
    const s = setup();
    let aborted = false;
    const preflight = async (
      options: Parameters<
        typeof import("../src/runtime-preflight.js").runPreflight
      >[0],
    ) => {
      await new Promise<void>((done) =>
        options.signal.addEventListener(
          "abort",
          () => {
            aborted = true;
            done();
          },
          { once: true },
        ),
      );
      return {
        version: 1 as const,
        state: "aborted" as const,
        dependencies: {
          postgres: {
            state: "aborted" as const,
            reasonCode: "ABORTED" as const,
          },
          rabbitmq: {
            state: "aborted" as const,
            reasonCode: "ABORTED" as const,
          },
        },
        observedAt: new Date().toISOString(),
      };
    };
    const acquire: typeof import("../src/runtime-supervisor-singleton.js").acquireSupervisorSingleton =
      async () => ({
        kind: "owned",
        port: 0,
        setState: () => {},
        close: async () => {
          throw new Error("SINGLETON_CLOSE_STUCK secret");
        },
      });
    const run = runSupervisor({
      args: ["--no-open"],
      env: {},
      dependencies: { ...s.dependencies, acquire, preflight },
    });
    await new Promise((done) => setTimeout(done, 10));
    s.signals.emit("SIGINT");
    expect(await run).toBe(1);
    expect(aborted).toBe(true);
    expect(s.trace).not.toContain("SUPERVISOR_stopped");
    expect(s.trace.join(" ")).not.toContain("secret");
    expect(s.dependencies.hardExit).toHaveBeenCalledWith(1);
  });
  it("validates exact arguments and strips hostile environment", () => {
    expect(() => parseSupervisorArgs(["--port=123", "secret"])).toThrow(
      "INVALID_ARGUMENTS",
    );
    expect(() => parseSupervisorArgs(["--no-open", "--no-open"])).toThrow();
    expect(childEnvironment({}, "no-infra")).toBeNull();
    const env = childEnvironment(
      {
        NODE_OPTIONS: "bad",
        SECRET: "hidden",
        CONDITIONS_WRITES_ENABLED: "1",
        VIACEP_EXTERNAL_EXECUTION_ENABLED: "true",
      },
      "managed-infra",
    )!;
    expect(env.NODE_OPTIONS).toBeUndefined();
    expect(env.SECRET).toBeUndefined();
    expect(env.CONDITIONS_WRITES_ENABLED).toBe("1");
    expect(env.VIACEP_WRITES_ENABLED).toBeUndefined();
    expect(env.VIACEP_EXTERNAL_EXECUTION_ENABLED).toBe("true");
  });
  it("orders bootstrap, readiness, open and shutdown", async () => {
    const s = setup();
    expect(
      await runSupervisor({
        args: [],
        env: {},
        dependencies: s.dependencies,
        stabilityMs: 0,
      }),
    ).toBe(0);
    expect(s.trace).toEqual([
      "SUPERVISOR_singleton_owned",
      "bootstrap",
      "SUPERVISOR_bootstrap_ready",
      "start",
      "CHILD_api_started_spawned",
      "CHILD_worker_started_spawned",
      "CHILD_relay_started_spawned",
      "CHILD_scheduler_started_spawned",
      "CHILD_frontend_started_spawned",
      "SUPERVISOR_children_started",
      "ready",
      "SUPERVISOR_readiness_ready",
      "open",
      "SUPERVISOR_stopping",
      "stopping",
      "stop",
      "close",
      "SUPERVISOR_stopped",
    ]);
    expect(s.dependencies.probe).toHaveBeenCalledTimes(2);
  });
  it("does no work for an existing instance or conflict", async () => {
    const s = setup();
    const existing = vi.fn(
      async (
        _options: Parameters<
          typeof import("../src/runtime-supervisor-singleton.js").acquireSupervisorSingleton
        >[0],
      ) => ({
        kind: "existing" as const,
        opened: _options.openExisting === true,
      }),
    );
    expect(
      await runSupervisor({
        args: ["--no-open"],
        env: {},
        dependencies: { ...s.dependencies, acquire: existing },
      }),
    ).toBe(0);
    expect(existing.mock.calls[0]![0].openExisting).toBe(false);
    expect(s.dependencies.bootstrap).not.toHaveBeenCalled();
    expect(
      await runSupervisor({
        args: [],
        env: {},
        dependencies: {
          ...s.dependencies,
          acquire: async () => ({ kind: "existing", opened: false }),
        },
      }),
    ).toBe(1);
    expect(s.trace).toContain("OPEN_UNAVAILABLE");
    expect(
      await runSupervisor({
        args: [],
        env: {},
        dependencies: {
          ...s.dependencies,
          acquire: async () => ({ kind: "conflict", code: "PORT_CONFLICT" }),
        },
      }),
    ).toBe(1);
  });
  it("requires a continuous successful probe interval after a failure", async () => {
    const s = setup();
    let rounds = 0;
    const probe = async (endpoint: "api" | "frontend") => {
      if (endpoint === "api") rounds++;
      return rounds !== 2;
    };
    expect(
      await runSupervisor({
        args: [],
        env: {},
        dependencies: { ...s.dependencies, probe },
        stabilityMs: 150,
        readinessMs: 1500,
      }),
    ).toBe(0);
    expect(rounds).toBeGreaterThanOrEqual(4);
  });
  it("allows later open requests after an owner starts with --no-open", async () => {
    const s = setup();
    let onOpen!: () => void | Promise<void>;
    const acquire: typeof import("../src/runtime-supervisor-singleton.js").acquireSupervisorSingleton =
      async (options) => {
        onOpen = options.onOpen;
        return {
          kind: "owned",
          port: 0,
          setState: (state) => {
            if (state === "ready") void onOpen();
          },
          close: async () => {},
        };
      };
    expect(
      await runSupervisor({
        args: ["--no-open"],
        env: {},
        dependencies: { ...s.dependencies, acquire },
        stabilityMs: 0,
      }),
    ).toBe(0);
    expect(s.dependencies.open).toHaveBeenCalledOnce();
  });
  it("cleans up after child start failure and forces exit on stuck cleanup", async () => {
    const s = setup();
    const children = () => ({
      start: async () => {
        throw new Error("secret");
      },
      stop: async () => ({ forced: [], remaining: ["worker" as const] }),
    });
    expect(
      await runSupervisor({
        args: [],
        env: {},
        dependencies: { ...s.dependencies, children },
      }),
    ).toBe(1);
    expect(s.trace).toContain("CHILD_START_FAILED");
    expect(s.trace).toContain("CLEANUP_STUCK");
    expect(s.trace.join(" ")).not.toContain("secret");
    expect(s.dependencies.hardExit).toHaveBeenCalledWith(1);
  });
  it("hard exits on a second signal", async () => {
    const s = setup();
    const bootstrap = async () => {
      s.signals.emit("SIGINT");
      s.signals.emit("SIGTERM");
      return {
        phase: "complete" as const,
        outcome: "ready" as const,
        reasonCode: "ready" as const,
        attempts: 1,
      };
    };
    expect(
      await runSupervisor({
        args: [],
        env: {},
        dependencies: { ...s.dependencies, bootstrap },
      }),
    ).toBe(0);
    expect(s.dependencies.hardExit).toHaveBeenCalledWith(1);
  });
  it("resets readiness when a child changes during a probe", async () => {
    const s = setup();
    let rounds = 0;
    const probe = async (endpoint: "api" | "frontend") => {
      if (endpoint === "api" && ++rounds === 2) {
        s.getEvent()({ role: "worker", state: "started", reason: "spawned" });
      }
      return true;
    };
    expect(
      await runSupervisor({
        args: [],
        env: {},
        dependencies: { ...s.dependencies, probe },
        stabilityMs: 250,
        readinessMs: 2000,
      }),
    ).toBe(0);
    expect(rounds).toBeGreaterThanOrEqual(4);
  });
  it("reports control failures without changing running roles or probe generation", async () => {
    const s = setup();
    let calls = 0;
    const probe = async (endpoint: "api" | "frontend") => {
      if (endpoint === "api") {
        calls++;
        s.getEvent()({
          role: "relay",
          state: "control_failed",
          reason: "ipc_failure",
        });
        s.getEvent()({
          role: "scheduler",
          state: "control_failed",
          reason: "ipc_failure",
        });
      }
      return true;
    };
    expect(
      await runSupervisor({
        args: [],
        env: {},
        dependencies: { ...s.dependencies, probe },
        stabilityMs: 0,
        readinessMs: 100,
      }),
    ).toBe(0);
    expect(calls).toBe(1);
    expect(s.trace).toContain("CHILD_relay_control_failed_ipc_failure");
    expect(s.trace).toContain("CHILD_scheduler_control_failed_ipc_failure");
    expect(s.trace).not.toContain("CHILD_TERMINAL");
    expect(s.trace).toContain("SUPERVISOR_readiness_ready");
  });
  it("still removes a role on actual stop after a control failure", async () => {
    const s = setup();
    let invoked = false;
    const probe = async () => {
      if (!invoked) {
        invoked = true;
        s.getEvent()({
          role: "relay",
          state: "control_failed",
          reason: "ipc_failure",
        });
        s.getEvent()({ role: "relay", state: "stopped", reason: "shutdown" });
      }
      return true;
    };
    expect(
      await runSupervisor({
        args: [],
        env: {},
        dependencies: { ...s.dependencies, probe },
        stabilityMs: 0,
        readinessMs: 10,
      }),
    ).toBe(1);
    expect(s.trace).toContain("CHILD_relay_stopped_shutdown");
    expect(s.trace).toContain("READINESS_FAILED");
    expect(s.trace).not.toContain("SUPERVISOR_readiness_ready");
  });
  it("reports a restart once per callback and rejects arbitrary callback values", async () => {
    const s = setup();
    let invoked = false;
    const probe = async () => {
      if (!invoked) {
        invoked = true;
        const emit = s.getEvent();
        emit({ role: "worker", state: "restarting", reason: "exit" });
        emit({ role: "worker", state: "started", reason: "spawned" });
        emit({
          role: "secret-role",
          state: "started",
          reason: "secret-output",
        } as never);
      }
      return true;
    };
    expect(
      await runSupervisor({
        args: [],
        env: {},
        dependencies: { ...s.dependencies, probe },
        stabilityMs: 0,
        readinessMs: 500,
      }),
    ).toBe(0);
    const childEvents = s.trace.filter((code) => code.startsWith("CHILD_"));
    expect(
      childEvents.filter((code) => code === "CHILD_worker_restarting_exit"),
    ).toHaveLength(1);
    expect(
      childEvents.filter((code) => code === "CHILD_worker_started_spawned"),
    ).toHaveLength(2);
    expect(childEvents.indexOf("CHILD_worker_restarting_exit")).toBeLessThan(
      childEvents.lastIndexOf("CHILD_worker_started_spawned"),
    );
    expect(
      childEvents.filter((code) => code === "CHILD_INVALID_EVENT"),
    ).toHaveLength(1);
    expect(s.trace.join(" ")).not.toContain("secret");
  });
  it("does not let an event observer disrupt lifecycle or failure handling", async () => {
    const s = setup();
    const event = vi.fn(() => {
      throw new Error("secret observer output");
    });
    expect(
      await runSupervisor({
        args: [],
        env: {},
        dependencies: { ...s.dependencies, event },
        stabilityMs: 0,
      }),
    ).toBe(0);
    expect(event).toHaveBeenCalledWith("CHILD_api_started_spawned");
    expect(event).toHaveBeenCalledWith("SUPERVISOR_stopped");
    expect(s.trace).toContain("close");
    expect(
      await runSupervisor({
        args: ["secret"],
        env: {},
        dependencies: { ...s.dependencies, event },
      }),
    ).toBe(2);
  });
  it("validates bounded HTTP probe content and aborts", async () => {
    let type = "application/json";
    let body =
      '{"profile":"local-development-only","limitations":["local only"]}';
    let hang = false;
    const server = createServer((_req, res) => {
      if (!hang) {
        res.setHeader("content-type", type);
        res.end(body);
      }
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("address");
    const check = (endpoint: "api" | "frontend") =>
      probeEndpoint(endpoint, new AbortController().signal, address.port);
    try {
      expect(await check("api")).toBe(true);
      for (const invalid of [
        "{}",
        "{",
        '{"profile":"local-development-only","limitations":[]}',
        '{"profile":"local-development-only","limitations":["x"],"extra":1}',
        "x".repeat(17000),
      ]) {
        body = invalid;
        expect(await check("api")).toBe(false);
      }
      body = '{"profile":"local-development-only","limitations":["x"]}';
      type = "text/plain";
      expect(await check("api")).toBe(false);
      type = "text/html; charset=utf-8";
      body = '<title>InteliFluxo</title><div id="root"></div>';
      expect(await check("frontend")).toBe(true);
      body = '<title>Other</title><div id="root"></div>';
      expect(await check("frontend")).toBe(false);
      hang = true;
      const controller = new AbortController();
      const pending = probeEndpoint("api", controller.signal, address.port);
      controller.abort();
      expect(await pending).toBe(false);
      expect(await check("api")).toBe(false);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
  it("degrades on bootstrap failure without starting children", async () => {
    const s = setup();
    const bootstrap = async () => ({
      phase: "compose" as const,
      outcome: "failed" as const,
      reasonCode: "compose_unavailable" as const,
      attempts: 0,
    });
    expect(
      await runSupervisor({
        args: [],
        env: {},
        dependencies: { ...s.dependencies, bootstrap },
      }),
    ).toBe(1);
    expect(s.trace).toEqual([
      "SUPERVISOR_singleton_owned",
      "degraded",
      "BOOTSTRAP_FAILED",
      "SUPERVISOR_stopping",
      "stopping",
      "close",
      "SUPERVISOR_stopped",
    ]);
    expect(s.dependencies.children).not.toHaveBeenCalled();
  });
  it("fails readiness and stops children", async () => {
    const s = setup();
    expect(
      await runSupervisor({
        args: ["--no-open"],
        env: {},
        dependencies: { ...s.dependencies, probe: async () => false },
        readinessMs: 5,
      }),
    ).toBe(1);
    expect(s.trace).toContain("READINESS_FAILED");
    expect(s.trace.slice(-4)).toEqual([
      "stopping",
      "stop",
      "close",
      "SUPERVISOR_stopped",
    ]);
  });
  it("handles a terminal budget event", async () => {
    const s = setup();
    const probe = async () => {
      s.getEvent()({ role: "worker", state: "terminal", reason: "budget" });
      return true;
    };
    expect(
      await runSupervisor({
        args: [],
        env: {},
        dependencies: { ...s.dependencies, probe },
        stabilityMs: 0,
      }),
    ).toBe(1);
    expect(s.trace).toContain("CHILD_worker_terminal_budget");
    expect(s.trace).toContain("CHILD_TERMINAL");
    expect(s.trace).not.toContain("ready");
  });
});
