import pg from "pg";
import { required } from "./config.js";

export function database(): pg.Pool {
  const pool = new pg.Pool({ connectionString: required("DATABASE_URL") });
  pool.on("error", () => console.error("database pool error"));
  return pool;
}

export async function transaction<T>(
  pool: pg.Pool,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const value = await fn(client);
    await client.query("COMMIT");
    return value;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
