import { afterEach, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import WorkflowBuilder from "./WorkflowBuilder";
import App from "./App";
import { defaultGraph } from "./workflow-graph";
import type { Definition } from "./automation-api";

const d: Definition = {
  id: "11111111-1111-1111-1111-111111111111",
  scope: "tenant",
  revision: 1,
  name: "Teste",
  active: false,
  schemaVersion: 1,
  trigger: { type: "receipt.v1" },
  action: { type: "record-receipt.v1" },
  createdAt: "2026-01-01T00:00:00Z",
  graph: defaultGraph(),
  graphSource: "server",
};
function mobile() {
  vi.stubGlobal(
    "matchMedia",
    vi.fn().mockImplementation((query: string) => ({
      matches: query.includes("max-width: 767px"),
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  );
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
    configurable: true,
    value() {
      this.setAttribute("open", "");
    },
  });
  Object.defineProperty(HTMLDialogElement.prototype, "close", {
    configurable: true,
    value() {
      this.removeAttribute("open");
    },
  });
}
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.location.hash = "";
});
it("presents guided steps and restores focus without scrolling on close", () => {
  mobile();
  render(
    <WorkflowBuilder definition={d} onDirty={vi.fn()} onSaved={vi.fn()} />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Usar condição guiada" }));
  expect(screen.getByText("Alterações não salvas")).toBeInTheDocument();
  expect(
    screen.getByRole("region", { name: "Etapas do fluxo" }),
  ).toBeInTheDocument();
  expect(
    screen.queryByRole("region", { name: "Accessible path controls" }),
  ).not.toBeInTheDocument();
  const dialog = screen.getByRole("dialog");
  expect(within(dialog).getByLabelText("Campo do evento")).toBeInTheDocument();
  expect(within(dialog).getByLabelText("Operador")).toBeInTheDocument();
  expect(within(dialog).queryByText("condition.v1")).not.toBeInTheDocument();
  const target = screen.getByRole("button", { name: "Condição" });
  const focus = vi.spyOn(target, "focus");
  fireEvent.click(within(dialog).getByRole("button", { name: "Concluir" }));
  expect(focus).toHaveBeenCalledWith({ preventScroll: true });
  fireEvent.click(target);
  fireEvent(
    screen.getByRole("dialog"),
    new Event("cancel", { cancelable: true }),
  );
  expect(focus).toHaveBeenLastCalledWith({ preventScroll: true });
});
it("starts mobile navigation closed and updates title and menu on navigation", () => {
  mobile();
  window.location.hash = "#explorer";
  render(<App />);
  expect(document.title).toBe("Explorador de eventos | InteliFluxo");
  const menu = screen.getByText("Menu").closest("details")!;
  expect(menu.open).toBe(false);
  menu.open = true;
  window.location.hash = "#overview";
  fireEvent(window, new HashChangeEvent("hashchange"));
  expect(menu.open).toBe(false);
  expect(document.title).toBe("Visão geral | InteliFluxo");
});
