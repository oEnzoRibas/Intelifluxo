import { connectBroker } from "./broker.js";
import { database } from "./db.js";
import { startWorker } from "./worker.js";

const pool = database();
const connection = await connectBroker();
const channel = await connection.createChannel();
channel.on("error", () => console.error("worker channel error"));
channel.on("close", () => {
  void pool.end().finally(() => {
    void connection.close().catch(() => {});
  });
});
await startWorker(pool, channel);
console.log("worker consuming");
