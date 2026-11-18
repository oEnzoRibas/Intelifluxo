// Infrastructure retry timing only; it never changes persisted business retries.
export function retryDelay(failures: number, random = Math.random): number {
  const ceiling = Math.min(
    30_000,
    500 * 2 ** Math.min(6, Math.max(0, failures - 1)),
  );
  return Math.floor(ceiling / 2 + (random() * ceiling) / 2);
}

export type LoopOptions = {
  signal: AbortSignal;
  sweep: () => Promise<void>;
  wait: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  fatal: (error: unknown) => boolean;
  onError: (error: unknown) => void;
  random?: () => number;
};

// The caller must cancel/close resources on abort and bound each operation.
// In particular, never race a sweep against a timer and start another while
// the original promise is still running. Ownership is also the caller's job.
export async function runSerialLoop(options: LoopOptions): Promise<void> {
  let failures = 0;
  while (!options.signal.aborted) {
    let delay: number;
    try {
      await options.sweep();
      failures = 0;
      delay = 1000;
    } catch (error) {
      // A terminal cleanup failure must survive shutdown: the old sweep may
      // still own live work, so callers must not report a clean role exit.
      if (options.fatal(error)) {
        options.onError(error);
        throw error;
      }
      if (options.signal.aborted) break;
      options.onError(error);
      failures++;
      delay = retryDelay(failures, options.random);
    }
    if (!options.signal.aborted) {
      try {
        await options.wait(delay, options.signal);
      } catch (error) {
        // Abort-aware timers commonly reject when cancelled. This is a normal
        // stop only if the loop's own signal was actually aborted.
        if (!options.signal.aborted) throw error;
      }
    }
  }
}
