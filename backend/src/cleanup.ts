// Run all applicable cleanup steps, retaining the operation name and cause.
export async function cleanup(
  steps: Array<[string, () => Promise<unknown>]>,
): Promise<void> {
  const errors: Error[] = [];
  for (const [name, step] of steps) {
    try {
      await step();
    } catch (cause) {
      errors.push(new Error(`Cleanup failed: ${name}`, { cause }));
    }
  }
  if (errors.length) throw new AggregateError(errors, "Cleanup failed");
}

// Preserve the primary error while still reporting every cleanup failure.
export async function withCleanup<T>(
  action: () => Promise<T>,
  steps: () => Array<[string, () => Promise<unknown>]>,
): Promise<T> {
  let result: T;
  try {
    result = await action();
  } catch (primary) {
    try {
      await cleanup(steps());
    } catch (cleanupError) {
      throw new AggregateError(
        [primary, cleanupError],
        "Operation and cleanup failed",
        { cause: cleanupError },
      );
    }
    throw primary;
  }
  await cleanup(steps());
  return result;
}
