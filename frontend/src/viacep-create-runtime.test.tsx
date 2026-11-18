import { StrictMode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import Automations from "./Automations";
import { runtimeStatus } from "./test-runtime-status-fixture";

vi.mock("./AutomationDashboard", () => ({ default: () => null }));
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
it("updates the create gate from runtime across remount", async () => {
  const dto = runtimeStatus();
  dto.observedAt = new Date(Date.now() - 4000).toISOString();
  dto.capabilities.conditionsWrites = true;
  dto.capabilities.viacepWrites = true;
  vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
  vi.stubGlobal(
    "fetch",
    vi.fn().mockImplementation(async () => ({
      ok: true,
      json: async () => structuredClone(dto),
    })),
  );
  const view = render(
    <StrictMode>
      <Automations route="#automations/create" />
    </StrictMode>,
  );
  await waitFor(() =>
    expect(screen.getByLabelText("Consultar CEP e decidir")).toBeEnabled(),
  );
  view.unmount();
  render(
    <StrictMode>
      <Automations route="#automations/create" />
    </StrictMode>,
  );
  await waitFor(() =>
    expect(screen.getByLabelText("Consultar CEP e decidir")).toBeEnabled(),
  );
  dto.capabilities.viacepWrites = false;
  await waitFor(
    () =>
      expect(screen.getByLabelText("Consultar CEP e decidir")).toBeDisabled(),
    { timeout: 7000 },
  );
}, 10000);
