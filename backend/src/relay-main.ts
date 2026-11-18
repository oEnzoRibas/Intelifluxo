import { main } from "./runtime-entrypoint.js";

export const run = (args: string[]) => main("relay", args);
