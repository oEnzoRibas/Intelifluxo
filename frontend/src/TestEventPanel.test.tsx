import { afterEach, expect, it, vi } from "vitest";
import {
  cleanup,
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import TestEventPanel from "./TestEventPanel";
import Automations from "./Automations";
import { defaultGraph } from "./workflow-graph";
import type { Definition } from "./automation-api";
import { runtimeStatus } from "./test-runtime-status-fixture";
import {
  intentSlot,
  resetIntentRegistryForTests,
} from "./test-event-intent-registry";

const d: Definition = {
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
const id = "22222222-2222-2222-2222-222222222222";
const storageKey = intentSlot(d.id, d.scope);
const response = (value: unknown, status: number) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });

it.each([
  ["unknown", true, /ainda não estão prontos/],
  ["degraded", true, /ainda não estão prontos/],
  ["ready", false, /snapshots desativados/],
] as const)(
  "keeps sending disabled for %s snapshots=%s",
  async (state, snapshots, reason) => {
    const fetcher = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (url, options) => {
        if (
          String(url).endsWith("/runtime/status") &&
          (!options?.method || options.method === "GET")
        )
          return response(runtimeStatus(state, snapshots), 200);
        throw new Error(`Unexpected request ${String(url)}`);
      });
    render(<TestEventPanel definition={d} blocked={false} />);
    expect(await screen.findByText(reason)).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Enviar evento de teste" }),
    ).toBeDisabled();
    expect(
      fetcher.mock.calls.every(([url]) =>
        String(url).endsWith("/runtime/status"),
      ),
    ).toBe(true);
  },
);

it("enables the same form when runtime readiness recovers", async () => {
  let ready = false;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url, options) => {
    if (
      String(url).endsWith("/runtime/status") &&
      (!options?.method || options.method === "GET")
    )
      return response(runtimeStatus(ready ? "ready" : "unknown"), 200);
    throw new Error(`Unexpected request ${String(url)}`);
  });
  render(<TestEventPanel definition={d} blocked={false} />);
  await screen.findByText(/ainda não estão prontos/);
  const input = screen.getByLabelText("Mensagem");
  fireEvent.change(input, { target: { value: "preserved" } });
  const send = screen.getByRole("button", { name: "Enviar evento de teste" });
  expect(send).toBeDisabled();
  ready = true;
  fireEvent(window, new Event("online"));
  await waitFor(() => expect(send).toBeEnabled());
  expect(screen.getByLabelText("Mensagem")).toBe(input);
  expect(input).toHaveValue("preserved");
});

it("waits for an aborted status request to settle before replacing it", async () => {
  let online = true;
  vi.spyOn(navigator, "onLine", "get").mockImplementation(() => online);
  let finish!: (value: Response) => void;
  const signals: AbortSignal[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation((url, options) => {
    if (
      !String(url).endsWith("/runtime/status") ||
      (options?.method && options.method !== "GET")
    )
      throw new Error(`Unexpected request ${String(url)}`);
    signals.push(options?.signal as AbortSignal);
    if (signals.length === 1)
      return new Promise<Response>((resolve) => {
        finish = resolve;
      });
    return Promise.resolve(response(runtimeStatus(), 200));
  });
  render(<TestEventPanel definition={d} blocked={false} />);
  expect(signals).toHaveLength(1);
  const visibility = vi
    .spyOn(document, "visibilityState", "get")
    .mockReturnValue("hidden");
  online = false;
  fireEvent(document, new Event("visibilitychange"));
  expect(signals[0].aborted).toBe(true);
  online = true;
  visibility.mockReturnValue("visible");
  fireEvent(window, new Event("online"));
  expect(signals).toHaveLength(1);
  await act(async () => {
    finish(response(runtimeStatus("unknown"), 200));
  });
  await waitFor(() => expect(signals).toHaveLength(2));
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "Enviar evento de teste" }),
    ).toBeEnabled(),
  );
});
afterEach(() => {
  cleanup();
  resetIntentRegistryForTests();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
  sessionStorage.clear();
});
function renderReady(ui: Parameters<typeof render>[0]) {
  const fetch = globalThis.fetch;
  vi.stubGlobal("fetch", (url: RequestInfo | URL, options?: RequestInit) =>
    String(url).endsWith("/runtime/status")
      ? Promise.resolve(response(runtimeStatus(), 200))
      : fetch(url, options),
  );
  return render(ui);
}

