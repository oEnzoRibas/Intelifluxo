import pg from "pg";
import { connectBroker } from "../../src/broker.js";
import { handleMessage } from "../../src/worker.js";

const send = (value: object) =>
  new Promise<void>((resolve, reject) => {
    if (!process.send) return reject(new Error("IPC unavailable"));
    process.send(value, undefined, {}, (error) =>
      error ? reject(error) : resolve(),
    );
  });
const barrier = async (name: string) => {
  await send({ type: name });
  await new Promise<void>(() => {});
};
async function main() {
  const queue = process.env.RECOVERY_QUEUE;
  if (!queue || !/^viacep-recovery\.[0-9a-f-]+$/.test(queue))
    throw new Error("invalid queue");
  const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    connectionTimeoutMillis: 5000,
    statement_timeout: 10000,
  });
  const broker = await connectBroker();
  const channel = await broker.createChannel();
  const message = await channel.get(queue, { noAck: false });
  if (!message) throw new Error("missing delivery");
  await send({ type: "delivery", redelivered: message.fields.redelivered });
  const mode = process.env.RECOVERY_MODE;
  await handleMessage(
    pool,
    channel,
    message,
    mode === "after" || mode === "retry"
      ? () => barrier("afterCommit")
      : undefined,
    mode === "beforeCommit" ? () => barrier("beforeCommit") : undefined,
    {
      viacepLookup: async () => {
        await send({ type: "lookup" });
        if (mode === "lookup") await barrier("lookupBarrier");
        return {
          status: "found",
          address: { cep: "01001-000", uf: "SP", logradouro: "" },
        };
      },
      handler: async () => (mode === "retry" ? "transient" : "success"),
      viacepTimeoutMs: 1234,
    },
  );
  await channel.checkQueue(queue);
  await send({ type: "acked" });
  await channel.close();
  await broker.close();
  await pool.end();
  process.disconnect?.();
}
main().catch(() => {
  console.error("recovery child failed");
  process.exit(1);
});
