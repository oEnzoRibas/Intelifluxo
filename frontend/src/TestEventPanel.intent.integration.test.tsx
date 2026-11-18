import { afterEach, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import TestEventPanel from "./TestEventPanel";
import { defaultGraph } from "./workflow-graph";
import { runtimeStatus } from "./test-runtime-status-fixture";
import {
  consumeIntent,
  intentSlot,
  resetIntentRegistryForTests,
  subscribeIntent,
} from "./test-event-intent-registry";
import type { Definition } from "./automation-api";
import { createViaCepTemplate } from "./viacep-graph";

const definition: Definition = {
  id: "11111111-1111-1111-1111-111111111111",
  scope: "tenant",
  revision: 1,
  name: "Receipt",
  active: true,
  schemaVersion: 1,
  trigger: { type: "receipt.v1" },
  action: { type: "record-receipt.v1" },
  graph: defaultGraph(),
  graphSource: "server",
  createdAt: "2026-01-01T00:00:00.000Z",
};
const response = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status });
function setup() {
  let finish!: (response: Response) => void;
  const posts: RequestInit[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation((url, options) => {
    if (
      String(url).endsWith("/runtime/status") &&
      (!options?.method || options.method === "GET")
    )
      return Promise.resolve(response(runtimeStatus()));
    if (String(url).endsWith("/events") && options?.method === "POST") {
      posts.push(options);
      return new Promise<Response>((resolve) => {
        finish = resolve;
      });
    }
    return Promise.resolve(response({}, 500));
  });
  return {
    posts,
    finishStatus: (status: number) => finish(response({}, status)),
    finish: () =>
      finish(
        response(
          { id: "22222222-2222-4222-8222-222222222222", replay: false },
          202,
        ),
      ),
  };
}
async function ready(container: HTMLElement) {
  await waitFor(() =>
    expect(
      within(container).getByRole("button", { name: "Enviar evento de teste" }),
    ).toBeEnabled(),
  );
}
function send(container: HTMLElement) {
  fireEvent.change(within(container).getByLabelText("Mensagem"), {
    target: { value: "original" },
  });
  fireEvent.click(
    within(container).getByRole("button", { name: "Enviar evento de teste" }),
  );
}
function retry(container: HTMLElement) {
  fireEvent.click(
    within(container).getByRole("button", {
      name: "Tentar novamente com a mesma solicitação",
    }),
  );
}
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  sessionStorage.clear();
  resetIntentRegistryForTests();
});

it("recovers the immutable event CEP and blocks a changed revision or input contract", async () => {
  const graph = createViaCepTemplate();
  const lookup = graph.nodes.find((node) => node.kind === "lookup");
  if (!lookup || lookup.kind !== "lookup") throw Error("fixture");
  lookup.config.cep = { source: "event", fieldPath: "data.cep" };
  const v3: Definition = { ...definition, schemaVersion: 3, graph };
  const posts: string[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url, options) => {
    if (String(url).endsWith("/runtime/status")) {
      const status = runtimeStatus();
      status.capabilities.viacepWrites = true;
      status.capabilities.viacepExternalExecution = true;
      return response(status);
    }
    if (options?.method === "POST") {
      posts.push(String(options.body));
      throw Error("network uncertain");
    }
    return response({}, 500);
  });
  const first = render(<TestEventPanel definition={v3} blocked={false} />);
  await ready(first.container);
  fireEvent.change(screen.getByLabelText("CEP para este teste"), {
    target: { value: "00000-000" },
  });
  send(first.container);
  await screen.findByText(/não foi possível confirmar/i);
  expect(JSON.parse(posts[0]).data).toEqual({ cep: "00000000" });
  first.unmount();
  const second = render(<TestEventPanel definition={v3} blocked={false} />);
  expect(await screen.findByLabelText("CEP para este teste")).toHaveValue(
    "00000000",
  );
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: /Tentar novamente/ }),
    ).toBeEnabled(),
  );
  retry(second.container);
  await waitFor(() => expect(posts).toHaveLength(2));
  expect(posts[1]).toBe(posts[0]);
  await screen.findByText(/não foi possível confirmar/i);
  second.rerender(
    <TestEventPanel definition={{ ...v3, revision: 2 }} blocked={false} />,
  );
  expect(await screen.findByText(/configuração anterior/)).toBeVisible();
  expect(
    screen.getByRole("button", { name: /Tentar novamente/ }),
  ).toBeDisabled();
  second.rerender(
    <TestEventPanel
      definition={{ ...v3, graph: createViaCepTemplate() }}
      blocked={false}
    />,
  );
  expect(await screen.findByText(/configuração anterior/)).toBeVisible();
  expect(
    screen.getByRole("button", { name: /Tentar novamente/ }),
  ).toBeDisabled();
  expect(posts).toHaveLength(2);
});

it("shares one POST between mounted panels", async () => {
  const net = setup();
  const a = render(<TestEventPanel definition={definition} blocked={false} />);
  const b = render(<TestEventPanel definition={definition} blocked={false} />);
  await ready(a.container);
  await ready(b.container);
  send(a.container);
  await waitFor(() => expect(net.posts).toHaveLength(1));
  retry(b.container);
  expect(net.posts).toHaveLength(1);
  await act(async () => net.finish());
  expect(
    await within(b.container).findByText("Evento aceito."),
  ).toBeInTheDocument();
});