async function waitForReady() {
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "Enviar evento de teste" }),
    ).toBeEnabled(),
  );
}
function submit(message = "hello") {
  fireEvent.change(screen.getByLabelText("Mensagem"), {
    target: { value: message },
  });
  fireEvent.click(
    screen.getByRole("button", { name: "Enviar evento de teste" }),
  );
}
it.each([202, 200])(
  "shows accepted summary for %s with technical details closed",
  async (status) => {
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (_url, options) =>
        options?.method === "POST"
          ? response({ id, replay: status === 200 }, status)
          : response({}, 500),
      );
    renderReady(<TestEventPanel definition={d} blocked={false} />);
    await waitForReady();
    submit();
    expect(
      await screen.findByText(/Não foi possível consultar o evento/),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(
        screen.getByRole("heading", {
          name:
            status === 200
              ? "Solicitação anterior confirmada."
              : "Evento aceito.",
        }),
      ).toHaveFocus(),
    );
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(
      screen.getByText("Detalhes técnicos").parentElement,
    ).not.toHaveAttribute("open");
    expect(screen.getByText(`ID do evento: ${id}`)).not.toBeVisible();
  },
);
it.each([
  [{ ...d, active: false }, false, /inativa/],
  [d, true, /Salve ou descarte/],
  [{ ...d, scope: "bad scope" }, false, /escopo não é compatível/],
  [
    { ...d, schemaVersion: 3 },
    false,
    /execução externa ViaCEP não está disponível/,
  ],
] as const)("explains disabled state", (definition, blocked, reason) => {
  render(<TestEventPanel definition={definition} blocked={blocked} />);
  expect(screen.getByText(reason)).toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: "Enviar evento de teste" }),
  ).toBeDisabled();
});
it("rejects invalid messages locally", async () => {
  const fetch = vi.spyOn(globalThis, "fetch");
  renderReady(<TestEventPanel definition={d} blocked={false} />);
  await waitForReady();
  submit("");
  expect(screen.getByText(/Informe uma mensagem/).parentElement).toHaveFocus();
  expect(fetch).not.toHaveBeenCalled();
});
it.each([
  [409, /Conflito de solicitação/],
  [400, /serviço rejeitou/],
] as const)("explains rejection %s", async (status, copy) => {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(response({}, status));
  renderReady(<TestEventPanel definition={d} blocked={false} />);
  await waitForReady();
  submit();
  expect(await screen.findByText(copy)).toBeInTheDocument();
});
it("retries an uncertain request unchanged and creates a new key after acceptance", async () => {
  const fetch = vi
    .spyOn(globalThis, "fetch")
    .mockRejectedValueOnce(new Error())
    .mockResolvedValue(response({ id, replay: false }, 202));
  renderReady(<TestEventPanel definition={d} blocked={false} />);
  await waitForReady();
  submit();
  fireEvent.click(
    await screen.findByRole("button", { name: /Tentar novamente/ }),
  );
  await screen.findByText(/Não foi possível consultar o evento/);
  expect(fetch.mock.calls[0][1]?.body).toBe(fetch.mock.calls[1][1]?.body);
  const body = JSON.parse(fetch.mock.calls[0][1]?.body as string);
  expect(body).not.toHaveProperty("data");
  fireEvent.click(screen.getByRole("button", { name: "Enviar outro evento" }));
  await waitForReady();
  submit();
  await waitFor(() =>
    expect(fetch.mock.calls.length).toBeGreaterThanOrEqual(5),
  );
  expect(
    JSON.parse(fetch.mock.calls[4][1]?.body as string).idempotencyKey,
  ).not.toBe(body.idempotencyKey);
});

