import { afterEach, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import Automations from "./Automations";
import { createViaCepTemplate, viacepGraphValid } from "./viacep-graph";

const state = vi.hoisted(() => ({
  writes: true,
  external: true,
  create: vi.fn(),
}));
vi.mock("./use-runtime-status", () => ({
  useRuntimeStatus: () => ({
    status: {
      capabilities: {
        viacepWrites: state.writes,
        conditionsWrites: true,
        viacepExternalExecution: state.external,
      },
    },
    effective: { stale: false },
  }),
}));
vi.mock("./AutomationDashboard", () => ({ default: () => null }));
vi.mock("./automation-api", async (original) => ({
  ...(await original<typeof import("./automation-api")>()),
  createDefinition: state.create,
}));
afterEach(() => {
  cleanup();
  state.writes = true;
  state.external = true;
  state.create.mockReset();
  window.location.hash = "";
});
it("creates a valid fixed example with the complete topology", () => {
  const graph = createViaCepTemplate();
  expect(viacepGraphValid(graph)).toBe(true);
  expect(graph.nodes.find((n) => n.kind === "lookup")).toMatchObject({
    config: { cep: { source: "fixed", value: "01001000" } },
  });
  expect(graph.nodes.find((n) => n.kind === "condition")).toMatchObject({
    config: {
      operator: "equals",
      expectedType: "string",
      expectedValue: "SP",
      input: { source: "step", nodeId: "lookup", fieldPath: "address.uf" },
    },
  });
  expect(graph.edges).toHaveLength(5);
});
it("creates and navigates even without external execution", async () => {
  state.external = false;
  const id = "11111111-1111-4111-8111-111111111111";
  state.create.mockResolvedValue({ id });
  render(<Automations route="#automations/create" />);
  fireEvent.click(screen.getByLabelText("Consultar CEP e decidir"));
  expect(screen.getByText(/Exemplo: CEP fixo/)).toHaveTextContent(
    "antes de ativar",
  );
  fireEvent.change(screen.getByLabelText("Nome da automação"), {
    target: { value: "CEP" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Criar desativada" }));
  await waitFor(() =>
    expect(window.location.hash).toBe(`#automations/${id}/builder`),
  );
  expect(state.create).toHaveBeenCalledWith(
    "local",
    "CEP",
    expect.any(AbortSignal),
    createViaCepTemplate(),
  );
});
it("explains when ViaCEP writes are unavailable", () => {
  state.writes = false;
  render(<Automations route="#automations/create" />);
  expect(screen.getByLabelText("Consultar CEP e decidir")).toBeDisabled();
  expect(
    screen.getByText(/A criação ViaCEP está indisponível/),
  ).toBeInTheDocument();
});