it("joins the unresolved POST after unmount and remount", async () => {
  const net = setup();
  const a = render(<TestEventPanel definition={definition} blocked={false} />);
  await ready(a.container);
  send(a.container);
  await waitFor(() => expect(net.posts).toHaveLength(1));
  a.unmount();
  const b = render(<TestEventPanel definition={definition} blocked={false} />);
  await waitFor(() =>
    expect(
      within(b.container).getByRole("button", {
        name: "Tentar novamente com a mesma solicitação",
      }),
    ).toBeEnabled(),
  );
  retry(b.container);
  expect(net.posts).toHaveLength(1);
  await act(async () => net.finish());
  expect(
    await within(b.container).findByText("Evento aceito."),
  ).toBeInTheDocument();
});

it("retains the original message and key when storage recovers empty", async () => {
  const net = setup();
  const get = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
    throw new Error("unavailable");
  });
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("unavailable");
  });
  const a = render(<TestEventPanel definition={definition} blocked={false} />);
  await ready(a.container);
  send(a.container);
  await waitFor(() => expect(net.posts).toHaveLength(1));
  const original = JSON.parse(String(net.posts[0].body));
  a.unmount();
  get.mockReturnValue(null);
  const b = render(<TestEventPanel definition={definition} blocked={false} />);
  expect(within(b.container).getByLabelText("Mensagem")).toHaveValue(
    "original",
  );
  await waitFor(() =>
    expect(
      within(b.container).getByRole("button", {
        name: "Tentar novamente com a mesma solicitação",
      }),
    ).toBeEnabled(),
  );
  retry(b.container);
  expect(net.posts).toHaveLength(1);
  expect(JSON.parse(String(net.posts[0].body)).idempotencyKey).toBe(
    original.idempotencyKey,
  );
  await act(async () => net.finish());
  expect(await screen.findByText("Evento aceito.")).toBeInTheDocument();
});

it.each([400, 409])(
  "shows actionable definitive %i to both panels",
  async (status) => {
    const net = setup();
    const a = render(
      <TestEventPanel definition={definition} blocked={false} />,
    );
    const b = render(
      <TestEventPanel definition={definition} blocked={false} />,
    );
    await ready(a.container);
    await ready(b.container);
    send(a.container);
    await waitFor(() => expect(net.posts).toHaveLength(1));
    await act(async () => net.finishStatus(status));
    for (const panel of [a, b]) {
      expect(
        await within(panel.container).findByText(
          status === 400 ? /serviço rejeitou/ : /Conflito de solicitação/,
        ),
      ).toBeInTheDocument();
      expect(within(panel.container).getByLabelText("Mensagem")).toBeEnabled();
      expect(
        within(panel.container).queryByRole("button", {
          name: /Tentar novamente/,
        }),
      ).not.toBeInTheDocument();
    }
  },
);

it("delivers acceptance to a passive panel and a remount without retry", async () => {
  const net = setup();
  const a = render(<TestEventPanel definition={definition} blocked={false} />);
  const b = render(<TestEventPanel definition={definition} blocked={false} />);
  await ready(a.container);
  await ready(b.container);
  send(a.container);
  await waitFor(() => expect(net.posts).toHaveLength(1));
  a.unmount();
  const c = render(<TestEventPanel definition={definition} blocked={false} />);
  await act(async () => net.finish());
  expect(
    await within(b.container).findByText("Evento aceito."),
  ).toBeInTheDocument();
  expect(
    await within(c.container).findByText("Evento aceito."),
  ).toBeInTheDocument();
  expect(net.posts).toHaveLength(1);
});

it("ignores a definitive outcome from a previous definition", async () => {
  const net = setup();
  const a = render(<TestEventPanel definition={definition} blocked={false} />);
  await ready(a.container);
  send(a.container);
  await waitFor(() => expect(net.posts).toHaveLength(1));
  a.rerender(
    <TestEventPanel
      definition={{ ...definition, id: "33333333-3333-4333-8333-333333333333" }}
      blocked={false}
    />,
  );
  await act(async () => net.finishStatus(400));
  expect(
    within(a.container).queryByText(/serviço rejeitou/),
  ).not.toBeInTheDocument();
});

it("retains acceptance after all panels unmount, and repeats only on submit", async () => {
  const net = setup();
  const a = render(<TestEventPanel definition={definition} blocked={false} />);
  await ready(a.container);
  send(a.container);
  await waitFor(() => expect(net.posts).toHaveLength(1));
  const first = JSON.parse(String(net.posts[0].body)).idempotencyKey;
  a.unmount();
  await act(async () => net.finish());
  const b = render(<TestEventPanel definition={definition} blocked={false} />);
  expect(
    await within(b.container).findByText("Evento aceito."),
  ).toBeInTheDocument();
  fireEvent.click(
    within(b.container).getByRole("button", { name: "Repetir teste" }),
  );
  expect(net.posts).toHaveLength(1);
  await ready(b.container);
  fireEvent.click(
    within(b.container).getByRole("button", { name: "Enviar evento de teste" }),
  );
  await waitFor(() => expect(net.posts).toHaveLength(2));
  expect(JSON.parse(String(net.posts[1].body)).idempotencyKey).not.toBe(first);
});

