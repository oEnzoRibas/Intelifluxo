import { describe, expect, it } from "vitest";
import { automationSnapshotsEnabled } from "../src/config.js";

describe("automation snapshot rollout gate", () => {
  it("defaults off and accepts only exact boolean strings", () => {
    expect(automationSnapshotsEnabled(undefined)).toBe(false);
    expect(automationSnapshotsEnabled("false")).toBe(false);
    expect(automationSnapshotsEnabled("true")).toBe(true);
    for (const value of ["", "TRUE", "1", " false", "yes"])
      expect(() => automationSnapshotsEnabled(value)).toThrow();
  });
});
