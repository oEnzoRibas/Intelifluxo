import { describe, expect, it } from "vitest";
import { viacepTimeoutMs } from "../src/config.js";

describe("ViaCEP timeout configuration", () => {
  it.each([
    [undefined, 5000],
    ["1000", 1000],
    ["5000", 5000],
    ["10000", 10000],
  ] as const)("parses %s", (input, expected) => {
    expect(viacepTimeoutMs(input)).toBe(expected);
  });
  it.each([
    "",
    "0",
    "999",
    "10001",
    "01000",
    "+1000",
    "-1000",
    " 1000",
    "1000 ",
    "1e3",
    "1000.0",
    "１２３４",
    "secret",
  ])("rejects invalid value", (input) => {
    expect(() => viacepTimeoutMs(input)).toThrow(
      "VIACEP_TIMEOUT_MS must be a canonical integer from 1000 to 10000",
    );
  });
});
