import { describe, expect, it } from "vitest";
import { assertDemoSafety } from "../scripts/demo-safety.js";

describe("integrated demo safety", () => {
  const env = {
    DEMO_LOCAL: "1",
    DATABASE_URL: "postgresql://local:local@127.0.0.1:55432/intelifluxo",
    AMQP_URL: "amqp://local:local@localhost:55672",
  };
  it("accepts explicit disposable loopback configuration", () =>
    expect(() => assertDemoSafety(env)).not.toThrow());
  it("requires explicit opt in", () =>
    expect(() =>
      assertDemoSafety({ ...env, DEMO_LOCAL: undefined }),
    ).toThrow());
  it.each([
    "postgresql://example.com/db",
    "postgresql://localhost/db?host=example.com",
    "not-a-url",
  ])("rejects unsafe database URL %s", (DATABASE_URL) =>
    expect(() => assertDemoSafety({ ...env, DATABASE_URL })).toThrow(),
  );
  it.each([
    "amqp://example.com",
    "amqp://localhost?host=example.com",
    "https://localhost",
  ])("rejects unsafe broker URL %s", (AMQP_URL) =>
    expect(() => assertDemoSafety({ ...env, AMQP_URL })).toThrow(),
  );
});
