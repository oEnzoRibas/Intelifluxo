import { runSupervisor } from "./runtime-supervisor.js";
process.exitCode = await runSupervisor({
  args: process.argv.slice(2),
  env: process.env,
});