const eventDetail = (status = "accepted", publication = "pending") => ({
  id,
  scope: "tenant",
  content: { type: "receipt.v1", target: "local-receipt", message: "hello" },
  createdAt: "2026-01-01T00:00:00.000Z",
  status,
  publication,
  result:
    status === "completed"
      ? { kind: "local-receipt.v1", eventId: id, message: "recebido" }
      : null,
  retry:
    status === "retry_scheduled"
      ? {
          generation: 1,
          attempt: 1,
          outcome: "transient",
          delayMs: 1000,
          nextEligibleAt: "2026-01-01T00:01:00.000Z",
          reason: null,
        }
      : null,
});
const execution = (status: string, automationId = d.id) => ({
  id: "33333333-3333-3333-3333-333333333333",
  eventId: id,
  automationId,
  revision: 2,
  schemaVersion: 1,
  trigger: d.trigger,
  action: d.action,
  createdAt: d.createdAt,
  status,
  retry: null,
  result: null,
});
it.each([
  ["accepted", "pending", "Aceito — aguardando envio"],
  ["accepted", "confirmed", "Enviado — aguardando resultado"],
  ["completed", "confirmed", "Concluído"],
  ["blocked", "confirmed", "Interrompido — precisa de atenção"],
  ["retry_scheduled", "confirmed", "Aguardando nova tentativa automática"],
  ["retry_released", "pending", "Nova tentativa na fila"],
  ["retry_released", "confirmed", "Nova tentativa na fila"],
])("renders event lifecycle %s %s", async (status, publication, label) => {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url, options) =>
    options?.method === "POST"
      ? response({ id, replay: false }, 202)
      : String(url).includes("/executions?")
        ? response({ items: [] }, 200)
        : response(eventDetail(status, publication), 200),
  );
  renderReady(<TestEventPanel definition={d} blocked={false} />);
  await waitForReady();
  submit();
  expect(
    await within(
      await screen.findByRole("region", { name: "Situação do evento" }),
    ).findByText(label),
  ).toBeVisible();
  expect(screen.getByText(/Nenhum registro de execução/)).toBeVisible();
  expect(screen.getByText(/automação atual não está/)).toBeVisible();
  if (status === "completed")
    expect(screen.getByText("Recibo local: recebido")).toBeVisible();
  if (status === "retry_scheduled")
    expect(screen.getByText(/Próxima tentativa não antes/)).toBeVisible();
  expect(
    screen.queryByText(/processamento em andamento|duração/i),
  ).not.toBeInTheDocument();
});
it("renders current and peer snapshots and ignored status", async () => {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url, options) =>
    options?.method === "POST"
      ? response({ id, replay: false }, 202)
      : String(url).includes("/executions?")
        ? response(
            {
              items: [
                execution("ignored"),
                {
                  ...execution(
                    "completed",
                    "44444444-4444-4444-4444-444444444444",
                  ),
                  id: "55555555-5555-5555-5555-555555555555",
                },
              ],
            },
            200,
          )
        : response(eventDetail(), 200),
  );
  renderReady(<TestEventPanel definition={d} blocked={false} />);
  await waitForReady();
  submit();
  expect(
    await screen.findByText("Ignorado — condição não atendida"),
  ).toBeVisible();
  expect(
    screen.getByText(/Automação atual: Receipt — revisão 2/),
  ).toBeVisible();
  expect(screen.getByText(/Outra automação — revisão 2/)).toBeVisible();
  expect(
    screen.queryByText(/automação atual não está/),
  ).not.toBeInTheDocument();
});
it("keeps successful execution data when event read fails", async () => {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url, options) =>
    options?.method === "POST"
      ? response({ id, replay: false }, 202)
      : String(url).includes("/executions?")
        ? response({ items: [execution("blocked")] }, 200)
        : response({}, 500),
  );
  renderReady(<TestEventPanel definition={d} blocked={false} />);
  await waitForReady();
  submit();
  expect(
    await screen.findByText(/Não foi possível consultar o evento/),
  ).toBeVisible();
  expect(screen.getByText("Interrompido — precisa de atenção")).toBeVisible();
  expect(screen.getByText("Evento aceito.")).toBeVisible();
});

