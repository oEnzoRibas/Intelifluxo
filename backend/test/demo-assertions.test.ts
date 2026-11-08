import { describe, expect, it } from "vitest";
import { assertDemoTransition } from "../scripts/demo-assertions.js";

describe("integrated demo transition assertions", () => {
  const id = "event";
  const cases = [
    ["accepted", "accepted", "pending", null, null],
    ["initial_confirmed", "accepted", "confirmed", null, null],
    [
      "retry_scheduled",
      "retry_scheduled",
      "confirmed",
      { generation: 0, attempt: 1, outcome: "transient" },
      null,
    ],
    [
      "retry_released",
      "retry_released",
      "pending",
      { generation: 1, attempt: 1, outcome: "transient" },
      null,
    ],
    [
      "retry_confirmed",
      "retry_released",
      "confirmed",
      { generation: 1, attempt: 1, outcome: "transient" },
      null,
    ],
    [
      "completed",
      "completed",
      "confirmed",
      { generation: 1, attempt: 2, outcome: "success" },
      {
        kind: "local-receipt.v1",
        eventId: id,
        message: "synthetic integrated demo",
      },
    ],
  ] as const;
  it.each(cases)(
    "checks %s and rejects wrong fields",
    (stage, status, publication, retry, result) => {
      const body = { id, status, publication, retry, result };
      expect(() => assertDemoTransition(body, stage, id)).not.toThrow();
      for (const wrong of [
        { ...body, id: "wrong" },
        { ...body, status: "wrong" },
        { ...body, publication: "wrong" },
        { ...body, retry: retry ? { ...retry, generation: 99 } : {} },
        { ...body, retry: retry ? { ...retry, attempt: 99 } : {} },
        { ...body, retry: retry ? { ...retry, outcome: "wrong" } : {} },
        { ...body, result: result ? { ...result, eventId: "wrong" } : {} },
      ])
        expect(() => assertDemoTransition(wrong, stage, id)).toThrow();
    },
  );
});
