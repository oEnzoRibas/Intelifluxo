import { describe, expect, it } from "vitest";
import vm from "node:vm";
import {
  googleFormScript,
  googleFormUrl,
  publicBaseUrl,
} from "../src/google-forms.js";

describe("Google Forms configuration", () => {
  it("accepts Google Forms URLs and rejects deceptive domains and local ingress", () => {
    expect(
      googleFormUrl(
        "https://docs.google.com/forms/d/e/example/viewform?usp=sf_link",
      ),
    ).toBe(true);
    for (const url of [
      "https://docs.google.com.evil.test/forms/d/x/edit",
      "http://docs.google.com/forms/d/x/edit",
      "https://evil.test/forms/d/x/edit",
      "https://user@docs.google.com/forms/d/x/edit",
    ])
      expect(googleFormUrl(url)).toBe(false);
    expect(publicBaseUrl("https://forms.example.test")).toBe(true);
    for (const url of [
      "http://127.0.0.1:3000",
      "https://localhost",
      "https://forms.example.test/admin",
      "https://user:pass@forms.example.test",
    ])
      expect(publicBaseUrl(url)).toBe(false);
  });
  it("quotes user-controlled text and keeps retry bodies identical", () => {
    const question = 'CEP"; throw new Error("injected"); //';
    const script = googleFormScript(
      {
        id: "test",
        public_base_url: "https://example.test",
        cep_question: question,
        message_question: "",
      },
      "synthetic-test-key",
    );
    const sends: unknown[] = [];
    const context = vm.createContext({
      UrlFetchApp: {
        fetch: (_url: string, args: { payload: string }) => {
          sends.push(args.payload);
          return { getResponseCode: () => (sends.length < 3 ? 503 : 202) };
        },
      },
      Utilities: { sleep: () => {} },
    });
    vm.runInContext(script, context);
    const response = {
      getId: () => "response-1",
      getItemResponses: () => [
        {
          getItem: () => ({ getTitle: () => question }),
          getResponse: () => "30140-071",
        },
      ],
    };
    context.sample = response;
    vm.runInContext("enviarRespostaInteliFluxo_(sample)", context);
    expect(sends).toHaveLength(3);
    expect(new Set(sends).size).toBe(1);
    expect(JSON.parse(sends[0] as string)).toEqual({
      responseId: "response-1",
      cep: "30140-071",
      message: "",
    });
    expect(script).not.toContain("console.log");
  });
});