it("cancels an in-flight refresh on new event and ignores late responses", async () => {
  const pending: Array<(value: Response) => void> = [];
  const signals: AbortSignal[] = [];
  let reads = 0;
  vi.spyOn(globalThis, "fetch").mockImplementation((url, options) => {
    if (options?.method === "POST")
      return Promise.resolve(response({ id, replay: false }, 202));
    reads++;
    if (reads <= 2)
      return Promise.resolve(
        String(url).includes("/executions?")
          ? response({ items: [] }, 200)
          : response(eventDetail(), 200),
      );
    signals.push(options?.signal as AbortSignal);
    return new Promise((resolve) => pending.push(resolve));
  });
  renderReady(<TestEventPanel definition={d} blocked={false} />);
  await waitForReady();
  submit();
  await within(
    await screen.findByRole("region", { name: "Situação do evento" }),
  ).findByText("Aceito — aguardando envio");
  fireEvent.click(screen.getByRole("button", { name: "Atualizar resultado" }));
  expect(
    screen.getByRole("button", { name: "Atualizar resultado" }),
  ).toBeDisabled();
  expect(signals).toHaveLength(2);
  fireEvent.click(screen.getByRole("button", { name: "Enviar outro evento" }));
  expect(signals.every((signal) => signal.aborted)).toBe(true);
  pending[0](response(eventDetail("completed", "confirmed"), 200));
  pending[1](response({ items: [execution("ignored")] }, 200));
  await waitFor(() =>
    expect(screen.queryByText("Concluído")).not.toBeInTheDocument(),
  );
  expect(screen.getByLabelText("Mensagem")).toHaveValue("");
});
it("aborts on unmount and ignores a late response", async () => {
  let resolve!: (value: Response) => void;
  const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  const view = render(<TestEventPanel definition={d} blocked={false} />);
  submit();
  const signal = fetch.mock.calls[0][1]?.signal as AbortSignal;
  view.unmount();
  expect(signal.aborted).toBe(true);
  resolve(response({ id, replay: false }, 202));
  await Promise.resolve();
  expect(
    screen.queryByText(/Aguardando processamento/),
  ).not.toBeInTheDocument();
});
it("integrates the panel for a loaded saved definition", async () => {
  const { graphSource: _source, ...wire } = d;
  void _source;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url) =>
    String(url).includes("/executions?")
      ? response({ items: [] }, 200)
      : response(wire, 200),
  );
  render(<Automations route={`#automations/${d.id}`} />);
  expect(
    await screen.findByRole("heading", { name: "Enviar evento de teste" }),
  ).toBeInTheDocument();
});

it.each(["in-flight", "uncertain"])(
  "restores the identical intent after %s unmount",
  async (mode) => {
    let rejectPending!: (reason: Error) => void;
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockImplementationOnce(() =>
        mode === "in-flight"
          ? new Promise((_resolve, reject) => {
              rejectPending = reject;
            })
          : Promise.reject(new Error("offline")),
      )
      .mockImplementation(async (_url, options) =>
        options?.method === "POST"
          ? response({ id, replay: true }, 200)
          : response({}, 500),
      );
    const view = renderReady(<TestEventPanel definition={d} blocked={false} />);
    await waitForReady();
    submit();
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    const original = fetch.mock.calls[0][1]?.body;
    expect(JSON.parse(sessionStorage.getItem(storageKey)!).intent).toEqual(
      JSON.parse(original as string),
    );
    expect(Object.keys(JSON.parse(original as string)).sort()).toEqual([
      "idempotencyKey",
      "message",
      "scope",
      "target",
      "type",
    ]);
    if (mode === "uncertain")
      await screen.findByRole("button", { name: /Tentar novamente/ });
    view.unmount();
    if (mode === "in-flight") {
      await act(async () => {
        rejectPending(new Error("offline"));
      });
    }
    renderReady(<TestEventPanel definition={d} blocked={false} />);
    expect(screen.getByLabelText("Mensagem")).toHaveValue("hello");
    await screen.findByRole("button", { name: /Tentar novamente/ });
    fireEvent.click(screen.getByRole("button", { name: /Tentar novamente/ }));
    await screen.findByText("Solicitação anterior confirmada.");
    expect(fetch.mock.calls[1][1]?.body).toBe(original);
    expect(sessionStorage.getItem(storageKey)).toBeNull();
  },
);

