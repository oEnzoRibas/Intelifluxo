import {
  ownedPg,
  RuntimeResourceError,
  SweepScope,
} from "./runtime-resources.js";
import { scheduleInTransaction, validateSchedulerLimit } from "./scheduler.js";

export interface RuntimeSchedulerOptions {
  connectionString: string;
  limit?: number;
  eventId?: string;
  createClient?: Parameters<typeof ownedPg>[2];
}

export interface RuntimeSchedulerLifecycleOptions extends RuntimeSchedulerOptions {
  postForceSettlementMs: number;
}

/** Role-compatible lifecycle. Repeated disposal shares the original result. */
export function createRuntimeScheduler(
  options: RuntimeSchedulerLifecycleOptions,
) {
  const bindings = new WeakMap<SweepScope, () => void>();
  const disposals = new WeakMap<SweepScope, Promise<void>>();
  return {
    createScope(signal: AbortSignal): SweepScope {
      const scope = new SweepScope(options.postForceSettlementMs);
      const abort = () => scope.abort(new RuntimeResourceError("ABORTED"));
      signal.addEventListener("abort", abort, { once: true });
      bindings.set(scope, () => signal.removeEventListener("abort", abort));
      if (signal.aborted) abort();
      return scope;
    },
    sweep: createSchedulerSweep(options),
    disposeScope(scope: SweepScope): Promise<void> {
      const previous = disposals.get(scope);
      if (previous) return previous;
      bindings.get(scope)?.();
      bindings.delete(scope);
      const disposal = Promise.resolve().then(async () => {
        const errors = await scope.dispose();
        const strongest =
          errors.find((error) => error.code === "CLEANUP_STUCK") ??
          errors.find((error) => error.fatal) ??
          errors[0];
        if (strongest) throw strongest;
      });
      disposals.set(scope, disposal);
      return disposal;
    },
  };
}

/** One scope owns one client; the role lifecycle, not this adapter, disposes it. */
export function createSchedulerSweep(options: RuntimeSchedulerOptions) {
  return async (scope: SweepScope): Promise<number> => {
    const limit = options.limit ?? 100;
    try {
      validateSchedulerLimit(limit);
    } catch {
      throw new RuntimeResourceError("CONFIG");
    }
    scope.check();
    const client = await ownedPg(
      scope,
      options.connectionString,
      options.createClient,
    );
    const query = <T>(text: string, values?: unknown[]) => {
      scope.check();
      return client.query<T>(text, values);
    };
    let begun = false;
    let committing = false;
    try {
      await query("BEGIN");
      begun = true;
      const released = await scheduleInTransaction(
        { query },
        limit,
        options.eventId,
      );
      scope.check();
      committing = true;
      await query("COMMIT");
      scope.check();
      return released;
    } catch (error) {
      // Never send further SQL after an uncertain BEGIN/COMMIT or abort.
      if (begun && !committing && !scope.signal.aborted) {
        try {
          await query("ROLLBACK");
        } catch (rollbackError) {
          if (
            rollbackError instanceof RuntimeResourceError &&
            rollbackError.code === "CLEANUP_STUCK"
          )
            throw rollbackError;
          scope.abort();
        }
      } else if (!scope.signal.aborted) scope.abort();
      throw error;
    }
  };
}
