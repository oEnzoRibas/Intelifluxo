import { useEffect, useRef, useState } from "react";
import {
  effectiveRuntime,
  fetchRuntimeStatus,
  type RuntimeStatus,
} from "./runtime-status";

export function useRuntimeStatus() {
  const [status, setStatus] = useState<RuntimeStatus | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const inFlight = useRef<Promise<void> | null>(null);
  useEffect(() => {
    let disposed = false;
    let controller: AbortController | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let waiting = false;
    // navigator.onLine describes general network connectivity, not whether the
    // local runtime is reachable. Let the request determine availability.
    const available = () => document.visibilityState === "visible";
    const run = async () => {
      if (disposed || !available()) return;
      clearTimeout(timer);
      if (inFlight.current) {
        if (!waiting) {
          waiting = true;
          void inFlight.current.then(() => {
            waiting = false;
            if (!disposed) void run();
          });
        }
        return;
      }
      if (disposed || controller || !available()) return;
      controller = new AbortController();
      const current = controller;
      const pending = fetchRuntimeStatus(current.signal).catch(() => null);
      const settled = pending.then(() => {});
      inFlight.current = settled;
      const value = await pending;
      if (inFlight.current === settled) inFlight.current = null;
      if (!disposed && !current.signal.aborted) {
        setStatus(value);
        setNow(Date.now());
      }
      if (controller !== current) return;
      controller = null;
      if (!disposed && available())
        timer = setTimeout(run, current.signal.aborted ? 0 : 5000);
    };
    const change = () => {
      clearTimeout(timer);
      setNow(Date.now());
      if (!available()) {
        controller?.abort();
        setStatus(null);
      } else void run();
    };
    document.addEventListener("visibilitychange", change);
    window.addEventListener("online", change);
    window.addEventListener("offline", change);
    const clock = setInterval(() => setNow(Date.now()), 1000);
    void run();
    return () => {
      clearInterval(clock);
      disposed = true;
      clearTimeout(timer);
      controller?.abort();
      document.removeEventListener("visibilitychange", change);
      window.removeEventListener("online", change);
      window.removeEventListener("offline", change);
    };
  }, []);
  return { status, effective: effectiveRuntime(status, now) };
}