it.each([
  "not json",
  JSON.stringify({
    scope: "other",
    idempotencyKey: id,
    type: "receipt.v1",
    target: "local-receipt",
    message: "hello",
  }),
  JSON.stringify({
    scope: "tenant",
    idempotencyKey: id,
    type: "receipt.v1",
    target: "local-receipt",
    message: "hello",
    result: {},
  }),
  JSON.stringify({
    scope: "tenant",
    idempotencyKey: "invalid",
    type: "receipt.v1",
    target: "local-receipt",
    message: "hello",
  }),
])("rejects invalid saved intent %s", (raw) => {
  sessionStorage.setItem(storageKey, raw);
  renderReady(<TestEventPanel definition={d} blocked={false} />);
  expect(sessionStorage.getItem(storageKey)).toBe(raw);
  expect(screen.getByRole("alert")).toBeVisible();
  expect(
    screen.queryByRole("button", { name: /Tentar novamente/ }),
  ).not.toBeInTheDocument();
});

it.each([202, 200, 400, 409])(
  "clears saved intent after definitive %s",
  async (status) => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, options) =>
      options?.method === "POST"
        ? response({ id, replay: status === 200 }, status)
        : response({}, 500),
    );
    renderReady(<TestEventPanel definition={d} blocked={false} />);
    await waitForReady();
    submit();
    await waitFor(() => expect(sessionStorage.getItem(storageKey)).toBeNull());
    expect(
      await screen.findByText(
        status === 400
          ? /serviço rejeitou/
          : status === 409
            ? /Conflito de solicitação/
            : status === 200
              ? /Solicitação anterior confirmada/
              : /Evento aceito/,
      ),
    ).toBeVisible();
  },
);

it("warns when session storage is unavailable and keeps an in-memory retry", async () => {
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
    throw new Error();
  });
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error();
  });
  vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error());
  renderReady(
    <TestEventPanel
      definition={{ ...d, id: "storage-warning-test" }}
      blocked={false}
    />,
  );
  expect(screen.getByRole("alert")).toHaveTextContent(
    /continuidade da tentativa pode ser perdida/,
  );
  await waitForReady();
  submit();
  expect(
    await screen.findByRole("button", { name: /Tentar novamente/ }),
  ).toBeVisible();
});

it.each([
  ["event", "confirmed"],
  ["executions", "confirmed"],
  ["event", "pending"],
  ["executions", "pending"],
])(
  "keeps execution retry wording neutral when %s completes first with %s publication",
  async (first, publication) => {
    const pending: Record<string, (value: Response) => void> = {};
    vi.spyOn(globalThis, "fetch").mockImplementation((url, options) => {
      if (options?.method === "POST")
        return Promise.resolve(response({ id, replay: false }, 202));
      const key = String(url).includes("/executions?") ? "executions" : "event";
      return new Promise((resolve) => {
        pending[key] = resolve;
      });
    });
    renderReady(<TestEventPanel definition={d} blocked={false} />);
    await waitForReady();
    submit();
    await waitFor(() => expect(Object.keys(pending)).toHaveLength(2));
    const responses: Record<string, Response> = {
      event: response(eventDetail("retry_released", publication), 200),
      executions: response(
        {
          items: [
            execution("retry_released"),
            {
              ...execution(
                "retry_scheduled",
                "44444444-4444-4444-4444-444444444444",
              ),
              id: "55555555-5555-5555-5555-555555555555",
            },
          ],
        },
        200,
      ),
    };
    await act(async () => {
      pending[first](responses[first]);
    });
    const second = first === "event" ? "executions" : "event";
    await act(async () => {
      pending[second](responses[second]);
    });
    const rows = within(
      await screen.findByRole("region", { name: "Execuções do evento" }),
    );
    expect(rows.getByText(/Nova tentativa na fila/)).toBeVisible();
    expect(
      rows.getByText("Aguardando nova tentativa automática"),
    ).toBeVisible();
    expect(
      rows.queryByText(/enviada|aguardando envio/i),
    ).not.toBeInTheDocument();
    expect(
      within(
        screen.getByRole("region", { name: "Situação do evento" }),
      ).getByText(
        publication === "confirmed"
          ? "Nova tentativa na fila"
          : "Nova tentativa na fila",
      ),
    ).toBeVisible();
  },
);

