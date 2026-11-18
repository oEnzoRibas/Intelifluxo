import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ClientRequest, IncomingMessage } from "node:http";
import type { RequestOptions } from "node:https";
import { createServer, connect } from "node:net";
import { describe, expect, it, vi } from "vitest";
import {
  lookupViaCep,
  viacepTransportTestOnly as transport,
} from "../src/viacep-transport.js";

const good = [{ address: "8.8.8.8", family: 4 }];
type Setup = {
  answers?: typeof good;
  remote?: string;
  status?: number;
  headers?: Record<string, string>;
  chunks?: string[];
  truncated?: boolean;
  hang?: boolean;
  requestError?: string;
  rawHeaders?: string[];
  headersDistinct?: Record<string, string[]>;
  responseFirst?: boolean;
  streamEvent?: "aborted" | "error" | "close";
};
function fixture(config: Setup = {}) {
  let seen: RequestOptions | undefined;
  let destroyed = false;
  const deps = {
    resolve: async () => config.answers ?? good,
    request: (
      options: RequestOptions,
      callback: (res: IncomingMessage) => void,
    ) => {
      seen = options;
      const req = new EventEmitter() as ClientRequest;
      req.destroy = () => {
        destroyed = true;
        return req;
      };
      req.end = () => {
        queueMicrotask(() => {
          if (config.requestError) {
            req.emit(
              "error",
              Object.assign(new Error("secret"), { code: config.requestError }),
            );
            return;
          }
          const socket = new EventEmitter() as EventEmitter & {
            remoteAddress: string;
          };
          socket.remoteAddress = config.remote ?? "8.8.8.8";
          req.emit("socket", socket);
          if (!config.responseFirst) socket.emit("secureConnect");
          if (config.hang || destroyed) return;
          const res = new PassThrough() as PassThrough & IncomingMessage;
          res.statusCode = config.status ?? 200;
          res.headers = config.headers ?? {
            "content-type": "application/json",
          };
          res.complete = !config.truncated;
          if (config.rawHeaders) res.rawHeaders = config.rawHeaders;
          if (config.headersDistinct)
            res.headersDistinct = config.headersDistinct;
          callback(res);
          if (config.responseFirst) socket.emit("secureConnect");
          if (destroyed) return;
          if (config.streamEvent) {
            res.complete = false;
            if (config.streamEvent === "error")
              res.emit("error", new Error("secret"));
            else res.emit(config.streamEvent);
            return;
          }
          for (const chunk of config.chunks ?? ['{"erro":true}'])
            res.write(chunk);
          res.end();
        });
        return req;
      };
      return req;
    },
  };
  return {
    deps,
    get seen() {
      return seen;
    },
    get destroyed() {
      return destroyed;
    },
  };
}
const run = (config: Setup = {}) =>
  transport.run("01001000", {}, fixture(config).deps);

