import { afterEach, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import GoogleForms from "./GoogleForms";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.location.hash = "";
});
it("lets future users add an existing Google Form without requiring a public URL immediately", async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValue(
      new Response(
        JSON.stringify({ id: "11111111-1111-4111-8111-111111111111" }),
        { status: 201 },
      ),
    );
  vi.stubGlobal("fetch", fetcher);
  render(<GoogleForms />);
  expect(screen.getByText(/Apenas colar o link não autoriza/)).toBeTruthy();
  fireEvent.change(screen.getByLabelText("Nome da conexão"), {
    target: { value: "Pedidos Google" },
  });
  fireEvent.change(screen.getByLabelText("Link do Google Forms"), {
    target: { value: "https://docs.google.com/forms/d/example/edit" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Cadastrar conexão" }));
  await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
  expect(JSON.parse(fetcher.mock.calls[0][1].body)).toMatchObject({
    formUrl: "https://docs.google.com/forms/d/example/edit",
    cepQuestion: "CEP",
    city: "Belo Horizonte",
    publicBaseUrl: "",
  });
});
it("shows pending setup rather than claiming a Google account was connected", async () => {
  const id = "11111111-1111-4111-8111-111111111111";
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          items: [
            {
              id,
              formId: id,
              title: "Pedidos Google",
              city: "Belo Horizonte",
              cepQuestion: "CEP",
              formUrl: "https://docs.google.com/forms/d/example/edit",
              publicBaseUrl: "",
              published: false,
              configured: false,
              lastReceivedAt: null,
            },
          ],
        }),
      ),
    ),
  );
  render(<GoogleForms connectionId={id} />);
  await screen.findByText("Aguardando configuração");
  expect(
    (
      screen.getByRole("button", {
        name: "Gerar script de integração",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  expect(
    (
      screen.getByRole("button", {
        name: "Ativar recebimento",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
});