it.each([400, 409])(
  "coordinates panels and protects a newer slot when shared response is %s",
  async (status) => {
    const resolvers: ((r: Response) => void)[] = [];
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation((_url, options) =>
        options?.method === "POST"
          ? new Promise<Response>((resolve) => resolvers.push(resolve))
          : Promise.resolve(response({}, 500)),
      );
    const view = renderReady(
      <>
        <TestEventPanel definition={d} blocked={false} />
        <TestEventPanel definition={d} blocked={false} />
      </>,
    );
    const panels = view.container.querySelectorAll(".test-event-panel");
    const a = within(panels[0] as HTMLElement);
    const b = within(panels[1] as HTMLElement);
    await waitFor(() =>
      expect(
        a.getByRole("button", { name: "Enviar evento de teste" }),
      ).toBeEnabled(),
    );
    fireEvent.change(a.getByLabelText("Mensagem"), {
      target: { value: "first" },
    });
    fireEvent.click(a.getByRole("button", { name: "Enviar evento de teste" }));
    const saved = JSON.parse(sessionStorage.getItem(storageKey)!);
    expect(Object.keys(saved).sort()).toEqual([
      "context",
      "definitionId",
      "intent",
      "owner",
      "version",
    ]);
    expect(Object.keys(saved.intent).sort()).toEqual([
      "idempotencyKey",
      "message",
      "scope",
      "target",
      "type",
    ]);
    expect(b.getByLabelText("Mensagem")).toBeDisabled();
    expect(JSON.parse(sessionStorage.getItem(storageKey)!)).toEqual(saved);
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    expect(b.getByLabelText("Mensagem")).toHaveValue("first");
    fireEvent.click(b.getByRole("button", { name: /Tentar novamente/ }));
    await act(async () => {
      await Promise.resolve();
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetch.mock.calls[0][1]?.body as string)).toEqual(
      saved.intent,
    );
    const newer = {
      ...saved,
      owner: crypto.randomUUID(),
      intent: {
        ...saved.intent,
        idempotencyKey: crypto.randomUUID(),
        message: "new",
      },
    };
    sessionStorage.setItem(storageKey, JSON.stringify(newer));
    await act(async () => {
      resolvers[0](response({}, status));
    });
    expect(JSON.parse(sessionStorage.getItem(storageKey)!)).toEqual(newer);
  },
);

it("adopts a copied envelope after unmount and retries its exact intent", async () => {
  const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error());
  const first = renderReady(<TestEventPanel definition={d} blocked={false} />);
  await waitForReady();
  submit("copied");
  await screen.findByRole("button", { name: /Tentar novamente/ });
  const copied = sessionStorage.getItem(storageKey)!;
  first.unmount();
  sessionStorage.setItem(storageKey, copied);
  renderReady(<TestEventPanel definition={d} blocked={false} />);
  expect(screen.getByLabelText("Mensagem")).toHaveValue("copied");
  await screen.findByRole("button", { name: /Tentar novamente/ });
  fireEvent.click(screen.getByRole("button", { name: /Tentar novamente/ }));
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
  expect(fetch.mock.calls[0][1]?.body).toBe(fetch.mock.calls[1][1]?.body);
});

it("does not replace another panel's in-memory intent when storage is unavailable", async () => {
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
    throw new Error();
  });
  const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error());
  const view = renderReady(
    <>
      <TestEventPanel
        definition={{ ...d, id: "unavailable-slot" }}
        blocked={false}
      />
      <TestEventPanel
        definition={{ ...d, id: "unavailable-slot" }}
        blocked={false}
      />
    </>,
  );
  const panels = view.container.querySelectorAll(".test-event-panel");
  const a = within(panels[0] as HTMLElement),
    b = within(panels[1] as HTMLElement);
  await waitFor(() =>
    expect(
      a.getByRole("button", { name: "Enviar evento de teste" }),
    ).toBeEnabled(),
  );
  fireEvent.change(a.getByLabelText("Mensagem"), {
    target: { value: "first" },
  });
  fireEvent.click(a.getByRole("button", { name: "Enviar evento de teste" }));
  await a.findByRole("button", { name: /Tentar novamente/ });
  expect(b.getByLabelText("Mensagem")).toBeDisabled();
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(b.getByLabelText("Mensagem")).toHaveValue("first");
  expect(b.getByRole("alert")).toBeVisible();
});

