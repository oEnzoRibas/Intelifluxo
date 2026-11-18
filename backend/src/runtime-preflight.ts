import { randomUUID } from "node:crypto";
import {
  ownedAmqp,
  ownedPg,
  RuntimeResourceError,
  SweepScope,
} from "./runtime-resources.js";

type State = "ready" | "unavailable" | "cleanup_stuck" | "aborted";
type Reason =
  "CONFIG" | "DEPENDENCY_UNAVAILABLE" | "CLEANUP_STUCK" | "ABORTED" | null;
type Dependency = { state: State; reasonCode: Reason };
export type PreflightResult = {
  version: 1;
  state: State;
  dependencies: { postgres: Dependency; rabbitmq: Dependency };
  observedAt: string;
};
export type PreflightOptions = {
  databaseUrl: string;
  amqpUrl: string;
  signal: AbortSignal;
  probeDeadlineMs: number;
  factories?: {
    pg?: Parameters<typeof ownedPg>[2];
    amqp?: Parameters<typeof ownedAmqp>[2];
  };
};

const result = (state: State, reasonCode: Reason): Dependency => ({
  state,
  reasonCode,
});
const unavailable = () => result("unavailable", "DEPENDENCY_UNAVAILABLE");
const aborted = () => result("aborted", "ABORTED");
function validUrl(value: string, protocols: string[]): boolean {
  try {
    const url = new URL(value);
    return protocols.includes(url.protocol) && !!url.hostname;
  } catch {
    return false;
  }
}

/** probeDeadlineMs bounds admitted operations, not disposal. SweepScope may add
 * its bounded graceful-close and post-force settlement time. No retries occur. */
export async function runPreflight(
  options: PreflightOptions,
): Promise<PreflightResult> {
  const { signal, probeDeadlineMs } = options;
  const deadlineValid =
    Number.isFinite(probeDeadlineMs) &&
    probeDeadlineMs > 0 &&
    probeDeadlineMs <= 60_000;
  async function probe(
    valid: boolean,
    work: (scope: SweepScope) => Promise<void>,
  ): Promise<Dependency> {
    if (signal.aborted) return aborted();
    if (!deadlineValid || !valid) return result("unavailable", "CONFIG");
    const scope = new SweepScope(100);
    const onAbort = () => scope.abort();
    signal.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(
      () => scope.abort(new RuntimeResourceError("DEADLINE")),
      probeDeadlineMs,
    );
    let outcome = result("ready", null);
    try {
      if (signal.aborted) onAbort();
      scope.check();
      await work(scope);
      scope.check();
    } catch {
      outcome = signal.aborted ? aborted() : unavailable();
    } finally {
      clearTimeout(timer);
      try {
        const errors = await scope.dispose();
        if (errors.some((error) => error.code === "CLEANUP_STUCK"))
          outcome = result("cleanup_stuck", "CLEANUP_STUCK");
        else if (errors.length) outcome = unavailable();
      } catch (error) {
        outcome =
          error instanceof RuntimeResourceError &&
          error.code === "CLEANUP_STUCK"
            ? result("cleanup_stuck", "CLEANUP_STUCK")
            : unavailable();
      }
      signal.removeEventListener("abort", onAbort);
    }
    if (signal.aborted && outcome.state === "ready") return aborted();
    return outcome;
  }
  const [postgres, rabbitmq] = await Promise.all([
    probe(
      validUrl(options.databaseUrl, ["postgres:", "postgresql:"]),
      async (scope) => {
        const client = await ownedPg(
          scope,
          options.databaseUrl,
          options.factories?.pg,
        );
        await client.query("SELECT 1");
      },
    ),
    probe(validUrl(options.amqpUrl, ["amqp:", "amqps:"]), async (scope) => {
      const connection = await ownedAmqp(
        scope,
        options.amqpUrl,
        options.factories?.amqp,
      );
      const channel = await connection.createConfirmChannel();
      const queue = `intelifluxo-preflight-${randomUUID()}`;
      let declared = false;
      try {
        await channel.assertQueue(
          queue,
          { exclusive: true, autoDelete: true, durable: false },
          probeDeadlineMs,
        );
        declared = true;
        const receipt = await channel.publish(
          "",
          queue,
          Buffer.from("preflight"),
          probeDeadlineMs,
        );
        if (!receipt.confirmed || !receipt.routed)
          throw new Error("unconfirmed");
      } finally {
        if (declared && !scope.signal.aborted)
          await channel.deleteQueue(queue, undefined, probeDeadlineMs);
      }
    }),
  ]);
  const states = [postgres.state, rabbitmq.state];
  const state: State = states.includes("cleanup_stuck")
    ? "cleanup_stuck"
    : states.includes("aborted")
      ? "aborted"
      : states.includes("unavailable")
        ? "unavailable"
        : "ready";
  return {
    version: 1,
    state,
    dependencies: { postgres, rabbitmq },
    observedAt: new Date().toISOString(),
  };
}
