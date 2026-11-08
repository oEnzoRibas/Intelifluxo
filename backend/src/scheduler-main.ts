import { database } from "./db.js";
import { scheduleOnce } from "./scheduler.js";

const pool = database();
try {
  console.log(
    JSON.stringify({
      event: "scheduler_sweep",
      released: await scheduleOnce(pool),
    }),
  );
} finally {
  await pool.end();
}