it.each(["definitionId", "scope", "extra"])(
  "rejects a mismatched or non-flat envelope: %s",
  (field) => {
    const envelope = {
      version: 1,
      definitionId: d.id,
      owner: crypto.randomUUID(),
      intent: {
        scope: d.scope,
        idempotencyKey: crypto.randomUUID(),
        type: "receipt.v1",
        target: "local-receipt",
        message: "hello",
      },
    };
    if (field === "definitionId") envelope.definitionId = "other";
    if (field === "scope") envelope.intent.scope = "other";
    if (field === "extra")
      Object.assign(envelope.intent, { data: { secret: "not allowed" } });
    const raw = JSON.stringify(envelope);
    sessionStorage.setItem(storageKey, raw);
    render(<TestEventPanel definition={d} blocked={false} />);
    expect(sessionStorage.getItem(storageKey)).toBe(raw);
    expect(screen.getByRole("alert")).toBeVisible();
    expect(
      screen.queryByRole("button", { name: /Tentar novamente/ }),
    ).not.toBeInTheDocument();
  },
);

it("refreshes limited history once after a matching terminal execution without resending", async () => {
  let historyReads = 0;
  const fetcher = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (url, options) => {
      const path = String(url);
      if (path.includes("/runtime/status"))
        return response(runtimeStatus(), 200);
      if (options?.method === "POST")
        return response({ id, replay: false }, 202);
      if (path.includes("/executions?automationId=")) {
        historyReads++;
        return response(
          { items: historyReads === 1 ? [] : [execution("completed")] },
          200,
        );
      }
      if (path.includes("/executions?eventId="))
        return response({ items: [execution("completed")] }, 200);
      if (path.includes(`/events/${id}`))
        return response(eventDetail("completed", "confirmed"), 200);
      if (path.includes(`/automations/${d.id}`))
        return response(
          {
            id: d.id,
            scope: d.scope,
            revision: d.revision,
            name: d.name,
            active: d.active,
            schemaVersion: d.schemaVersion,
            trigger: d.trigger,
            action: d.action,
            graph: d.graph,
            createdAt: d.createdAt,
          },
          200,
        );
      throw new Error(`Unexpected request ${path}`);
    });
  render(<Automations route={`#automations/${d.id}`} />);
  await screen.findByText("Nenhuma execução retornada nesta lista limitada.");
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "Enviar evento de teste" }),
    ).toBeEnabled(),
  );
  submit();
  await waitFor(() => expect(historyReads).toBe(2));
  const history = screen
    .getByRole("heading", { name: "Histórico recente" })
    .closest("section")!;
  expect(
    await within(history).findByRole("link", { name: "Abrir evento" }),
  ).toHaveAttribute("href", `#explorer?eventId=${id}`);
  expect(
    fetcher.mock.calls.filter(([, options]) => options?.method === "POST"),
  ).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: /Atualizar resultado/ }));
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: /Atualizar resultado/ }),
    ).toBeEnabled(),
  );
  expect(historyReads).toBe(2);
  expect(
    fetcher.mock.calls.filter(([, options]) => options?.method === "POST"),
  ).toHaveLength(1);
});

it("shows local context as text rather than an editable scope", async () => {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    response(runtimeStatus(), 200),
  );
  render(
    <TestEventPanel definition={{ ...d, scope: "local" }} blocked={false} />,
  );
  expect(screen.getByText(/Contexto de execução:/)).toHaveTextContent(
    "Ambiente local",
  );
  expect(screen.queryByDisplayValue("local")).not.toBeInTheDocument();
});

it("describes a clean active builder as ready to test", async () => {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
    if (String(url).includes(`/automations/${d.id}`)) {
      const wire = JSON.parse(
        JSON.stringify(d, (key, value) =>
          key === "graphSource" ? undefined : value,
        ),
      );
      return response(wire, 200);
    }
    return response(runtimeStatus(), 200);
  });
  render(<Automations route={`#automations/${d.id}/builder`} />);
  expect(await screen.findByText(/Pronta para testar/)).toBeVisible();
  expect(
    screen.queryByText(/Salve e ative antes de testar/),
  ).not.toBeInTheDocument();
});
