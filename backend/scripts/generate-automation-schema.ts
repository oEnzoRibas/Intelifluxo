import { writeFile } from "node:fs/promises";
import {
  createSchema,
  updateSchema,
  params,
  query,
  response,
} from "../src/automations.js";
import { publishedGraphV2, versionPairing } from "./published-graph-v2.js";

const published = <
  T extends typeof createSchema | typeof updateSchema | typeof response,
>(
  schema: T,
) => ({
  ...schema,
  ...versionPairing,
  properties: {
    ...schema.properties,
    graph: { anyOf: [schema.properties.graph.anyOf[0], publishedGraphV2] },
  },
});
await writeFile(
  new URL("../schemas/automation-v1.schema.json", import.meta.url),
  JSON.stringify(
    {
      $schema: "http://json-schema.org/draft-07/schema#",
      $id: "automation-v1",
      definitions: {
        create: published(createSchema),
        update: published(updateSchema),
        params,
        query,
        response: published(response),
      },
    },
    null,
    2,
  ) + "\n",
);
