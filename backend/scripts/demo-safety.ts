export function assertDemoSafety(env: NodeJS.ProcessEnv): void {
  if (env.DEMO_LOCAL !== "1")
    throw new Error("Set DEMO_LOCAL=1 for disposable local services only");
  for (const [name, protocols] of [
    ["DATABASE_URL", ["postgres:", "postgresql:"]],
    ["AMQP_URL", ["amqp:", "amqps:"]],
  ] as const) {
    const value = env[name];
    if (!value) throw new Error(`${name} must be set explicitly`);
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new Error(`${name} must be a local URL`);
    }
    if (
      !protocols.includes(url.protocol as never) ||
      !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
      url.search ||
      url.hash
    )
      throw new Error(
        `${name} must be a loopback URL without query parameters`,
      );
  }
}
