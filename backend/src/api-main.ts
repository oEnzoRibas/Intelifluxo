import { api } from "./api.js";
import { database } from "./db.js";

const pool = database();
const port = Number(process.env.PORT ?? 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error("invalid PORT");
const app = api(pool);
app.addHook("onClose", async () => {
  await pool.end();
});
await app.listen({ port, host: "127.0.0.1" });
