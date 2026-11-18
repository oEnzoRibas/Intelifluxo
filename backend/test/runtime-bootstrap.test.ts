import { describe, expect, it, vi } from "vitest";
import { basename, dirname, resolve } from "node:path";
import { EventEmitter } from "node:events";
import { spawnSync, type spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import {
  bootstrapRuntime,
  type BootstrapOptions,
} from "../src/runtime-bootstrap.js";

function setup(mode: BootstrapOptions["mode"] = "managed-infra") {
  const controller = new AbortController();
  let time = 0;
  const command = vi.fn(
    async (_c: {
      executable: string;
      args: string[];
      cwd: string;
      env: NodeJS.ProcessEnv;
    }) => {
      void _c;
      return "success" as const;
    },
  );
  const preflight = vi.fn(async () => ({ state: "ready" as const }));
  const wait = vi.fn(async (ms: number) => {
    time += ms;
  });
  const options: BootstrapOptions = {
    mode,
    env: { DATABASE_URL: "secret-value" },
    databaseUrl: "secret-value",
    amqpUrl: "secret-value",
    signal: controller.signal,
    readinessWindowMs: 1000,
    dependencies: { command, preflight, wait, now: () => time },
  };
  return { options, command, preflight, wait, controller };
}
describe("runtime bootstrap", () => {
  it("uses fixed compose services and migrates only after readiness", async () => {
    const s = setup();
    const result = await bootstrapRuntime(s.options);
    const c = s.command.mock.calls[0][0];
    expect(c.executable).toBe("docker");
    expect(c.args.slice(0, 4)).toEqual([
      "compose",
      "--project-name",
      "intelifluxo-local",
      "-f",
    ]);
    expect(basename(c.args[4])).toBe("compose.yaml");
    expect(c.args.slice(5)).toEqual(["up", "-d", "postgres", "rabbitmq"]);
    expect(s.command.mock.calls[1][0].executable).toBe(process.execPath);
    expect(s.command.mock.calls[1][0].args).toEqual([
      "--import",
      "tsx",
      "src/migrate.ts",
    ]);
    expect(s.preflight.mock.invocationCallOrder[0]).toBeLessThan(
      s.command.mock.invocationCallOrder[1],
    );
    expect(s.command.mock.calls[1][0].env.DATABASE_URL).toBe("secret-value");
    expect(JSON.stringify(result)).not.toContain("secret-value");
    expect(result.reasonCode).toBe("ready");
  });
  it("skips compose in no-infra mode", async () => {
    const s = setup("no-infra");
    await bootstrapRuntime(s.options);
    expect(s.command).toHaveBeenCalledTimes(1);
  });
  it("stops on compose failure without exposing error", async () => {
    const s = setup();
    s.options.dependencies!.command = async () => {
      throw new Error("secret-value");
    };
    const r = await bootstrapRuntime(s.options);
    expect(r.reasonCode).toBe("compose_unavailable");
    expect(JSON.stringify(r)).not.toContain("secret-value");
    expect(s.preflight).not.toHaveBeenCalled();
  });
  it("retries with bounded backoff", async () => {
    const s = setup("no-infra");
    let n = 0;
    s.options.dependencies!.preflight = async () => ({
      state: ++n < 3 ? "unavailable" : "ready",
    });
    const r = await bootstrapRuntime(s.options);
    expect(r.attempts).toBe(3);
    expect(s.wait.mock.calls.map((x) => x[0])).toEqual([250, 500]);
    expect(s.command).toHaveBeenCalledTimes(1);
  });
  it("exhausts readiness window", async () => {
    const s = setup("no-infra");
    s.options.dependencies!.preflight = async () => ({ state: "unavailable" });
    expect((await bootstrapRuntime(s.options)).reasonCode).toBe(
      "dependency_unavailable",
    );
    expect(s.command).not.toHaveBeenCalled();
  });
  it("aborts during wait or probe", async () => {
    for (const during of ["wait", "probe"]) {
      const s = setup("no-infra");
      s.options.dependencies!.preflight = async () => {
        if (during === "probe") s.controller.abort();
        return { state: "unavailable" };
      };
      s.options.dependencies!.wait = async () => {
        s.controller.abort();
      };
      expect((await bootstrapRuntime(s.options)).reasonCode).toBe("aborted");
      expect(s.command).not.toHaveBeenCalled();
    }
  });
  it("reports migration failure and abort", async () => {
    for (const aborted of [false, true]) {
      const s = setup("no-infra");
      s.options.dependencies!.command = async () => {
        if (aborted) s.controller.abort();
        return "failure";
      };
      expect((await bootstrapRuntime(s.options)).reasonCode).toBe(
        aborted ? "aborted" : "migration_failed",
      );
    }
  });
  it("uses the authoritative database and strips hostile environment", async () => {
    const s = setup();
    s.options.env = {
      DATABASE_URL: "different",
      NODE_OPTIONS: "bad",
      NPM_CONFIG_PREFIX: "bad",
      TSX_TSCONFIG_PATH: "bad",
      DOCKER_HOST: "bad",
      DOCKER_CONTEXT: "bad",
      DOCKER_CONFIG: "bad",
      COMPOSE_FILE: "bad",
      COMPOSE_PROJECT_NAME: "bad",
      ProgramFiles: "bad",
      ProgramW6432: "bad",
      USERPROFILE: "bad",
      APPDATA: "bad",
      LOCALAPPDATA: "bad",
      SECRET: "bad",
    };
    let probed = "";
    s.options.dependencies!.preflight = async (options) => {
      probed = options.databaseUrl;
      return { state: "ready" };
    };
    await bootstrapRuntime(s.options);
    expect(probed).toBe(s.options.databaseUrl);
    for (const call of s.command.mock.calls)
      for (const key of [
        "NODE_OPTIONS",
        "NPM_CONFIG_PREFIX",
        "TSX_TSCONFIG_PATH",
        "DOCKER_HOST",
        "DOCKER_CONTEXT",
        "DOCKER_CONFIG",
        "COMPOSE_FILE",
        "COMPOSE_PROJECT_NAME",
        "USERPROFILE",
        "APPDATA",
        "LOCALAPPDATA",
        "SECRET",
      ])
        expect(call[0].env[key]).toBeUndefined();
    expect(s.command.mock.calls[0][0].env.DATABASE_URL).toBeUndefined();
    expect(s.command.mock.calls[1][0].env.DATABASE_URL).toBe(probed);
    for (const key of ["ProgramFiles", "ProgramW6432"]) {
      expect(s.command.mock.calls[0][0].env[key]).toBe(process.env[key]);
      expect(s.command.mock.calls[1][0].env[key]).toBeUndefined();
    }
  });
  it("uses host Windows plugin paths, never caller paths, only for Compose", async () => {
    vi.stubEnv("ProgramFiles", "trusted-program-files");
    vi.stubEnv("ProgramW6432", "trusted-program-w6432");
    try {
      const s = setup();
      s.options.env = {
        ProgramFiles: "hostile-program-files",
        ProgramW6432: "hostile-program-w6432",
      };
      await bootstrapRuntime(s.options);
      expect(s.command.mock.calls[0][0].env.ProgramFiles).toBe(
        "trusted-program-files",
      );
      expect(s.command.mock.calls[0][0].env.ProgramW6432).toBe(
        "trusted-program-w6432",
      );
      expect(s.command.mock.calls[1][0].env.ProgramFiles).toBeUndefined();
      expect(s.command.mock.calls[1][0].env.ProgramW6432).toBeUndefined();
    } finally {
      vi.unstubAllEnvs();
    }
  });
  it.skipIf(process.platform !== "win32" || process.env.INTEGRATION !== "1")(
    "discovers Windows Compose with the sanitized environment without starting services",
    async (context) => {
      const available = spawnSync("docker", ["compose", "version"], {
        stdio: "ignore",
        timeout: 10_000,
        windowsHide: true,
      });
      if (available.error || available.status !== 0) {
        context.skip();
        return;
      }
      const s = setup();
      await bootstrapRuntime(s.options);
      const command = s.command.mock.calls[0][0];
      const check = spawnSync(
        command.executable,
        [...command.args.slice(0, 5), "config", "--services"],
        {
          cwd: command.cwd,
          env: command.env,
          encoding: "utf8",
          timeout: 30_000,
          windowsHide: true,
          stdio: ["ignore", "pipe", "ignore"],
        },
      );
      // Never include raw command output or paths in assertion failures.
      expect(check.error === undefined).toBe(true);
      expect(check.status).toBe(0);
      const services = (check.stdout ?? "").trim().split(/\r?\n/).sort();
      expect(
        services.length === 2 &&
          services[0] === "postgres" &&
          services[1] === "rabbitmq",
      ).toBe(true);
    },
  );
  it("rejects missing or empty database URLs before commands", async () => {
    for (const value of [undefined, "", "  "]) {
      const s = setup();
      s.options.databaseUrl = value as string;
      expect((await bootstrapRuntime(s.options)).reasonCode).toBe(
        "dependency_unavailable",
      );
      expect(s.command).not.toHaveBeenCalled();
      expect(s.preflight).not.toHaveBeenCalled();
    }
  });
  it.each(["timeout", "abort"])(
    "waits for migration exit after %s and cleans listeners",
    async (kind) => {
      vi.useFakeTimers();
      try {
        const s = setup("no-infra");
        const child = new EventEmitter() as EventEmitter & {
          pid: number;
          kill: ReturnType<typeof vi.fn>;
        };
        child.pid = 123;
        child.kill = vi.fn();
        delete s.options.dependencies!.command;
        s.options.commandTimeoutMs = 10;
        s.options.dependencies!.spawn = vi.fn(
          () => child,
        ) as unknown as typeof spawn;
        const pending = bootstrapRuntime(s.options);
        await vi.advanceTimersByTimeAsync(0);
        if (kind === "abort") s.controller.abort();
        else await vi.advanceTimersByTimeAsync(10);
        expect(child.kill).toHaveBeenCalledTimes(1);
        let completed = false;
        void pending.then(() => {
          completed = true;
        });
        await vi.advanceTimersByTimeAsync(500);
        expect(completed).toBe(false);
        child.emit("exit", null);
        expect((await pending).reasonCode).toBe(
          kind === "abort" ? "aborted" : "migration_failed",
        );
        expect(child.listenerCount("exit")).toBe(0);
        expect(child.listenerCount("close")).toBe(0);
        expect(child.listenerCount("error")).toBe(1);
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    },
  );
  it("ignores late errors and repeated terminal events after exit and close", async () => {
    vi.useFakeTimers();
    try {
      const s = setup("no-infra");
      const child = Object.assign(new EventEmitter(), {
        pid: 123,
        kill: vi.fn(),
      });
      delete s.options.dependencies!.command;
      s.options.dependencies!.spawn = vi.fn(
        () => child,
      ) as unknown as typeof spawn;
      const pending = bootstrapRuntime(s.options);
      await vi.advanceTimersByTimeAsync(0);
      child.emit("exit", 0);
      const result = await pending;
      expect(result.reasonCode).toBe("ready");
      expect(() => child.emit("error", new Error("secret"))).not.toThrow();
      child.emit("exit", 1);
      child.emit("close", 1);
      child.emit("close", 1);
      expect(() => child.emit("error", new Error("secret"))).not.toThrow();
      expect(result.reasonCode).toBe("ready");
      expect(child.kill).not.toHaveBeenCalled();
      expect(child.listenerCount("error")).toBe(1);
      expect(child.listenerCount("exit")).toBe(0);
      expect(child.listenerCount("close")).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
  it("allows sequential successful bootstraps", async () => {
    const first = setup("no-infra");
    const second = setup("no-infra");
    expect((await bootstrapRuntime(first.options)).reasonCode).toBe("ready");
    expect((await bootstrapRuntime(second.options)).reasonCode).toBe("ready");
    expect(first.command).toHaveBeenCalledTimes(1);
    expect(second.command).toHaveBeenCalledTimes(1);
  });
  it("resolves the local tsx import from the backend directory", () => {
    const cwd = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    if (!existsSync(resolve(cwd, "node_modules", "tsx", "package.json")))
      return;
    const result = spawnSync(process.execPath, ["--import", "tsx", "-e", ""], {
      cwd,
      timeout: 10_000,
      env: { ...process.env, NODE_OPTIONS: "" },
      stdio: "ignore",
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
  });
  it("waits for compose termination and blocks concurrent bootstrap", async () => {
    vi.useFakeTimers();
    try {
      const s = setup();
      const child = new EventEmitter() as EventEmitter & {
        pid: number;
        kill: ReturnType<typeof vi.fn>;
      };
      child.pid = 123;
      child.kill = vi.fn();
      delete s.options.dependencies!.command;
      s.options.commandTimeoutMs = 10;
      s.options.dependencies!.spawn = vi.fn(
        () => child,
      ) as unknown as typeof spawn;
      const pending = bootstrapRuntime(s.options);
      await vi.advanceTimersByTimeAsync(10);
      const second = setup();
      expect((await bootstrapRuntime(second.options)).reasonCode).toBe(
        "dependency_unavailable",
      );
      expect(second.command).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1000);
      expect(child.kill.mock.calls.map((call) => call[0])).toEqual([
        "SIGTERM",
        "SIGKILL",
      ]);
      child.emit("close", null);
      expect((await pending).reasonCode).toBe("compose_unavailable");
      expect(s.preflight).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
  it("latches preflight cleanup stuck", async () => {
    vi.resetModules();
    const isolated = await import("../src/runtime-bootstrap.js");
    const s = setup("no-infra");
    s.options.dependencies!.preflight = async () => ({
      state: "cleanup_stuck",
    });
    expect((await isolated.bootstrapRuntime(s.options)).reasonCode).toBe(
      "cleanup_stuck",
    );
    const next = setup();
    expect((await isolated.bootstrapRuntime(next.options)).reasonCode).toBe(
      "cleanup_stuck",
    );
    expect(next.command).not.toHaveBeenCalled();
  });
  it("latches unproven exit and blocks later commands", async () => {
    vi.resetModules();
    const isolated = await import("../src/runtime-bootstrap.js");
    vi.useFakeTimers();
    try {
      const s = setup("no-infra");
      const child = new EventEmitter() as EventEmitter & {
        pid: number;
        kill: ReturnType<typeof vi.fn>;
      };
      child.pid = 123;
      child.kill = vi.fn();
      delete s.options.dependencies!.command;
      s.options.commandTimeoutMs = 10;
      const spawnChild = vi.fn(() => child);
      s.options.dependencies!.spawn = spawnChild as unknown as typeof spawn;
      const pending = isolated.bootstrapRuntime(s.options);
      await vi.advanceTimersByTimeAsync(10);
      s.controller.abort();
      await vi.advanceTimersByTimeAsync(2000);
      expect((await pending).reasonCode).toBe("cleanup_stuck");
      expect(child.kill.mock.calls.map((call) => call[0])).toEqual([
        "SIGTERM",
        "SIGKILL",
      ]);
      expect(vi.getTimerCount()).toBe(0);
      expect(child.listenerCount("exit")).toBe(0);
      expect(child.listenerCount("close")).toBe(0);
      expect(child.listenerCount("error")).toBe(1);
      expect(() => child.emit("error", new Error("secret"))).not.toThrow();
      child.emit("exit", 0);
      child.emit("close", 0);
      child.emit("close", 0);
      expect(() => child.emit("error", new Error("secret"))).not.toThrow();
      expect(child.kill).toHaveBeenCalledTimes(2);
      expect(vi.getTimerCount()).toBe(0);
      expect(
        (await isolated.bootstrapRuntime(setup().options)).reasonCode,
      ).toBe("cleanup_stuck");
      expect(spawnChild).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
