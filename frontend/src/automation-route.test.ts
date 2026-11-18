import { expect, it } from "vitest";
import { automationRoute } from "./automation-route";

it("preserves list, create, detail and dedicated builder routes", () => {
  const id = "11111111-1111-1111-1111-111111111111";
  expect(automationRoute("#automations")).toEqual({ id: "", builder: false });
  expect(automationRoute("#automations/create")).toEqual({
    id: "create",
    builder: false,
  });
  expect(automationRoute(`#automations/${id}`)).toEqual({ id, builder: false });
  expect(automationRoute(`#automations/${id}/builder`)).toEqual({
    id,
    builder: true,
  });
  expect(automationRoute(`#automations/${id}/other`).id).toBe("invalid");
});
