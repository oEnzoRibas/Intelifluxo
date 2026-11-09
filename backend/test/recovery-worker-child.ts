// Test-only subprocesses use the production adapters with an isolated queue.
import {
  assertIsolatedQueue,
  connectDemoBroker,
  deadline,
  destroyBroker,
} from "./automation-demo-bounds.js";
import { database } from "../src/db.js";
import { relayOnce } from "../src/relay.js";
import { handleMessage } from "../src/worker.js";

const name = process.env.RECOVERY_QUEUE;
if (!name) throw new Error("isolated recovery queue required");
assertIsolatedQueue(name);
const pool = database();
const connection = await connectDemoBroker();
if (process.argv[2] === "relay") {
  const channel = await deadline(
    "confirm channel",
    () => connection.createConfirmChannel(),
    undefined,
    () => destroyBroker(connection),
  );
  await deadline(
    "relay",
    () => relayOnce(pool, channel, name),
    undefined,
    () => destroyBroker(connection),
  );
  await deadline(
    "channel close",
    () => channel.close(),
    undefined,
    () => destroyBroker(connection),
  );
  await deadline(
    "broker close",
    () => connection.close(),
    undefined,
    () => destroyBroker(connection),
  );
  await pool.end();
} else if (["barrier", "worker"].includes(process.argv[2])) {
  const channel = await deadline(
    "channel",
    () => connection.createChannel(),
    undefined,
    () => destroyBroker(connection),
  );
  channel.on("error", () => console.error("worker channel error"));
  await deadline(
    "declare queue",
    () => channel.assertQueue(name, { durable: true }),
    undefined,
    () => destroyBroker(connection),
  );
  await deadline(
    "prefetch",
    () => channel.prefetch(1),
    undefined,
    () => destroyBroker(connection),
  );
  await deadline(
    "consume",
    () =>
      channel.consume(name, (message) => {
        if (!message) {
          console.error("consumer cancelled");
          process.exit(1);
        }
        void handleMessage(
          pool,
          channel,
          message,
          process.argv[2] === "barrier"
            ? async () => {
                console.log("COMMITTED_UNACKED");
                await new Promise<void>(() => {});
              }
            : undefined,
        )
          .then(async () => {
            // A channel RPC after ack establishes that the broker processed it.
            await deadline(
              "check queue",
              () => channel.checkQueue(name),
              undefined,
              () => destroyBroker(connection),
            );
            console.log("ACKED");
          })
          .catch((error: unknown) => {
            console.error(error);
            process.exit(1);
          });
      }),
    undefined,
    () => destroyBroker(connection),
  );
  console.log("READY");
} else throw new Error("unknown recovery subprocess mode");
