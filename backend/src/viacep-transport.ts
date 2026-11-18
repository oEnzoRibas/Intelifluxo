import { lookup } from "node:dns/promises";
import { request, type RequestOptions } from "node:https";
import { BlockList, isIP } from "node:net";
import { checkServerIdentity } from "node:tls";
import type { ClientRequest, IncomingMessage } from "node:http";
import {
  normalizeCep,
  projectViaCep,
  VIACEP_BODY_LIMIT,
  type ViaCepProjection,
} from "./viacep-projection.js";

import type { HttpClass } from "./worker-telemetry.js";

type Observation = { httpClass: HttpClass; bodyBytes?: number };
type TransportOptions = {
  signal?: AbortSignal;
  timeoutMs?: number;
  observe?: (observation: Observation) => void;
};

type Failure =
  | "timeout"
  | "transport"
  | "http_transient"
  | "http_permanent"
  | "invalid_response"
  | "security_rejected"
  | "unknown";
export type ViaCepResult = ViaCepProjection | { status: Failure };
type Answer = { address: string; family: number };
type Dependencies = {
  resolve: () => Promise<Answer[]>;
  request: (
    options: RequestOptions,
    callback: (response: IncomingMessage) => void,
  ) => ClientRequest;
};
const production: Dependencies = {
  resolve: () => lookup("viacep.com.br", { all: true, verbatim: true }),
  request,
};

