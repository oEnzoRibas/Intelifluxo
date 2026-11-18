export function automationRoute(route: string): {
  id: string;
  builder: boolean;
} {
  if (!route.startsWith("#automations/")) return { id: "", builder: false };
  const parts = route.slice("#automations/".length).split("/");
  const builder = parts.length === 2 && parts[1] === "builder";
  return { id: parts.length === 1 || builder ? parts[0] : "invalid", builder };
}
