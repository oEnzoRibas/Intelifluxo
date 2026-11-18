import { connectBroker } from "./broker.js";
import { database } from "./db.js";
import { startWorker } from "./worker.js";
import {
  queue,
  viacepTimeoutMs,
  viacepExternalExecutionEnabled,
} from "./config.js";

const timeoutMs = viacepTimeoutMs(process.env.VIACEP_TIMEOUT_MS);
const externalEnabled = viacepExternalExecutionEnabled(
  process.env.VIACEP_EXTERNAL_EXECUTION_ENABLED,
);
const pool = database();
const connection = await connectBroker();
const channel = await connection.createChannel();
channel.on("error", () => console.error("worker channel error"));
channel.on("close", () => {
  void pool.end().finally(() => {
    void connection.close().catch(() => {});
  });
});
await startWorker(pool, channel, queue, {
  viacepTimeoutMs: timeoutMs,
  viacepExternalExecutionEnabled: externalEnabled,
});
console.log("worker consuming");
