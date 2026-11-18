import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import Forms from "./Forms";

const id = "11111111-1111-4111-8111-111111111111";
const automationId = "22222222-2222-4222-8222-222222222222";
const eventId = "33333333-3333-4333-8333-333333333333";
const form = {
  id,
  automationId,
  revision: 2,
  title: "Entrega BH",
  description: "Informe o CEP",
  city: "Belo Horizonte",
  fields: [
    { key: "cep", label: "CEP de entrega", type: "cep", required: true },
  ],
  published: true,
  createdAt: "2026-11-18T12:00:00.000Z",
  updatedAt: "2026-11-18T12:00:00.000Z",
};
const response = (v: unknown, status = 200) =>
  new Response(JSON.stringify(v), {
    status,
    headers: { "Content-Type": "application/json" },
  });
afterEach(() => {
  cleanup();
  sessionStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.location.hash = "";
});
describe("forms experience", () => {
  it("creates configurable forms and adds/removes fields before saving a draft", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(response({ ...form, published: false }, 201));
    vi.stubGlobal("fetch", fetcher);
    render(<Forms route="#forms/create" />);
    fireEvent.change(screen.getByLabelText("Título do formulário"), {
      target: { value: "Entrega BH" },
    });
    fireEvent.click(screen.getByRole("button", { name: "+ Adicionar campo" }));
    expect(screen.getByLabelText("Nome do campo 4")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Nome do campo 4"), {
      target: { value: "Telefone" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Remover Telefone" }));
    fireEvent.click(screen.getByRole("button", { name: "Criar formulário" }));
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    const body = JSON.parse(fetcher.mock.calls[0][1].body);
    expect(body.city).toBe("Belo Horizonte");
    expect(body.fields).toHaveLength(3);
    expect(body).not.toHaveProperty("published");
  });
  it("locks published forms and pauses without silently changing their configuration", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(response(form))
      .mockResolvedValue(response({ ...form, published: false, revision: 3 }));
    vi.stubGlobal("fetch", fetcher);
    render(<Forms route={`#forms/${id}/edit`} />);
    const title = await screen.findByLabelText("Título do formulário");
    expect(
      (title as HTMLInputElement).disabled ||
        (title.closest("fieldset") as HTMLFieldSetElement).disabled,
    ).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Pausar recebimento" }));
    await waitFor(() =>
      expect(
        fetcher.mock.calls.some(([, options]) => options?.method === "PUT"),
      ).toBe(true),
    );
    const call = fetcher.mock.calls.find(
      ([, options]) => options?.method === "PUT",
    );
    expect(JSON.parse(call![1].body)).toMatchObject({
      expectedRevision: 2,
      published: false,
      city: "Belo Horizonte",
    });
  });
  it("preserves the same submission after uncertain acceptance and only polls after recovery", async () => {
    let posts = 0;
    const fetcher = vi.fn(async (url: string, options?: RequestInit) => {
      if (options?.method === "POST") {
        if (++posts === 1) throw new TypeError("network");
        return response({ id: eventId, replay: true });
      }
      if (url.includes("/executions?")) return response({ items: [] });
      return response(form);
    });
    vi.stubGlobal("fetch", fetcher);
    render(<Forms route={`#forms/${id}/fill`} />);
    const cep = await screen.findByLabelText("CEP de entrega *");
    fireEvent.change(cep, { target: { value: "30140-071" } });
    fireEvent.click(
      screen.getByRole("button", { name: "Enviar e consultar CEP" }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Recuperar o mesmo envio" }),
    );
    await screen.findByText("RESPOSTA RECEBIDA");
    const bodies = fetcher.mock.calls
      .filter(([, o]) => o?.method === "POST")
      .map(([, o]) => JSON.parse(String(o!.body)));
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toEqual(bodies[1]);
    expect(bodies[0].answers).toEqual({ cep: "30140-071" });
    fireEvent.click(
      screen.getByRole("button", { name: "Atualizar resultado" }),
    );
    expect(posts).toBe(2);
  });
  it("does not accept new responses while paused", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(response({ ...form, published: false })),
    );
    render(<Forms route={`#forms/${id}/fill`} />);
    await screen.findByText(
      "Este formulário está pausado e não recebe respostas.",
    );
    expect(
      (
        screen.getByRole("button", {
          name: "Enviar e consultar CEP",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });
});
