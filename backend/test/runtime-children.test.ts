import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import {
  childSpecs,
  RuntimeChildren,
  type ChildEvent,
  type ChildRole,
  type ChildSpec,
} from "../src/runtime-children.js";

class Fake extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  connected = true;
  actions: string[] = [];
  alive = true;
  constructor(readonly role: ChildRole) {
    super();
  }
  send(message: string, _callback?: (error: Error | null) => void) {
    void _callback;
    this.actions.push(message);
    return true;
  }
  kill(signal = "SIGTERM") {
    this.actions.push(signal);
    return true;
  }
  exit(code: number | null = 0, signal: NodeJS.Signals | null = null) {
    this.alive = false;
    this.emit("exit", code, signal);
  }
}
const tick = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};
function setup(fail?: ChildRole) {
  const children: Fake[] = [];
  const events: ChildEvent[] = [];
  const waits: { ms: number; resolve: () => void }[] = [];
  let now = 0;
  let maxRelay = 0;
  let maxScheduler = 0;
  const manager = new RuntimeChildren({
    root: "/workspace",
    viteExists: () => true,
    env: { SECRET: "hidden" },
    spawnPipesOwned: true,
    onEvent: (e) => events.push(e),
    now: () => now,
    wait: (ms, signal) =>
      new Promise<void>((resolve) => {
        const done = () => resolve();
        waits.push({ ms, resolve: done });
        signal.addEventListener("abort", done, { once: true });
      }),
    spawn: (spec: ChildSpec) => {
      const child = new Fake(spec.role);
      children.push(child);
      maxRelay = Math.max(
        maxRelay,
        children.filter((c) => c.role === "relay" && c.alive).length,
      );
      maxScheduler = Math.max(
        maxScheduler,
        children.filter((c) => c.role === "scheduler" && c.alive).length,
      );
      queueMicrotask(() =>
        child.emit(spec.role === fail ? "error" : "spawn", new Error("secret")),
      );
      return child as unknown as ChildProcess;
    },
  });
  const byRole = (role: ChildRole) => children.filter((c) => c.role === role);
  return {
    manager,
    children,
    events,
    waits,
    byRole,
    maxRelay: () => maxRelay,
    maxScheduler: () => maxScheduler,
    advance: (ms: number) => {
      now += ms;
    },
  };
}
describe("runtime children", () => {
  it("builds five exact shell-free specs and enables IPC only for daemons", () => {
    const specs = childSpecs("/workspace", "/node/node");
    expect(specs.map((s) => s.role)).toEqual([
      "api",
      "worker",
      "relay",
      "scheduler",
      "frontend",
    ]);
    expect(specs[0].args).toEqual([
      "--import",
      "tsx",
      expect.stringMatching(/api-main\.ts$/),
    ]);
    expect(specs[1].args.at(-1)).toMatch(/worker-main\.ts$/);
    expect(specs[2].args.slice(-2)).toEqual(["relay", "--daemon"]);
    expect(specs[3].args.slice(-2)).toEqual(["scheduler", "--daemon"]);
    expect(specs.map((s) => s.ipc)).toEqual([false, false, true, true, false]);
    expect(specs[4].executable).toBe("/node/node");
    expect(specs[4].args).toEqual([
      expect.stringMatching(/vite[\\/]bin[\\/]vite\.js$/),
      "--host",
      "127.0.0.1",
      "--port",
      "5173",
      "--strictPort",
    ]);
    expect(childSpecs("/workspace", "/node/node.exe")[4].executable).toBe(
      "/node/node.exe",
    );
  });
  it("retries relay exit 3 and keeps one child per role", async () => {
    const s = setup();
    await s.manager.start();
    s.byRole("relay")[0].exit(3);
    await tick();
    expect(s.waits[0].ms).toBe(500);
    expect(s.events.at(-1)).toMatchObject({
      state: "restarting",
      reason: "retry_code_3",
    });
    expect(s.byRole("relay")).toHaveLength(1);
    s.waits[0].resolve();
    await tick();
    expect(s.byRole("relay")).toHaveLength(2);
    s.byRole("relay")[1].exit(4);
    s.byRole("scheduler")[0].exit(2);
    await tick();
    expect(s.events.filter((e) => e.state === "terminal")).toHaveLength(2);
    s.byRole("relay")[0].emit("close", 3, null);
    expect(s.byRole("relay")[0].listenerCount("exit")).toBe(0);
  });
  it.each([
    [2, "terminal_busy"],
    [4, "terminal_fatal"],
    [5, "terminal_lock_lost"],
    [6, "terminal_cleanup_stuck"],
    [7, "terminal_unknown_exit"],
  ] as const)("does not retry daemon exit %s", async (code, reason) => {
    const s = setup();
    await s.manager.start();
    s.byRole("relay")[0].exit(code);
    await tick();
    expect(s.byRole("relay")).toHaveLength(1);
    expect(s.events.at(-1)).toMatchObject({ state: "terminal", reason });
  });
  it("treats an initial scheduler busy exit as terminal", async () => {
    const s = setup();
    await s.manager.start();
    s.byRole("scheduler")[0].exit(2);
    await tick();
    expect(s.events.at(-1)).toEqual({
      role: "scheduler",
      state: "terminal",
      reason: "terminal_busy",
    });
    expect(s.waits).toHaveLength(0);
  });
  it.each(["relay", "scheduler"] as const)(
    "restarts %s on signal and discards raw output",
    async (role) => {
      const s = setup();
      await s.manager.start();
      const relay = s.byRole(role)[0];
      relay.stdout.write("private raw output");
      relay.stderr.write("private error output");
      relay.exit(null, "SIGTERM");
      await tick();
      expect(s.byRole(role)).toHaveLength(1);
      expect(s.events.at(-1)).toEqual({
        role,
        state: "restarting",
        reason: "retry_signal",
      });
      expect(s.waits[0].ms).toBe(500);
      s.waits[0].resolve();
      await tick();
      expect(s.byRole(role)).toHaveLength(2);
      expect(s.byRole(role)[1]).not.toBe(relay);
      expect(s.maxRelay()).toBe(1);
      expect(s.maxScheduler()).toBe(1);
      expect(JSON.stringify(s.events)).not.toContain("private");
      relay.emit("error", new Error("late"));
      relay.stdout.emit("error", new Error("late"));
      relay.emit("close", null, "SIGTERM");
      expect(relay.listenerCount("error")).toBe(1);
      expect(relay.stdout.listenerCount("error")).toBe(1);
    },
  );
  it.each(["relay", "scheduler"] as const)(
    "restarts an unexpected clean %s exit",
    async (role) => {
      const s = setup();
      await s.manager.start();
      s.byRole(role)[0].exit(0);
      await tick();
      expect(s.events.at(-1)).toMatchObject({
        state: "restarting",
        reason: "retry_clean_exit",
      });
      s.waits[0].resolve();
      await tick();
      expect(s.byRole(role)).toHaveLength(2);
    },
  );
  it("consumes the failure budget on repeated relay signals", async () => {
    const s = setup();
    await s.manager.start();
    for (const ms of [500, 1000, 2000, 4000]) {
      s.byRole("relay").at(-1)!.exit(null, "SIGKILL");
      await tick();
      expect(s.waits.at(-1)!.ms).toBe(ms);
      s.waits.at(-1)!.resolve();
      await tick();
    }
    s.byRole("relay").at(-1)!.exit(null, "SIGKILL");
    await tick();
    expect(s.events.at(-1)).toMatchObject({
      state: "terminal",
      reason: "budget",
    });
    expect(s.byRole("relay")).toHaveLength(5);
    expect(s.maxRelay()).toBe(1);
  });
  it.each([4, 5, 6, 7])(
    "does not restart a replacement relay that exits %s",
    async (code) => {
      const s = setup();
      await s.manager.start();
      s.byRole("relay")[0].exit(null, "SIGKILL");
      await tick();
      s.waits[0].resolve();
      await tick();
      s.byRole("relay")[1].exit(code);
      await tick();
      expect(s.byRole("relay")).toHaveLength(2);
      expect(s.events.at(-1)).toMatchObject({ state: "terminal" });
      expect(s.waits).toHaveLength(1);
    },
  );
  it.each(["relay", "scheduler"] as const)(
    "retries a busy %s replacement after an unexpected exit and resets after stability",
    async (role) => {
      const s = setup();
      await s.manager.start();
      s.byRole(role)[0].exit(null, "SIGKILL");
      await tick();
      s.waits[0].resolve();
      await tick();
      s.byRole(role)[1].exit(2);
      await tick();
      expect(s.events.at(-1)).toEqual({
        role,
        state: "restarting",
        reason: "retry_busy_after_exit",
      });
      expect(s.waits[1].ms).toBe(1000);
      s.waits[1].resolve();
      await tick();
      s.advance(60_000);
      s.byRole(role)[2].exit(2);
      await tick();
      expect(s.events.at(-1)).toEqual({
        role,
        state: "terminal",
        reason: "terminal_busy",
      });
      expect(s.byRole(role)).toHaveLength(3);
      expect(s.maxRelay()).toBe(1);
      expect(s.maxScheduler()).toBe(1);
    },
  );
  it.each(["relay", "scheduler"] as const)(
    "bounds persistent busy %s replacements within the same failure budget",
    async (role) => {
      const s = setup();
      await s.manager.start();
      s.byRole(role)[0].exit(3);
      for (const [index, ms] of [500, 1000, 2000, 4000].entries()) {
        await tick();
        expect(s.waits[index].ms).toBe(ms);
        s.waits[index].resolve();
        await tick();
        s.byRole(role)[index + 1].exit(2);
      }
      await tick();
      expect(s.events.at(-1)).toEqual({
        role,
        state: "terminal",
        reason: "budget",
      });
      expect(s.byRole(role)).toHaveLength(5);
      expect(s.maxRelay()).toBe(1);
    },
  );
  it("cancels a busy replacement retry during backoff", async () => {
    const s = setup();
    await s.manager.start();
    s.byRole("relay")[0].exit(0);
    await tick();
    s.waits[0].resolve();
    await tick();
    s.byRole("relay")[1].exit(2);
    await tick();
    expect(s.events.at(-1)?.reason).toBe("retry_busy_after_exit");
    const stop = s.manager.stop();
    for (const c of s.children.filter((c) => c.alive)) c.exit();
    await stop;
    s.waits[1].resolve();
    await tick();
    expect(s.byRole("relay")).toHaveLength(2);
  });
  it("does not restart a signal during stop", async () => {
    const s = setup();
    await s.manager.start();
    const stop = s.manager.stop();
    for (const c of s.children) c.exit(null, "SIGTERM");
    await stop;
    await tick();
    expect(s.byRole("relay")).toHaveLength(1);
    expect(s.byRole("scheduler")).toHaveLength(1);
    expect(s.events.filter((e) => e.state === "restarting")).toHaveLength(0);
  });
  it("cancels a relay signal restart during backoff", async () => {
    const s = setup();
    await s.manager.start();
    s.byRole("relay")[0].exit(null, "SIGKILL");
    await tick();
    const stop = s.manager.stop();
    for (const c of s.children.filter((c) => c.alive)) c.exit();
    await stop;
    await tick();
    expect(s.byRole("relay")).toHaveLength(1);
  });

  it("bounds owned pipes independently of child close across restart and stop", async () => {
    vi.useFakeTimers();
    try {
      const s = setup();
      await s.manager.start();
      const old = s.byRole("api")[0];
      const earlyDestroy = vi.spyOn(old.stderr, "destroy");
      old.stderr.emit("close");
      old.stderr.emit("close");
      old.exit(1);
      old.emit("close", 1, null);
      await tick();
      s.waits[0].resolve();
      await tick();
      expect(s.byRole("api")).toHaveLength(2);
      const stop = s.manager.stop();
      for (const child of s.children.slice(1)) child.exit();
      await stop;
      await vi.advanceTimersByTimeAsync(5_001);
      expect(old.stdout.destroyed).toBe(true);
      expect(earlyDestroy).not.toHaveBeenCalled();
      for (const child of s.children) {
        child.emit("error", new Error("private child error"));
        for (const stream of [child.stdout, child.stderr]) {
          stream.emit("error", new Error("private stream error"));
          stream.emit("close");
          stream.emit("close");
          stream.emit("error", new Error("private late error"));
        }
      }
      expect(JSON.stringify(s.events)).not.toContain("private");
      expect(s.byRole("api")).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not destroy output streams from an injected spawner without ownership", async () => {
    vi.useFakeTimers();
    try {
      const children: Fake[] = [];
      const manager = new RuntimeChildren({
        root: "/x",
        env: {},
        viteExists: () => true,
        spawn: (spec) => {
          const child = new Fake(spec.role);
          children.push(child);
          queueMicrotask(() => child.emit("spawn"));
          return child as unknown as ChildProcess;
        },
      });
      await manager.start();
      const stop = manager.stop();
      children.forEach((child) => child.exit());
      await stop;
      await vi.advanceTimersByTimeAsync(5_001);
      expect(
        children.every(
          (child) => !child.stdout.destroyed && !child.stderr.destroyed,
        ),
      ).toBe(true);
      children[0].stdout.emit("error", new Error("private"));
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports survivors when the final shutdown bound expires", async () => {
    const s = setup();
    await s.manager.start();
    const stop = s.manager.stop();
    for (const child of s.children.filter((c) => c.role !== "scheduler"))
      child.exit();
    await tick();
    s.waits.find((w) => w.ms === 15_000)!.resolve();
    await tick();
    s.waits.find((w) => w.ms === 2_000)!.resolve();
    await tick();
    s.waits.find((w) => w.ms === 5_000)!.resolve();
    expect(await stop).toEqual({
      forced: ["scheduler"],
      remaining: ["scheduler"],
    });
    s.byRole("scheduler")[0].exit();
  });
  it("backs off and stops after five rapid exits; stable lifetime resets history", async () => {
    const s = setup();
    await s.manager.start();
    for (const ms of [500, 1000, 2000, 4000]) {
      s.byRole("api").at(-1)!.exit(1);
      await tick();
      expect(s.waits.at(-1)!.ms).toBe(ms);
      s.waits.at(-1)!.resolve();
      await tick();
    }
    s.byRole("api").at(-1)!.exit(1);
    await tick();
    expect(s.events.at(-1)).toMatchObject({ reason: "budget" });
    const t = setup();
    await t.manager.start();
    t.byRole("api")[0].exit(1);
    await tick();
    t.waits[0].resolve();
    await tick();
    t.advance(60_000);
    t.byRole("api")[1].exit(1);
    await tick();
    expect(t.waits.at(-1)!.ms).toBe(500);
  });
  it("cancels restart on stop and sends only allowed IPC before forcing survivors", async () => {
    const s = setup();
    await s.manager.start();
    s.byRole("api")[0].exit(1);
    await tick();
    const stop = s.manager.stop();
    expect(s.manager.stop()).toBe(stop);
    expect(s.byRole("relay")[0].actions).toEqual(["shutdown"]);
    for (const c of s.children.filter(
      (c) => c.role !== "api" && c.role !== "relay",
    ))
      c.exit();
    await tick();
    s.waits.find((w) => w.ms === 15_000)!.resolve();
    await tick();
    expect(s.byRole("relay")[0].actions).toEqual(["shutdown", "force"]);
    s.waits.find((w) => w.ms === 2_000)!.resolve();
    await tick();
    expect(s.byRole("relay")[0].actions).toEqual([
      "shutdown",
      "force",
      "SIGKILL",
    ]);
    s.byRole("relay")[0].exit();
    expect(await stop).toEqual({ forced: ["relay"], remaining: [] });
    expect(s.byRole("api")).toHaveLength(1);
    expect(JSON.stringify(s.events)).not.toContain("hidden");
    expect(JSON.stringify(s.events)).not.toContain("secret");
  });
  it("cleans prior children on initial spawn failure", async () => {
    const s = setup("worker");
    const start = s.manager.start();
    await tick();
    expect(s.byRole("api")[0].actions).toEqual(["SIGTERM"]);
    s.byRole("api")[0].exit();
    await expect(start).rejects.toThrow("startup_failure");
    expect(s.children).toHaveLength(2);
  });
  it.each([
    [0, null],
    [null, "SIGTERM"],
  ] as const)("restarts persistent exits", async (code, signal) => {
    const s = setup();
    await s.manager.start();
    s.byRole("frontend")[0].exit(code, signal);
    await tick();
    s.waits[0].resolve();
    await tick();
    expect(s.byRole("frontend")).toHaveLength(2);
  });
  it("cancels pending spawn and reports survivor", async () => {
    const child = new Fake("api");
    const manager = new RuntimeChildren({
      root: "/x",
      env: {},
      spawn: () => child as unknown as ChildProcess,
      shutdownMs: 0,
      forceMs: 0,
      finalMs: 0,
    });
    const start = manager.start();
    const stop = manager.stop();
    expect(manager.stop()).toBe(stop);
    await expect(start).rejects.toThrow("startup_failure");
    expect(await stop).toEqual({ forced: ["api"], remaining: ["api"] });
    expect(child.actions).toEqual(["SIGTERM", "SIGKILL"]);
    child.exit();
    child.emit("close", 0, null);
  });
  it("handles synchronous spawn throw", async () => {
    const manager = new RuntimeChildren({
      root: "/x",
      env: {},
      spawn: () => {
        throw new Error("secret");
      },
    });
    await expect(manager.start()).rejects.toThrow("startup_failure");
  });
  it("rejects missing Vite before spawning frontend", async () => {
    const children: Fake[] = [];
    const manager = new RuntimeChildren({
      root: "/x",
      env: {},
      viteExists: () => false,
      spawn: (spec) => {
        const child = new Fake(spec.role);
        children.push(child);
        queueMicrotask(() => child.emit("spawn"));
        child.kill = () => {
          queueMicrotask(() => child.exit());
          return true;
        };
        child.send = () => {
          queueMicrotask(() => child.exit());
          return true;
        };
        return child as unknown as ChildProcess;
      },
    });
    await expect(manager.start()).rejects.toThrow("startup_failure");
    expect(children.map((c) => c.role)).toEqual([
      "api",
      "worker",
      "relay",
      "scheduler",
    ]);
  });
  it.each(["throw", "callback"] as const)(
    "reports %s IPC failures without claiming exit and continues escalation",
    async (mode) => {
      const s = setup();
      await s.manager.start();
      const relay = s.byRole("relay")[0];
      relay.send = (message, callback) => {
        relay.actions.push(message);
        if (mode === "throw") throw new Error("secret");
        callback?.(new Error("secret"));
        return false;
      };
      const stop = s.manager.stop();
      expect(relay.alive).toBe(true);
      expect(s.events.filter((e) => e.role === "relay").at(-1)).toEqual({
        role: "relay",
        state: "control_failed",
        reason: "ipc_failure",
      });
      for (const c of s.children.filter((c) => c !== relay)) c.exit();
      await tick();
      s.waits.find((w) => w.ms === 15_000)!.resolve();
      await tick();
      expect(relay.actions).toEqual(["shutdown", "force"]);
      expect(
        s.events.filter(
          (e) => e.role === "relay" && e.state === "control_failed",
        ),
      ).toHaveLength(2);
      expect(
        s.events.filter((e) => e.role === "relay" && e.state === "stopped"),
      ).toHaveLength(0);
      s.waits.find((w) => w.ms === 2_000)!.resolve();
      await tick();
      expect(relay.actions).toContain("SIGKILL");
      relay.exit();
      await stop;
      await tick();
      relay.emit("close", 0, null);
      expect(
        s.events.filter((e) => e.role === "relay" && e.state === "stopped"),
      ).toEqual([{ role: "relay", state: "stopped", reason: "shutdown" }]);
      expect(JSON.stringify(s.events)).not.toContain("secret");
    },
  );
  it("reports a restart launch failure without overlapping children", async () => {
    const events: ChildEvent[] = [];
    const waits: (() => void)[] = [];
    const children: Fake[] = [];
    const manager = new RuntimeChildren({
      root: "/x",
      env: {},
      viteExists: () => true,
      onEvent: (event) => events.push(event),
      wait: (_ms, signal) =>
        new Promise<void>((resolve) => {
          waits.push(resolve);
          signal.addEventListener("abort", () => resolve(), { once: true });
        }),
      spawn: (spec) => {
        if (spec.role === "api" && children.some((c) => c.role === "api"))
          throw new Error("secret");
        const child = new Fake(spec.role);
        children.push(child);
        queueMicrotask(() => child.emit("spawn"));
        return child as unknown as ChildProcess;
      },
    });
    await manager.start();
    children[0].exit(0);
    await tick();
    waits[0]();
    await tick();
    expect(children.filter((c) => c.role === "api")).toHaveLength(1);
    expect(events.at(-1)).toEqual({
      role: "api",
      state: "terminal",
      reason: "startup_failure",
    });
    expect(JSON.stringify(events)).not.toContain("secret");
  });
});
