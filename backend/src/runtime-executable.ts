import { pathToFileURL } from "node:url";

type Role = "relay" | "scheduler";
import type { RuntimeControls } from "./runtime-entrypoint.js";
type Runner = { run(args: string[], controls: RuntimeControls): Promise<void> };

/** Only these literal messages are accepted from the supervising parent.
 * Queue controls during dynamic import so a disconnect cannot be lost before
 * the entrypoint installs its signal handlers. */
export function installParentControls(source: {
  on(event: "message", listener: (message: unknown) => void): unknown;
  on(event: "disconnect", listener: () => void): unknown;
  removeListener(
    event: "message",
    listener: (message: unknown) => void,
  ): unknown;
  removeListener(event: "disconnect", listener: () => void): unknown;
}) {
  let target: RuntimeControls | undefined;
  let requested = 0;
  let delivered = 0;
  const flush = () => {
    if (!target || requested <= delivered) return;
    delivered = requested;
    if (requested === 2) target.requestForce();
    else target.requestShutdown();
  };
  const onMessage = (message: unknown) => {
    if (message === "shutdown") requested = Math.max(requested, 1);
    else if (message === "force") requested = 2;
    else return;
    flush();
  };
  const onDisconnect = () => {
    requested = Math.max(requested, 1);
    flush();
  };
  source.on("message", onMessage);
  source.on("disconnect", onDisconnect);
  return {
    start: (controls: RuntimeControls) => {
      target = controls;
      flush();
    },
    dispose: () => {
      source.removeListener("message", onMessage);
      source.removeListener("disconnect", onDisconnect);
    },
  };
}

/** Catch import and startup failures without exposing adapter or configuration data. */
export async function executable(
  args: string[],
  load: (role: Role) => Promise<Runner> = (role) =>
    import("./runtime-entrypoint.js").then(({ main }) => ({
      run: (args, controls) => main(role, args, controls),
    })),
  log: (event: string) => void = (event) => console.error(event),
  hardExit: (code: number) => void = (code) => process.exit(code),
): Promise<void> {
  const controls = installParentControls(process);
  try {
    const [role, ...mode] = args;
    if (
      (role !== "relay" && role !== "scheduler") ||
      !(
        mode.length === 0 ||
        (mode.length === 1 &&
          (mode[0] === "--daemon" || mode[0] === "--one-shot"))
      )
    )
      throw new Error();
    const runner = await load(role);
    // run() synchronously installs the entrypoint signal handlers before its
    // first await. Flush only after invoking it, including controls received
    // while the module was loading.
    const graceful = new AbortController();
    const force = new AbortController();
    const runtimeControls: RuntimeControls = {
      signal: graceful.signal,
      forceSignal: force.signal,
      requestShutdown: () => graceful.abort(),
      requestForce: () => force.abort(),
    };
    const running = runner.run(mode, runtimeControls);
    controls.start(runtimeControls);
    await running;
    return;
  } catch {
    try {
      log('{"event":"runtime_boundary_failure","outcome":"fatal"}');
    } catch {
      // Exit even if the reporting channel fails.
    }
  } finally {
    controls.dispose();
  }
  hardExit(4);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  void executable(process.argv.slice(2));
}