// Conservative IANA special-purpose exclusions. IPv6 is restricted to global
// unicast and excludes transition, benchmarking, documentation and protocol ranges.
const blocked = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.31.196.0", 24],
  ["192.52.193.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["192.175.48.0", 24],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const)
  blocked.addSubnet(address, prefix, "ipv4");
const global6 = new BlockList();
global6.addSubnet("2000::", 3, "ipv6");
const blocked6 = new BlockList();
for (const [address, prefix] of [
  ["2001::", 23],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["2620:4f:8000::", 48],
  ["3fff::", 20],
] as const)
  blocked6.addSubnet(address, prefix, "ipv6");

function canonical(address: string): string | null {
  const family = isIP(address);
  if (family === 4) return address;
  if (family !== 6 || address.includes("%")) return null;
  const host = new URL(`http://[${address}]/`).hostname.slice(1, -1);
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(host);
  if (mapped) {
    const a = parseInt(mapped[1], 16),
      b = parseInt(mapped[2], 16);
    return `${a >> 8}.${a & 255}.${b >> 8}.${b & 255}`;
  }
  return host;
}
function publicAddress(address: string): boolean {
  const normalized = canonical(address);
  if (!normalized) return false;
  if (isIP(normalized) === 4) return !blocked.check(normalized, "ipv4");
  return (
    global6.check(normalized, "ipv6") && !blocked6.check(normalized, "ipv6")
  );
}

/** Fixed production transport; neither origin nor network dependencies are configurable. */
export function lookupViaCep(
  cep: string,
  options: TransportOptions = {},
): Promise<ViaCepResult> {
  if (
    options.timeoutMs !== undefined &&
    (!Number.isSafeInteger(options.timeoutMs) ||
      options.timeoutMs < 1000 ||
      options.timeoutMs > 10000)
  ) {
    try {
      options.observe?.({ httpClass: "none" });
    } catch {
      /* observational only */
    }
    return Promise.resolve({ status: "security_rejected" });
  }
  return run(cep, options, production);
}

// Explicit test-only seam. Production callers must use lookupViaCep.
export const viacepTransportTestOnly = { publicAddress, run, pinnedLookup };

function pinnedLookup(selected: Answer): NonNullable<RequestOptions["lookup"]> {
  return (_hostname, options, callback) => {
    if (typeof options === "object" && options.all) {
      (callback as (error: null, addresses: Answer[]) => void)(null, [
        selected,
      ]);
    } else {
      callback(null, selected.address, selected.family);
    }
  };
}

const certificateErrors = new Set([
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "UNABLE_TO_GET_CRL",
  "UNABLE_TO_GET_CRL_ISSUER",
  "UNABLE_TO_DECRYPT_CERT_SIGNATURE",
  "UNABLE_TO_DECRYPT_CRL_SIGNATURE",
  "UNABLE_TO_DECODE_ISSUER_PUBLIC_KEY",
  "UNABLE_TO_GET_ISSUER_CERT_IN_CHAIN",
  "CRL_SIGNATURE_FAILURE",
  "CRL_NOT_YET_VALID",
  "CRL_HAS_EXPIRED",
  "ERROR_IN_CERT_NOT_BEFORE_FIELD",
  "ERROR_IN_CERT_NOT_AFTER_FIELD",
  "ERROR_IN_CRL_LAST_UPDATE_FIELD",
  "ERROR_IN_CRL_NEXT_UPDATE_FIELD",
  "INVALID_CA",
  "PATH_LENGTH_EXCEEDED",
  "INVALID_PURPOSE",
  "CERTIFICATE_VERIFY_FAILED",
  "HOSTNAME_MISMATCH",
  "EMAIL_MISMATCH",
  "IP_ADDRESS_MISMATCH",
  "DANE_NO_MATCH",
  "INVALID_NON_CA",
  "KEYUSAGE_NO_CERTSIGN",
  "KEYUSAGE_NO_CRL_SIGN",
  "KEYUSAGE_NO_DIGITAL_SIGNATURE",
  "UNHANDLED_CRITICAL_EXTENSION",
  "UNHANDLED_CRITICAL_CRL_EXTENSION",
  "INVALID_EXTENSION",
  "INVALID_POLICY_EXTENSION",
  "NO_EXPLICIT_POLICY",
  "DIFFERENT_CRL_SCOPE",
  "UNSUPPORTED_EXTENSION_FEATURE",
  "UNNESTED_RESOURCE",
  "PERMITTED_VIOLATION",
  "EXCLUDED_VIOLATION",
  "SUBTREE_MINMAX",
  "UNSUPPORTED_CONSTRAINT_TYPE",
  "UNSUPPORTED_CONSTRAINT_SYNTAX",
  "UNSUPPORTED_NAME_SYNTAX",
  "CRL_PATH_VALIDATION_ERROR",
  "APPLICATION_VERIFICATION",
  "EE_KEY_TOO_SMALL",
  "CA_KEY_TOO_SMALL",
  "CA_MD_TOO_WEAK",
  "ISSUER_NAME_MISMATCH",
  "AKID_SKID_MISMATCH",
  "AKID_ISSUER_SERIAL_MISMATCH",
  "SUBJECT_ISSUER_MISMATCH",
  "PATH_LOOP",
  "NO_VALID_SCTS",
  "PROXY_CERTIFICATES_NOT_ALLOWED",
  "PROXY_PATH_LENGTH_EXCEEDED",
]);
// Match certificate-specific families, not arbitrary TLS or UNABLE_TO errors:
// those can represent networking or resource failures rather than verification.
function certificateVerificationError(code: string): boolean {
  return (
    /^ERR_TLS_CERT_[A-Z0-9_]+$/.test(code) ||
    /^CERT_[A-Z0-9_]+$/.test(code) ||
    certificateErrors.has(code)
  );
}
function requestFailure(error: unknown): Failure {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? error.code
      : undefined;
  return typeof code === "string" && certificateVerificationError(code)
    ? "security_rejected"
    : "transport";
}

function duplicateHeaders(res: IncomingMessage): boolean {
  const names = ["content-type", "content-encoding", "content-length"];
  if (names.some((name) => (res.headersDistinct?.[name]?.length ?? 0) > 1))
    return true;
  const counts = new Map<string, number>();
  for (let i = 0; i < (res.rawHeaders?.length ?? 0); i += 2) {
    const name = res.rawHeaders[i].toLowerCase();
    if (names.includes(name)) counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return [...counts.values()].some((count) => count > 1);
}

async function run(
  cep: string,
  options: TransportOptions,
  deps: Dependencies,
): Promise<ViaCepResult> {
  const reject = (): ViaCepResult => {
    try {
      options.observe?.({ httpClass: "none" });
    } catch {
      /* observational only */
    }
    return { status: "security_rejected" };
  };
  if (normalizeCep(cep) !== cep) return reject();
  const timeoutMs = options.timeoutMs ?? 5000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 30_000)
    return reject();
  return new Promise((resolve) => {
    let done = false;
    let httpClass: HttpClass = "none";
    let bodyBytes: number | undefined;
    let req: ClientRequest | undefined;
    let response: IncomingMessage | undefined;
    const finish = (status: ViaCepResult) => {
      if (done) return;
      done = true;
      try {
        options.observe?.(
          bodyBytes === undefined ? { httpClass } : { httpClass, bodyBytes },
        );
      } catch {
        /* observational only */
      }
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      response?.destroy();
      req?.destroy();
      resolve(status);
    };
    const abort = () => finish({ status: "timeout" });
    const timer = setTimeout(abort, timeoutMs);
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) {
      abort();
      return;
    }
    void (async () => {
      let answers: Answer[];
      try {
        answers = await deps.resolve();
      } catch {
        finish({ status: "transport" });
        return;
      }
      if (done) return;
      if (
        !Array.isArray(answers) ||
        !answers.length ||
        answers.some(
          (a) =>
            !a || isIP(a.address) !== a.family || !publicAddress(a.address),
        )
      ) {
        finish({ status: "security_rejected" });
        return;
      }
      const selected = answers[0];
      const approved = new Set(answers.map((a) => canonical(a.address)));
      let verified = false;
      try {
        req = deps.request(
          {
            protocol: "https:",
            hostname: "viacep.com.br",
            port: 443,
            path: `/ws/${cep}/json/`,
            method: "GET",
            agent: false,
            servername: "viacep.com.br",
            rejectUnauthorized: true,
            checkServerIdentity: (_host, cert) =>
              checkServerIdentity("viacep.com.br", cert),
            headers: {
              host: "viacep.com.br",
              accept: "application/json",
              "accept-encoding": "identity",
            },
            maxHeaderSize: 8192,
            family: selected.family,
            autoSelectFamily: false,
            lookup: pinnedLookup(selected),
          } as RequestOptions & { autoSelectFamily: boolean },
          (res) => {
            response = res;
            const status = res.statusCode ?? 0;
            httpClass =
              status >= 100 && status <= 599
                ? (`${Math.floor(status / 100)}xx` as HttpClass)
                : "other";
            if (!verified) {
              finish({ status: "security_rejected" });
              return;
            }
            if (duplicateHeaders(res)) {
              finish({ status: "invalid_response" });
              return;
            }
            const code = res.statusCode ?? 0;
            if (code !== 200) {
              finish({
                status:
                  code === 429 || (code >= 500 && code <= 599)
                    ? "http_transient"
                    : "http_permanent",
              });
              return;
            }
            const type = res.headers["content-type"];
            const encoding = res.headers["content-encoding"];
            const length = res.headers["content-length"];
            if (
              typeof type !== "string" ||
              !/^application\/json(?:\s*;[^\r\n]*)?$/i.test(type.trim()) ||
              (encoding !== undefined &&
                (typeof encoding !== "string" ||
                  encoding.trim().toLowerCase() !== "identity")) ||
              (length !== undefined &&
                (typeof length !== "string" ||
                  !/^\d+$/.test(length) ||
                  Number(length) > VIACEP_BODY_LIMIT))
            ) {
              finish({ status: "invalid_response" });
              return;
            }
            const chunks: Buffer[] = [];
            let size = 0;
            res.on("data", (chunk: Buffer) => {
              size += chunk.length;
              if (size > VIACEP_BODY_LIMIT) {
                finish({ status: "invalid_response" });
                return;
              }
              chunks.push(chunk);
            });
            res.on("aborted", () => finish({ status: "transport" }));
            res.on("error", () => finish({ status: "transport" }));
            res.on("end", () => {
              if (
                !res.complete ||
                (length !== undefined && size !== Number(length))
              ) {
                finish({ status: "transport" });
                return;
              }
              bodyBytes = size;
              finish(projectViaCep(Buffer.concat(chunks), cep));
            });
            res.on("close", () => {
              if (!res.complete) finish({ status: "transport" });
            });
          },
        );
        req.on("socket", (socket) => {
          socket.once("secureConnect", () => {
            const remote =
              socket.remoteAddress && canonical(socket.remoteAddress);
            if (
              !remote ||
              !approved.has(remote) ||
              remote !== canonical(selected.address)
            ) {
              finish({ status: "security_rejected" });
              return;
            }
            verified = true;
          });
        });
        req.on("error", (error: Error) =>
          finish({ status: requestFailure(error) }),
        );
        req.end();
      } catch (error) {
        finish({ status: requestFailure(error) });
      }
    })().catch(() => finish({ status: "unknown" }));
  });
}
