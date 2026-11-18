import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import {
  executable,
  installParentControls,
} from "../src/runtime-executable.js";

describe("executable boundary", () => {
  it.each([
    ["relay", "--daemon"],
    ["scheduler", "--one-shot"],
    ["relay"],
    ["scheduler", "--daemon"],
  ])("routes %j", async (...args) => {
    const run = vi.fn(async (args: string[], controls: unknown) => {
      void args;
      void controls;
    });
    const load = vi.fn(async () => ({ run }));
    await executable(args, load);
    expect(load).toHaveBeenCalledExactlyOnceWith(args[0]);
    expect(run).toHaveBeenCalledOnce();
    expect(run.mock.calls[0][0]).toEqual(args.slice(1));
  });
  it("queues force during import and handles runner rejection without leaking listeners", async () => {
    const beforeMessage = process.listenerCount("message");
    const beforeDisconnect = process.listenerCount("disconnect");
    const exit = vi.fn(),
      log = vi.fn();
    let resolveLoad!: (runner: {
      run: (
        args: string[],
        controls: import("../src/runtime-entrypoint.js").RuntimeControls,
      ) => Promise<void>;
    }) => void;
    const load = () =>
      new Promise<{
        run: (
          args: string[],
          controls: import("../src/runtime-entrypoint.js").RuntimeControls,
        ) => Promise<void>;
      }>((resolve) => {
        resolveLoad = resolve;
      });
    const running = executable(["relay"], load, log, exit);
    process.emit("message", "shutdown", undefined);
    process.emit("message", "force", undefined);
    resolveLoad({
      run: async (args, controls) => {
        void args;
        await Promise.resolve();
        expect(controls.signal.aborted).toBe(false);
        expect(controls.forceSignal.aborted).toBe(true);
        throw new Error("private");
      },
    });
    await running;
    expect(exit).toHaveBeenCalledExactlyOnceWith(4);
    expect(process.listenerCount("message")).toBe(beforeMessage);
    expect(process.listenerCount("disconnect")).toBe(beforeDisconnect);
  });
  it("handles real child IPC shutdown and exits naturally", async () => {
    const script = `
      import { executable } from './src/runtime-executable.ts';
      await executable(['relay'], async () => ({ run: async (_args, controls) => {
        process.send('ready');
        await new Promise(resolve => controls.signal.addEventListener('abort', resolve, { once: true }));
      }}));
      process.disconnect();
    `;
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", script],
      { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe", "ipc"] },
    );
    const result = await new Promise<{
      code: number | null;
      signal: NodeJS.Signals | null;
    }>((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error("child timed out"));
      }, 10000);
      child.on("message", (message) => {
        if (message === "ready") child.send("shutdown");
      });
      child.on("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on("exit", (code, signal) => {
        clearTimeout(timer);
        resolve({ code, signal });
      });
    });
    expect(result).toEqual({ code: 0, signal: null });
  });
  it.each(["import", "main", "invalid"])(
    "sanitizes %s failure and hard exits once",
    async (stage) => {
      const log = vi.fn(),
        exit = vi.fn();
      const load = vi.fn(async () => {
        if (stage === "import") throw new Error("secret import");
        return {
          run: async () => {
            throw new Error("secret main");
          },
        };
      });
      await executable(
        stage === "invalid" ? ["secret"] : ["relay"],
        load,
        log,
        exit,
      );
      expect(exit).toHaveBeenCalledExactlyOnceWith(4);
      expect(log).toHaveBeenCalledExactlyOnceWith(
        '{"event":"runtime_boundary_failure","outcome":"fatal"}',
      );
      expect(JSON.stringify(log.mock.calls)).not.toContain("secret");
      if (stage === "invalid") expect(load).not.toHaveBeenCalled();
    },
  );
});

describe("parent IPC controls", () => {
  function setup() {
    const source = new EventEmitter();
    const shutdown = vi.fn(),
      force = vi.fn();
    const controls = installParentControls(source);
    const target = {
      signal: new AbortController().signal,
      forceSignal: new AbortController().signal,
      requestShutdown: shutdown,
      requestForce: force,
    };
    return { source, shutdown, force, controls, target };
  }
  it("queues disconnect and coalesces shutdown, then cleans up", () => {
    const t = setup();
    t.source.emit("disconnect");
    expect(t.shutdown).not.toHaveBeenCalled();
    t.controls.start(t.target);
    t.source.emit("message", "shutdown");
    expect(t.shutdown).toHaveBeenCalledOnce();
    t.controls.dispose();
    expect(t.source.listenerCount("message")).toBe(0);
    expect(t.source.listenerCount("disconnect")).toBe(0);
  });
  it("coalesces queued force over shutdown and ignores arbitrary messages", () => {
    const t = setup();
    t.source.emit("message", { command: "shutdown" });
    t.source.emit("message", "unexpected");
    t.source.emit("message", "shutdown");
    t.source.emit("message", "force");
    t.controls.start(t.target);
    t.source.emit("message", "force");
    t.source.emit("disconnect");
    expect(t.shutdown).not.toHaveBeenCalled();
    expect(t.force).toHaveBeenCalledOnce();
    t.controls.dispose();
  });
  it("delivers live force only once", () => {
    const t = setup();
    t.controls.start(t.target);
    t.source.emit("message", "force");
    t.source.emit("message", "force");
    expect(t.force).toHaveBeenCalledOnce();
    t.controls.dispose();
  });
});
