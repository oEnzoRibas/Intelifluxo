import { describe, expect, it } from "vitest";
import { decideRetry, validatePolicy } from "../src/retry-policy.js";

const policy = { maxAttempts: 3, baseDelayMs: 1000, capDelayMs: 4000 };

describe("bounded retry decisions", () => {
  it("schedules transient failures within the budget and blocks exhaustion", () => {
    expect(decideRetry(policy, 1, "transient")).toEqual({
      state: "scheduled",
      delayMs: 1000,
    });
    expect(decideRetry(policy, 2, "transient")).toEqual({
      state: "scheduled",
      delayMs: 2000,
    });
    expect(decideRetry(policy, 3, "transient")).toEqual({
      state: "blocked",
      reason: "exhausted",
    });
    expect(decideRetry({ ...policy, maxAttempts: 1 }, 1, "transient")).toEqual({
      state: "blocked",
      reason: "exhausted",
    });
  });
  it("blocks permanent and uncertain outcomes and completes success", () => {
    expect(decideRetry(policy, 1, "permanent")).toEqual({
      state: "blocked",
      reason: "permanent",
    });
    expect(decideRetry(policy, 1, "unknown")).toEqual({
      state: "blocked",
      reason: "unknown",
    });
    expect(decideRetry(policy, 1, "success")).toEqual({ state: "completed" });
    expect(decideRetry(policy, policy.maxAttempts, "success")).toEqual({
      state: "completed",
    });
  });
  it("saturates and rejects invalid policies and attempts", () => {
    expect(
      decideRetry(
        { ...policy, maxAttempts: 2_147_483_647 },
        2_147_483_646,
        "transient",
      ),
    ).toEqual({ state: "scheduled", delayMs: 4000 });
    for (const invalid of [0, -1, Infinity, 1.5, 2_147_483_648]) {
      expect(() =>
        validatePolicy({ ...policy, maxAttempts: invalid }),
      ).toThrow();
      expect(() =>
        validatePolicy({ ...policy, baseDelayMs: invalid }),
      ).toThrow();
      expect(() =>
        validatePolicy({ ...policy, capDelayMs: invalid }),
      ).toThrow();
    }
    expect(() => validatePolicy({ ...policy, capDelayMs: 999 })).toThrow();
    for (const attempt of [0, 4, 1.5, Infinity])
      expect(() => decideRetry(policy, attempt, "success")).toThrow();
    expect(() => decideRetry(policy, 1, "unexpected" as never)).toThrow();
  });
});
