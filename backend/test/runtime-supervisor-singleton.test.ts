import { createServer, request, type Server } from "node:http";
import { connect } from "node:net";
import { describe, expect, it, vi } from "vitest";
import {
  acquireSupervisorSingleton,
  CONTROL_PORT,
  workspaceIdentity,
} from "../src/runtime-supervisor-singleton.js";

const captured = vi.hoisted(() => ({ servers: [] as Server[] }));
vi.mock("node:http", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:http")>();
  const create = (...args: Parameters<typeof original.createServer>) => {
    const server = original.createServer(...args);
    captured.servers.push(server);
    return server;
  };
  return { ...original, createServer: create };
});

const root = process.cwd();
async function call(
  port: number,
  path: string,
  method = "GET",
  headers: Record<string, string> = {},
  body = "",
) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = request(
      { host: "127.0.0.1", port, path, method, headers },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          text += chunk;
        });
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, body: text }),
        );
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}
describe("local supervisor singleton", () => {
  it.each(["timeout", "error"])(
    "rejects a stuck close on %s and retains the same promise",
    async (mode) => {
      const owner = await acquireSupervisorSingleton({
        workspaceRoot: root,
        onOpen: vi.fn(),
        testPort: 0,
      });
      if (owner.kind !== "owned") throw new Error("expected owner");
      const server = captured.servers.at(-1)!;
      const realClose = server.close.bind(server);
      const mock = vi.spyOn(server, "close").mockImplementation(((
        callback?: (error?: Error) => void,
      ) => {
        if (mode === "error")
          queueMicrotask(() => callback?.(new Error("secret")));
        return server;
      }) as typeof server.close);
      try {
        const first = owner.close();
        expect(owner.close()).toBe(first);
        await expect(first).rejects.toThrow("SINGLETON_CLOSE_STUCK");
        expect(owner.close()).toBe(first);
        await expect(owner.close()).rejects.toThrow("SINGLETON_CLOSE_STUCK");
        expect(
          JSON.parse((await call(owner.port, "/identity")).body).state,
        ).toBe("stopping");
      } finally {
        mock.mockRestore();
        await new Promise<void>((resolve, reject) =>
          realClose((error) => (error ? reject(error) : resolve())),
        );
      }
    },
  );
  it("uses the fixed default port and does not fall back when it is occupied", async () => {
    const server = createServer((_req, res) => res.end("foreign"));
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(CONTROL_PORT, "127.0.0.1", resolve);
    });
    try {
      expect(
        await acquireSupervisorSingleton({
          workspaceRoot: root,
          onOpen: vi.fn(),
        }),
      ).toEqual({ kind: "conflict", code: "PORT_CONFLICT" });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    const owner = await acquireSupervisorSingleton({
      workspaceRoot: root,
      onOpen: vi.fn(),
    });
    if (owner.kind !== "owned") throw new Error("expected default port owner");
    try {
      expect(owner.port).toBe(CONTROL_PORT);
    } finally {
      await owner.close();
    }
  });
  it("times out an idle partial request and survives an abrupt disconnect", async () => {
    const owner = await acquireSupervisorSingleton({
      workspaceRoot: root,
      onOpen: vi.fn(),
      testPort: 0,
    });
    if (owner.kind !== "owned") throw new Error("expected owner");
    try {
      const socket = connect(owner.port, "127.0.0.1");
      await new Promise<void>((resolve, reject) => {
        socket.once("connect", resolve);
        socket.once("error", reject);
      });
      socket.write("GET /identity HTTP/1.1\r\n");
      await new Promise<void>((resolve, reject) => {
        socket.once("close", () => resolve());
        socket.once("error", reject);
      });
      const abrupt = connect(owner.port, "127.0.0.1");
      await new Promise<void>((resolve, reject) => {
        abrupt.once("connect", resolve);
        abrupt.once("error", reject);
      });
      abrupt.destroy();
      expect((await call(owner.port, "/identity")).status).toBe(200);
    } finally {
      await owner.close();
    }
  });
  it("owns, identifies, reuses, validates requests and stops", async () => {
    expect(CONTROL_PORT).toBe(3210);
    const onOpen = vi.fn();
    const owner = await acquireSupervisorSingleton({
      workspaceRoot: root,
      onOpen,
      testPort: 0,
    });
    if (owner.kind !== "owned") throw new Error("expected owner");
    try {
      const identity = await call(owner.port, "/identity");
      expect(JSON.parse(identity.body)).toEqual({
        product: "intelifluxo",
        protocol: 1,
        workspace: await workspaceIdentity(root),
        state: "starting",
      });
      expect(identity.body).not.toContain(root);
      owner.setState("ready");
      expect(JSON.parse((await call(owner.port, "/identity")).body).state).toBe(
        "ready",
      );
      expect(
        await acquireSupervisorSingleton({
          workspaceRoot: root,
          onOpen: vi.fn(),
          testPort: owner.port,
          openExisting: true,
        }),
      ).toEqual({ kind: "existing", opened: true });
      expect(onOpen).toHaveBeenCalledTimes(1);
      expect(
        (await call(owner.port, "/identity", "GET", { host: "evil:123" }))
          .status,
      ).toBe(400);
      expect((await call(owner.port, "/identity?x=1")).status).toBe(404);
      expect((await call(owner.port, "/open", "GET")).status).toBe(405);
      expect(
        (
          await call(
            owner.port,
            "/open",
            "POST",
            { "content-length": "1" },
            "x",
          )
        ).status,
      ).toBe(400);
      owner.setState("stopping");
      expect((await call(owner.port, "/open", "POST")).status).toBe(503);
      expect(onOpen).toHaveBeenCalledTimes(1);
    } finally {
      await Promise.all([owner.close(), owner.close()]);
    }
  });
  it("rejects foreign, malformed and unresponsive port owners", async () => {
    for (const mode of ["foreign", "malformed", "timeout"]) {
      const server = createServer((_req, res) => {
        if (mode === "foreign") res.end(JSON.stringify({ product: "other" }));
        if (mode === "malformed") res.end("{");
      });
      await new Promise<void>((resolve) =>
        server.listen(0, "127.0.0.1", resolve),
      );
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("address");
      try {
        expect(
          await acquireSupervisorSingleton({
            workspaceRoot: root,
            onOpen: vi.fn(),
            testPort: address.port,
          }),
        ).toEqual({ kind: "conflict", code: "PORT_CONFLICT" });
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    }
  });
  it("allows only one simultaneous owner and sanitizes workspace failures", async () => {
    const reserve = createServer();
    await new Promise<void>((resolve) =>
      reserve.listen(0, "127.0.0.1", resolve),
    );
    const address = reserve.address();
    if (!address || typeof address === "string") throw new Error("address");
    await new Promise<void>((resolve) => reserve.close(() => resolve()));
    const results = await Promise.all(
      Array.from({ length: 2 }, () =>
        acquireSupervisorSingleton({
          workspaceRoot: root,
          onOpen: vi.fn(),
          testPort: address.port,
        }),
      ),
    );
    expect(results.filter((r) => r.kind === "owned")).toHaveLength(1);
    expect(
      results.filter((r) => r.kind === "existing" || r.kind === "conflict"),
    ).toHaveLength(1);
    for (const result of results)
      if (result.kind === "owned") await result.close();
    const failure = await acquireSupervisorSingleton({
      workspaceRoot: "secret-nonexistent-path",
      onOpen: vi.fn(),
      testPort: 0,
    });
    expect(failure).toEqual({ kind: "error", code: "WORKSPACE_UNAVAILABLE" });
    expect(JSON.stringify(failure)).not.toContain("secret");
  });
  it("uses the requested port without fallback and releases idle sockets on concurrent close", async () => {
    const owner = await acquireSupervisorSingleton({
      workspaceRoot: root,
      onOpen: vi.fn(),
      testPort: 0,
    });
    if (owner.kind !== "owned") throw new Error("expected owner");
    const socket = connect(owner.port, "127.0.0.1");
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    const closed = new Promise<void>((resolve) =>
      socket.once("close", () => resolve()),
    );
    try {
      const duplicate = await acquireSupervisorSingleton({
        workspaceRoot: root,
        onOpen: vi.fn(),
        testPort: owner.port,
      });
      expect(duplicate).toEqual({ kind: "existing", opened: false });
      const start = Date.now();
      const closing = owner.close();
      expect(owner.close()).toBe(closing);
      await Promise.all([closing, owner.close(), closed]);
      expect(Date.now() - start).toBeLessThan(2000);
      const replacement = await acquireSupervisorSingleton({
        workspaceRoot: root,
        onOpen: vi.fn(),
        testPort: owner.port,
      });
      expect(replacement.kind).toBe("owned");
      if (replacement.kind === "owned") {
        expect(replacement.port).toBe(owner.port);
        await replacement.close();
      }
    } finally {
      socket.destroy();
      await owner.close();
    }
  });
  it("rejects incompatible identity shapes and failed open responses", async () => {
    const identity = {
      product: "intelifluxo",
      protocol: 1,
      workspace: await workspaceIdentity(root),
      state: "ready",
    };
    for (const [body, status] of [
      [{ ...identity, workspace: "wrong" }, 200],
      [{ ...identity, protocol: 2 }, 200],
      [{ ...identity, state: "unknown" }, 200],
      [{ ...identity, extra: true }, 200],
      [identity, 503],
    ] as const) {
      const server = createServer((_req, res) => {
        res.statusCode = status;
        res.end(JSON.stringify(body));
      });
      await new Promise<void>((resolve) =>
        server.listen(0, "127.0.0.1", resolve),
      );
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("address");
      try {
        expect(
          await acquireSupervisorSingleton({
            workspaceRoot: root,
            onOpen: vi.fn(),
            testPort: address.port,
          }),
        ).toEqual({ kind: "conflict", code: "PORT_CONFLICT" });
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    }
    const server = createServer((req, res) => {
      if (req.url === "/identity") res.end(JSON.stringify(identity));
      else {
        res.statusCode = 500;
        res.end("secret");
      }
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("address");
    try {
      expect(
        await acquireSupervisorSingleton({
          workspaceRoot: root,
          onOpen: vi.fn(),
          testPort: address.port,
          openExisting: true,
        }),
      ).toEqual({ kind: "existing", opened: false });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
  it("sanitizes synchronous and asynchronous open failures and rejects chunked bodies", async () => {
    for (const onOpen of [
      () => {
        throw new Error("secret");
      },
      async () => {
        throw new Error("secret");
      },
    ]) {
      const owner = await acquireSupervisorSingleton({
        workspaceRoot: root,
        onOpen,
        testPort: 0,
      });
      if (owner.kind !== "owned") throw new Error("expected owner");
      try {
        owner.setState("ready");
        expect(await call(owner.port, "/open", "POST")).toEqual({
          status: 500,
          body: '{"code":"OPEN_FAILED"}',
        });
        expect(
          (
            await call(
              owner.port,
              "/open",
              "POST",
              { "transfer-encoding": "chunked" },
              "x".repeat(4096),
            )
          ).status,
        ).toBe(400);
      } finally {
        await owner.close();
      }
    }
  });
  it("only opens when ready and lets no-open duplicates reuse without opening", async () => {
    const onOpen = vi.fn();
    const owner = await acquireSupervisorSingleton({
      workspaceRoot: root,
      onOpen,
      testPort: 0,
    });
    if (owner.kind !== "owned") throw new Error("expected owner");
    try {
      for (const state of ["starting", "degraded"] as const) {
        owner.setState(state);
        expect(await call(owner.port, "/open", "POST")).toEqual({
          status: 503,
          body: '{"code":"NOT_READY"}',
        });
        expect(
          await acquireSupervisorSingleton({
            workspaceRoot: root,
            onOpen,
            testPort: owner.port,
            openExisting: true,
          }),
        ).toEqual({ kind: "existing", opened: false });
      }
      expect(
        await acquireSupervisorSingleton({
          workspaceRoot: root,
          onOpen,
          testPort: owner.port,
          openExisting: false,
        }),
      ).toEqual({ kind: "existing", opened: false });
      expect(onOpen).not.toHaveBeenCalled();
      owner.setState("ready");
      expect(
        await acquireSupervisorSingleton({
          workspaceRoot: root,
          onOpen,
          testPort: owner.port,
          openExisting: true,
        }),
      ).toEqual({ kind: "existing", opened: true });
      expect(onOpen).toHaveBeenCalledOnce();
    } finally {
      await owner.close();
    }
  });
  it("reports late listener errors once with a fixed code and degrades", async () => {
    const onListenerError = vi.fn();
    const owner = await acquireSupervisorSingleton({
      workspaceRoot: root,
      onOpen: vi.fn(),
      onListenerError,
      testPort: 0,
    });
    if (owner.kind !== "owned") throw new Error("expected owner");
    const server = captured.servers.at(-1);
    if (!server) throw new Error("missing server");
    try {
      server.emit("error", new Error("secret path"));
      server.emit("error", new Error("another secret"));
      expect(onListenerError).toHaveBeenCalledOnce();
      expect(onListenerError).toHaveBeenCalledWith("LISTENER_ERROR");
      expect(JSON.parse((await call(owner.port, "/identity")).body).state).toBe(
        "degraded",
      );
    } finally {
      await owner.close();
    }
    server.emit("error", new Error("after close"));
    expect(onListenerError).toHaveBeenCalledOnce();
  });
  it("does not report listener errors during intentional close", async () => {
    const onListenerError = vi.fn();
    const owner = await acquireSupervisorSingleton({
      workspaceRoot: root,
      onOpen: vi.fn(),
      onListenerError,
      testPort: 0,
    });
    if (owner.kind !== "owned") throw new Error("expected owner");
    const server = captured.servers.at(-1);
    if (!server) throw new Error("missing server");
    const closing = owner.close();
    server.emit("error", new Error("secret"));
    await closing;
    expect(onListenerError).not.toHaveBeenCalled();
  });
});
