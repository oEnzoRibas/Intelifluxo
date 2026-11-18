import { randomUUID } from "node:crypto";
import { queue } from "./config.js";
import { relaySweep } from "./relay.js";
import {
  ownedAmqp,
  ownedPg,
  RuntimeResourceError,
  SweepScope,
} from "./runtime-resources.js";

type Pg = Awaited<ReturnType<typeof ownedPg>>;
type Amqp = Awaited<ReturnType<typeof ownedAmqp>>;
type Confirm = Awaited<ReturnType<Amqp["createConfirmChannel"]>>;

// Only fixed resource codes cross this boundary; unknown adapter failures fail closed.
function probeError(error: unknown): RuntimeResourceError {
  return new RuntimeResourceError(
    error instanceof RuntimeResourceError ? error.code : "AMQP_UNKNOWN",
  );
}

// Stuck cleanup wins, then terminal failures, then the primary on ties.
function probeFailure(
  primary: RuntimeResourceError,
  cleanup: RuntimeResourceError,
): RuntimeResourceError {
  if (primary.code === "CLEANUP_STUCK") return primary;
  if (cleanup.code === "CLEANUP_STUCK") return cleanup;
  if (!primary.fatal && cleanup.fatal) return cleanup;
  return primary;
}

export interface RuntimeRelayOptions {
  connectionString: string;
  amqpUrl: string;
  queue?: string;
  eventId?: string;
  trace?: string[];
  postForceSettlementMs: number;
  resources?: {
    pg: (scope: SweepScope, connectionString: string) => Promise<Pg>;
    amqp: (scope: SweepScope, url: string) => Promise<Amqp>;
  };
}

async function conformance(scope: SweepScope, channel: Confirm): Promise<void> {
  const suffix = randomUUID();
  const name = `intelifluxo.probe.${suffix}`;
  await channel.assertQueue(name, { exclusive: true, autoDelete: true });
  let failed = false;
  let failure: RuntimeResourceError | undefined;
  try {
    let returned = false;
    try {
      await channel.publish(
        "",
        `intelifluxo.absent.${suffix}`,
        Buffer.from("probe"),
      );
    } catch (error) {
      if (
        error instanceof RuntimeResourceError &&
        error.code === "AMQP_MANDATORY_RETURN"
      )
        returned = true;
      else throw error;
    }
    if (!returned) throw new RuntimeResourceError("AMQP_CONFORMANCE_MISMATCH");
    try {
      await channel.publish("", name, Buffer.from("probe"));
    } catch (error) {
      if (
        error instanceof RuntimeResourceError &&
        error.code === "AMQP_MANDATORY_RETURN"
      )
        throw new RuntimeResourceError("AMQP_CONFORMANCE_MISMATCH");
      throw error;
    }
  } catch (error) {
    failed = true;
    failure = probeError(error);
  }
  if (!scope.signal.aborted) {
    try {
      await channel.deleteQueue(name);
    } catch (error) {
      const cleanup = probeError(error);
      failure = failure ? probeFailure(failure, cleanup) : cleanup;
      failed = true;
    }
  }
  if (failed) throw failure;
  scope.check();
}

/** Factory callbacks match runRole. The lifecycle owns disposal, not sweep. */
export function createRuntimeRelay(options: RuntimeRelayOptions) {
  const bindings = new WeakMap<SweepScope, () => void>();
  const resources = options.resources ?? { pg: ownedPg, amqp: ownedAmqp };
  return {
    createScope(signal: AbortSignal): SweepScope {
      const scope = new SweepScope(options.postForceSettlementMs);
      const abort = () => scope.abort();
      signal.addEventListener("abort", abort, { once: true });
      bindings.set(scope, () => signal.removeEventListener("abort", abort));
      if (signal.aborted) abort();
      return scope;
    },
    async sweep(scope: SweepScope): Promise<number> {
      scope.check();
      const pg = await resources.pg(scope, options.connectionString);
      scope.check();
      const connection = await resources.amqp(scope, options.amqpUrl);
      scope.check();
      const channel = await connection.createConfirmChannel();
      await conformance(scope, channel);
      scope.check();
      const name = options.queue ?? queue;
      await channel.assertQueue(name, { durable: true });
      const trace = options.trace ?? [];
      return relaySweep(
        {
          query: (text, values) =>
            pg.query<{ rows: { event_id: string; generation?: number }[] }>(
              text,
              values,
            ),
          check: () => scope.check(),
          publishConfirmed: async (body) => {
            try {
              await channel.publish("", name, body);
              trace.push("confirm");
            } catch (error) {
              if (
                error instanceof RuntimeResourceError &&
                error.code === "AMQP_MANDATORY_RETURN"
              )
                trace.push("return", "confirm");
              throw error;
            }
          },
        },
        trace,
        options.eventId,
      );
    },
    async disposeScope(scope: SweepScope): Promise<void> {
      bindings.get(scope)?.();
      bindings.delete(scope);
      const errors = await scope.dispose();
      if (errors.length) throw errors[0];
    },
  };
}