it("does not adopt a previous scope before or after settlement", async () => {
  const net = setup();
  const other = { ...definition, scope: "other" };
  const panel = render(
    <TestEventPanel definition={definition} blocked={false} />,
  );
  await ready(panel.container);
  send(panel.container);
  await waitFor(() => expect(net.posts).toHaveLength(1));
  panel.rerender(<TestEventPanel definition={other} blocked={false} />);
  expect(within(panel.container).getByLabelText("Mensagem")).toHaveValue("");
  await act(async () => net.finish());
  expect(
    within(panel.container).queryByText("Evento aceito."),
  ).not.toBeInTheDocument();
  panel.rerender(<TestEventPanel definition={definition} blocked={false} />);
  expect(
    await within(panel.container).findByText("Evento aceito."),
  ).toBeInTheDocument();
});

it.each([202, 400, 409])(
  "keeps a delivered %i outcome in another panel after immediate consumption",
  async (status) => {
    const net = setup();
    const a = render(
      <TestEventPanel definition={definition} blocked={false} />,
    );
    const b = render(
      <TestEventPanel definition={definition} blocked={false} />,
    );
    await ready(a.container);
    await ready(b.container);
    send(a.container);
    await waitFor(() => expect(net.posts).toHaveLength(1));
    const slot = intentSlot(definition.id, definition.scope);
    const stop = subscribeIntent(slot, (state) => {
      if (state.outcome)
        consumeIntent(slot, () => sessionStorage, state.outcome.envelope);
    });
    await act(async () => {
      if (status === 202) net.finish();
      else net.finishStatus(status);
    });
    fireEvent.click(
      within(a.container).getByRole("button", { name: "Repetir teste" }),
    );
    stop();
    expect(
      within(a.container).getByRole("button", {
        name: "Enviar evento de teste",
      }),
    ).toBeEnabled();
    expect(
      within(b.container).getByText(
        status === 202
          ? "Evento aceito."
          : status === 400
            ? /rejeitou os dados/
            : /Conflito de solicita/,
      ),
    ).toBeInTheDocument();
    const c = render(
      <TestEventPanel definition={definition} blocked={false} />,
    );
    await ready(c.container);
    expect(
      within(c.container).queryByText(
        status === 202
          ? "Evento aceito."
          : status === 400
            ? /rejeitou os dados/
            : /Conflito de solicita/,
      ),
    ).not.toBeInTheDocument();
    expect(net.posts).toHaveLength(1);
  },
);

it.each([
  [false, false],
  [true, true],
] as const)(
  "gates fixed ViaCEP submission on external capability=%s",
  async (external, allowed) => {
    const posts: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url, options) => {
      if (String(url).endsWith("/runtime/status")) {
        const status = runtimeStatus();
        status.capabilities.viacepWrites = true;
        status.capabilities.viacepExternalExecution = external;
        return response(status);
      }
      if (options?.method === "POST") {
        posts.push(String(options.body));
        throw Error("uncertain");
      }
      return response({}, 500);
    });
    const panel = render(
      <TestEventPanel
        definition={{
          ...definition,
          schemaVersion: 3,
          graph: createViaCepTemplate(),
        }}
        blocked={false}
      />,
    );
    if (allowed) {
      await ready(panel.container);
      send(panel.container);
      await waitFor(() => expect(posts).toHaveLength(1));
      expect(JSON.parse(posts[0])).not.toHaveProperty("data");
    } else {
      await screen.findByText(/execu.*externa ViaCEP/);
      send(panel.container);
      expect(posts).toHaveLength(0);
      expect(
        screen.getByRole("button", { name: "Enviar evento de teste" }),
      ).toBeDisabled();
    }
  },
);

it("blocks unsupported event CEP paths without a POST", async () => {
  const graph = createViaCepTemplate();
  const lookup = graph.nodes.find((node) => node.kind === "lookup");
  if (!lookup || lookup.kind !== "lookup") throw Error("fixture");
  lookup.config.cep = { source: "event", fieldPath: "address.cep" };
  const posts: string[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url, options) => {
    if (String(url).endsWith("/runtime/status")) {
      const status = runtimeStatus();
      status.capabilities.viacepWrites = true;
      status.capabilities.viacepExternalExecution = true;
      return response(status);
    }
    if (options?.method === "POST") posts.push(String(options.body));
    return response({}, 500);
  });
  const panel = render(
    <TestEventPanel
      definition={{ ...definition, schemaVersion: 3, graph }}
      blocked={false}
    />,
  );
  await screen.findByText(/campo como data\.cep/);
  send(panel.container);
  expect(posts).toHaveLength(0);
  expect(
    screen.getByRole("button", { name: "Enviar evento de teste" }),
  ).toBeDisabled();
});