describe("ViaCEP fixed transport", () => {
  it.each([
    "0.1.2.3",
    "10.0.0.1",
    "100.64.0.1",
    "127.0.0.1",
    "169.254.169.254",
    "172.16.0.1",
    "192.168.1.1",
    "192.0.0.1",
    "192.0.2.1",
    "192.88.99.1",
    "198.18.0.1",
    "198.51.100.1",
    "203.0.113.1",
    "224.0.0.1",
    "255.255.255.255",
    "::",
    "::1",
    "fc00::1",
    "fe80::1",
    "ff00::1",
    "2001:db8::1",
    "2001::1",
    "2002::1",
    "::ffff:127.0.0.1",
    "64:ff9b::808:808",
    "not-ip",
  ])("rejects special address %s", (address) => {
    expect(transport.publicAddress(address)).toBe(false);
  });
  it.each(["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111", "::ffff:8.8.8.8"])(
    "accepts public address %s",
    (address) => {
      expect(transport.publicAddress(address)).toBe(true);
    },
  );
  it("pins the selected answer and fixes hostname, TLS and request properties", async () => {
    const f = fixture();
    expect(await transport.run("01001000", {}, f.deps)).toEqual({
      status: "not_found",
    });
    expect(f.seen).toMatchObject({
      hostname: "viacep.com.br",
      servername: "viacep.com.br",
      port: 443,
      path: "/ws/01001000/json/",
      method: "GET",
      agent: false,
      family: 4,
      autoSelectFamily: false,
      rejectUnauthorized: true,
      maxHeaderSize: 8192,
      headers: {
        host: "viacep.com.br",
        accept: "application/json",
        "accept-encoding": "identity",
      },
    });
    expect(f.seen?.lookup).toBeTypeOf("function");
    expect(f.seen).not.toHaveProperty("proxy");
    expect(f.seen?.checkServerIdentity).toBeTypeOf("function");
    expect(f.destroyed).toBe(true);
  });
  it("rejects a mixed answer set and socket mismatch", async () => {
    expect(
      await run({ answers: [...good, { address: "127.0.0.1", family: 4 }] }),
    ).toEqual({ status: "security_rejected" });
    expect(await run({ remote: "1.1.1.1" })).toEqual({
      status: "security_rejected",
    });
    expect(await run({ remote: "::ffff:8.8.8.8" })).toEqual({
      status: "not_found",
    });
    expect(await run({ answers: [] })).toEqual({ status: "security_rejected" });
  });
  it.each([
    [301, "http_permanent"],
    [404, "http_permanent"],
    [429, "http_transient"],
    [503, "http_transient"],
  ] as const)(
    "classifies HTTP %s without following redirects",
    async (status, expected) => {
      expect(await run({ status })).toEqual({ status: expected });
    },
  );
  it.each([
    { "content-type": "text/html" },
    { "content-type": "application/json", "content-encoding": "gzip" },
    { "content-type": "application/json", "content-length": "16385" },
    { "content-type": "application/json", "content-length": "abc" },
  ])("rejects headers %o", async (headers) => {
    expect(
      await run({ headers: headers as unknown as Record<string, string> }),
    ).toEqual({
      status: "invalid_response",
    });
  });
  it("enforces streaming byte limits, truncation and projection", async () => {
    const body = '{"erro":true}' + " ".repeat(16384 - 13);
    expect(Buffer.byteLength(body)).toBe(16384);
    expect(
      await run({ chunks: [body.slice(0, 100), body.slice(100)] }),
    ).toEqual({ status: "not_found" });
    expect(await run({ chunks: [body, " "] })).toEqual({
      status: "invalid_response",
    });
    expect(await run({ chunks: ["{"] })).toEqual({
      status: "invalid_response",
    });
    expect(await run({ truncated: true })).toEqual({
      status: "transport",
    });
    expect(await run({ chunks: ['{"cep":"01001-000","uf":"SP"}'] })).toEqual({
      status: "found",
      address: { cep: "01001-000", uf: "SP" },
    });
  });
  it("handles deadline, abort and network failure without leaking errors", async () => {
    const f = fixture({ hang: true });
    expect(await transport.run("01001000", { timeoutMs: 5 }, f.deps)).toEqual({
      status: "timeout",
    });
    expect(f.destroyed).toBe(true);
    const controller = new AbortController();
    controller.abort();
    expect(
      await transport.run(
        "01001000",
        { signal: controller.signal },
        fixture().deps,
      ),
    ).toEqual({ status: "timeout" });
    expect(await run({ requestError: "ECONNRESET" })).toEqual({
      status: "transport",
    });
    expect(await transport.run("01001000/", {}, fixture().deps)).toEqual({
      status: "security_rejected",
    });
  });
  it.each([
    "ERR_TLS_CERT_ALTNAME_INVALID",
    "CERT_HAS_EXPIRED",
    "CERT_NOT_YET_VALID",
    "DEPTH_ZERO_SELF_SIGNED_CERT",
    "SELF_SIGNED_CERT_IN_CHAIN",
    "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
    "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
    "CERT_REVOKED",
    "CERT_CHAIN_TOO_LONG",
    "CERT_SIGNATURE_FAILURE",
    "CERTIFICATE_VERIFY_FAILED",
    "ERR_TLS_CERT_SIGNATURE_ALGORITHM_UNSUPPORTED",
    "UNABLE_TO_GET_CRL_ISSUER",
    "UNABLE_TO_DECRYPT_CRL_SIGNATURE",
    "INVALID_CA",
    "INVALID_PURPOSE",
    "PATH_LENGTH_EXCEEDED",
    "HOSTNAME_MISMATCH",
    "CRL_HAS_EXPIRED",
    "KEYUSAGE_NO_CERTSIGN",
    "CA_MD_TOO_WEAK",
    "UNHANDLED_CRITICAL_EXTENSION",
  ])(
    "rejects TLS validation error %s without exposing it",
    async (requestError) => {
      expect(await run({ requestError })).toEqual({
        status: "security_rejected",
      });
    },
  );
  it.each([
    "ECONNRESET",
    "ECONNREFUSED",
    "ETIMEDOUT",
    "EAI_AGAIN",
    "ENOTFOUND",
    "OUT_OF_MEM",
    "UNABLE_TO_ALLOCATE_MEMORY",
    "ERR_TLS_HANDSHAKE_TIMEOUT",
  ])(
    "classifies %s as transport without exposing errors",
    async (requestError) => {
      expect(await run({ requestError })).toEqual({ status: "transport" });
    },
  );
  it.each(["aborted", "error", "close"] as const)(
    "classifies %s as transport",
    async (streamEvent) => {
      expect(await run({ streamEvent })).toEqual({ status: "transport" });
    },
  );
  it("rejects response before secureConnect and duplicate headers", async () => {
    expect(await run({ responseFirst: true })).toEqual({
      status: "security_rejected",
    });
    for (const name of ["Content-Type", "Content-Encoding", "Content-Length"]) {
      expect(
        await run({ rawHeaders: [name, "a", name.toLowerCase(), "b"] }),
      ).toEqual({ status: "invalid_response" });
    }
    expect(
      await run({
        headersDistinct: {
          "content-type": ["application/json", "application/json"],
        },
      }),
    ).toEqual({ status: "invalid_response" });
    expect(
      await run({
        headers: { "content-type": "application/json", "content-length": "20" },
      }),
    ).toEqual({ status: "transport" });
  });
  it("does not start a request after DNS completes late, and cleans up on abort", async () => {
    let resolveDns!: (answers: typeof good) => void;
    const f = fixture({ hang: true });
    let requested = false;
    const pending = transport.run(
      "01001000",
      { timeoutMs: 5 },
      {
        ...f.deps,
        resolve: () =>
          new Promise((resolve) => {
            resolveDns = resolve;
          }),
        request: (...args) => {
          requested = true;
          return f.deps.request(...args);
        },
      },
    );
    expect(await pending).toEqual({ status: "timeout" });
    resolveDns(good);
    await Promise.resolve();
    expect(requested).toBe(false);
    const controller = new AbortController();
    const active = transport.run(
      "01001000",
      { signal: controller.signal },
      f.deps,
    );
    await new Promise((resolve) => setImmediate(resolve));
    controller.abort();
    expect(await active).toEqual({ status: "timeout" });
    expect(f.destroyed).toBe(true);
  });
  it.each([
    { address: "8.8.8.8", family: 4 },
    { address: "2606:4700:4700::1111", family: 6 },
  ])("supports ordinary and all lookup callbacks for $address", (selected) => {
    const lookup = transport.pinnedLookup(selected);
    const calls: unknown[][] = [];
    const cb = ((...args: unknown[]) => calls.push(args)) as Parameters<
      typeof lookup
    >[2];
    lookup("viacep.com.br", { family: selected.family, all: false }, cb);
    lookup("viacep.com.br", { family: selected.family, all: true }, cb);
    expect(calls).toEqual([
      [null, selected.address, selected.family],
      [null, [selected]],
    ]);
  });
  it("uses pinned lookup with Node networking and closes the local fixture", async () => {
    const server = createServer((socket) => socket.end());
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    try {
      const address = server.address();
      if (!address || typeof address === "string")
        throw new Error("missing listener");
      let calls = 0;
      const pinned = transport.pinnedLookup({
        address: "127.0.0.1",
        family: 4,
      });
      const socket = connect({
        host: "fixture.invalid",
        port: address.port,
        family: 4,
        autoSelectFamily: false,
        lookup: (...args) => {
          calls++;
          pinned(...args);
        },
      });
      await new Promise<void>((resolve, reject) => {
        socket.on("error", reject);
        socket.on("close", () => resolve());
      });
      expect(calls).toBe(1);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      );
    }
  });
  it.each([0, 1, 999, 10001, 30000, NaN])(
    "rejects production timeout %s",
    async (timeoutMs) => {
      expect(await lookupViaCep("01001000", { timeoutMs })).toEqual({
        status: "security_rejected",
      });
    },
  );
});

