import { connectBroker } from "./broker.js";
import { database } from "./db.js";
import { relayOnce } from "./relay.js";

const pool = database();
try {
  const connection = await connectBroker();
  try {
    const channel = await connection.createConfirmChannel();
    channel.on("error", () => console.error("broker channel error"));
    console.log(
      JSON.stringify({
        event: "relay_sweep",
        confirmed: await relayOnce(pool, channel),
      }),
    );
    await channel.close();
  } finally {
    await connection.close();
  }
} finally {
  await pool.end();
}
