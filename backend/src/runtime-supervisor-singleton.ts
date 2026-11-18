import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { createServer, request, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import {
  initialSnapshot,
  SNAPSHOT_PATH,
  validSnapshot,
  type Snapshot,
} from "./runtime-status.js";

export const CONTROL_HOST = "127.0.0.1";
export const CONTROL_PORT = 3210;
export const IDENTITY_PATH = "/identity";
/** Loopback identity is best-effort and unauthenticated; local peers can spoof or replace it. */
export const LOCAL_IDENTITY_LIMITATION = "UNAUTHENTICATED_LOCAL_IDENTITY";
export type ListenerErrorCode = "LISTENER_ERROR";
export type SupervisorState = "starting" | "ready" | "degraded" | "stopping";
export type SingletonResult =
  | {
      kind: "owned";
      port: number;
      setState: (state: SupervisorState) => void;
      setSnapshot?: (snapshot: Snapshot) => void;
      close: () => Promise<void>;
    }
  | { kind: "existing"; opened: boolean }
  | { kind: "conflict"; code: "PORT_CONFLICT" }
  | { kind: "error"; code: "WORKSPACE_UNAVAILABLE" | "BIND_FAILED" };
const TIMEOUT = 1000;

/** Realpath resolves symlinks; Windows paths are case-folded for workspace identity. */
export async function workspaceIdentity(root: string): Promise<string> {
  try {
    const path = await realpath(root);
    return createHash("sha256")
      .update(process.platform === "win32" ? path.toLowerCase() : path)
      .digest("hex");
  } catch {
    throw new Error("WORKSPACE_UNAVAILABLE");
  }
}
function reply(res: ServerResponse, status: number, value: object): void {
  res.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
    connection: "close",
  });
  res.end(JSON.stringify(value));
}
function probe(
  port: number,
  method: "GET" | "POST",
  path: string,
): Promise<{ status: number; body: string } | null> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (value: { status: number; body: string } | null) => {
      if (!done) {
        done = true;
        clearTimeout(timer);
        req.destroy();
        resolve(value);
      }
    };
    const req = request(
      {
        host: CONTROL_HOST,
        port,
        method,
        path,
        headers: {
          host: `${CONTROL_HOST}:${port}`,
          connection: "close",
          ...(method === "POST" ? { "content-length": "0" } : {}),
        },
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          body += chunk;
          if (body.length > 1024) finish(null);
        });
        res.on("end", () => finish({ status: res.statusCode ?? 0, body }));
        res.on("error", () => finish(null));
      },
    );
    const timer = setTimeout(() => finish(null), TIMEOUT);
    req.on("error", () => finish(null));
    req.end();
  });
}
/** Acquire before starting children or infrastructure. testPort is exclusively for tests. */
export async function acquireSupervisorSingleton(options: {
  workspaceRoot: string;
  onOpen: () => void | Promise<void>;
  onListenerError?: (reasonCode: ListenerErrorCode) => void;
  openExisting?: boolean;
  testPort?: number;
}): Promise<SingletonResult> {
  let workspace: string;
  try {
    workspace = await workspaceIdentity(options.workspaceRoot);
  } catch {
    return { kind: "error", code: "WORKSPACE_UNAVAILABLE" };
  }
  const port = options.testPort ?? CONTROL_PORT;
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    return { kind: "error", code: "BIND_FAILED" };
  let state: SupervisorState = "starting";
  let snapshot = initialSnapshot();
  let actualPort = port;
  let closing: Promise<void> | undefined;
  const sockets = new Set<Socket>();
  const server = createServer({ maxHeaderSize: 4096 }, async (req, res) => {
    const host = req.headers.host;
    if (
      host !== `${CONTROL_HOST}:${actualPort}` &&
      host !== `localhost:${actualPort}`
    ) {
      reply(res, 400, { code: "INVALID_HOST" });
      return;
    }
    if (
      req.url !== IDENTITY_PATH &&
      req.url !== "/open" &&
      req.url !== SNAPSHOT_PATH
    ) {
      reply(res, 404, { code: "NOT_FOUND" });
      return;
    }
    if (
      ((req.url === IDENTITY_PATH || req.url === SNAPSHOT_PATH) &&
        req.method !== "GET") ||
      (req.url === "/open" && req.method !== "POST")
    ) {
      reply(res, 405, { code: "METHOD_NOT_ALLOWED" });
      return;
    }
    if (
      req.headers["transfer-encoding"] !== undefined ||
      (req.headers["content-length"] !== undefined &&
        req.headers["content-length"] !== "0")
    ) {
      reply(res, 400, { code: "BODY_NOT_ALLOWED" });
      return;
    }
    if (req.url === IDENTITY_PATH) {
      reply(res, 200, {
        product: "intelifluxo",
        protocol: 1,
        workspace,
        state,
      });
      return;
    }
    if (req.url === SNAPSHOT_PATH) {
      reply(res, 200, {
        product: "intelifluxo",
        protocol: 1,
        workspace,
        snapshot,
      });
      return;
    }
    if (state !== "ready") {
      reply(res, 503, { code: "NOT_READY" });
      return;
    }
    try {
      await options.onOpen();
    } catch {
      reply(res, 500, { code: "OPEN_FAILED" });
      return;
    }
    reply(res, 200, { code: "OPENED" });
  });
  server.headersTimeout = TIMEOUT;
  server.requestTimeout = TIMEOUT;
  server.keepAliveTimeout = TIMEOUT;
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.setTimeout(TIMEOUT, () => socket.destroy());
    socket.on("close", () => sockets.delete(socket));
  });
  let listenerErrorReported = false;
  const onRuntimeError = () => {
    if (closing || listenerErrorReported) return;
    listenerErrorReported = true;
    if (state !== "stopping") state = "degraded";
    try {
      options.onListenerError?.("LISTENER_ERROR");
    } catch {
      // Observer failures must not turn a sanitized listener error into a crash.
    }
  };
  const bindError = await new Promise<NodeJS.ErrnoException | null>(
    (resolve) => {
      server.once("error", resolve);
      server.listen(port, CONTROL_HOST, () => {
        server.on("error", onRuntimeError);
        server.removeListener("error", resolve);
        resolve(null);
      });
    },
  );
  if (bindError) {
    if (bindError.code !== "EADDRINUSE")
      return { kind: "error", code: "BIND_FAILED" };
    const response = await probe(port, "GET", IDENTITY_PATH);
    let identity: unknown;
    try {
      identity = response?.status === 200 ? JSON.parse(response.body) : null;
    } catch {
      identity = null;
    }
    if (!identity || typeof identity !== "object" || Array.isArray(identity))
      return { kind: "conflict", code: "PORT_CONFLICT" };
    const value = identity as Record<string, unknown>;
    if (
      Object.keys(value).sort().join(",") !==
        "product,protocol,state,workspace" ||
      value.product !== "intelifluxo" ||
      value.protocol !== 1 ||
      value.workspace !== workspace ||
      !["starting", "ready", "degraded", "stopping"].includes(
        String(value.state),
      )
    )
      return { kind: "conflict", code: "PORT_CONFLICT" };
    if (!options.openExisting) return { kind: "existing", opened: false };
    const opened = await probe(port, "POST", "/open");
    return {
      kind: "existing",
      opened: opened?.status === 200 && opened.body === '{"code":"OPENED"}',
    };
  }
  const address = server.address();
  if (address && typeof address !== "string") actualPort = address.port;
  return {
    kind: "owned",
    port: actualPort,
    setState: (next) => {
      if (state !== "stopping") state = next;
    },
    setSnapshot: (next) => {
      if (validSnapshot(next) && snapshot.state !== "stopping")
        snapshot = structuredClone(next);
    },
    close: () => {
      if (!closing) {
        state = "stopping";
        closing = new Promise<void>((resolve, reject) => {
          const fail = () => reject(new Error("SINGLETON_CLOSE_STUCK"));
          const timer = setTimeout(fail, TIMEOUT);
          try {
            server.close((error) => {
              clearTimeout(timer);
              if (error || server.listening) fail();
              else resolve();
            });
          } catch {
            clearTimeout(timer);
            fail();
          } finally {
            for (const socket of sockets) socket.destroy();
          }
        });
      }
      return closing;
    },
  };
}