it("observes only a completed body and reports bounded HTTP classes once", async () => {
  for (const [config, expected] of [
    [{}, { httpClass: "2xx", bodyBytes: 13 }],
    [{ status: 503 }, { httpClass: "5xx" }],
    [{ truncated: true }, { httpClass: "2xx" }],
    [{ requestError: "secret" }, { httpClass: "none" }],
    [{ headers: { "content-type": "text/plain" } }, { httpClass: "2xx" }],
  ] as const) {
    const observe = vi.fn();
    await transport.run("01001000", { observe }, fixture(config).deps);
    expect(observe).toHaveBeenCalledTimes(1);
    expect(observe).toHaveBeenCalledWith(expected);
  }
});

it.each([
  [{ hang: true }, "none"],
  [{ answers: [{ address: "127.0.0.1", family: 4 }] }, "none"],
  [{ chunks: ["x".repeat(40000)] }, "2xx"],
  [{ streamEvent: "aborted" }, "2xx"],
  [{ status: 404 }, "4xx"],
] satisfies Array<[Setup, string]>)(
  "observes failure exactly once without body bytes",
  async (config, httpClass) => {
    const observe = vi.fn(() => {
      throw new Error("observer-secret");
    });
    await expect(
      transport.run(
        "01001000",
        { observe, timeoutMs: 5 },
        fixture(config).deps,
      ),
    ).resolves.toBeDefined();
    expect(observe).toHaveBeenCalledTimes(1);
    expect(observe).toHaveBeenCalledWith({ httpClass });
  },
);
