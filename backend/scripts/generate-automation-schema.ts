import { writeFile } from "node:fs/promises";
import {
  createSchema,
  updateSchema,
  params,
  query,
  response,
} from "../src/automations.js";
await writeFile(
  new URL("../schemas/automation-v1.schema.json", import.meta.url),
  JSON.stringify(
    {
      $schema: "http://json-schema.org/draft-07/schema#",
      $id: "automation-v1",
      definitions: {
        create: createSchema,
        update: updateSchema,
        params,
        query,
        response,
      },
    },
    null,
    2,
  ) + "\n",
);
