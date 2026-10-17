import { drizzle } from "drizzle-orm/node-postgres"
import pg from "pg"

import * as schema from "./schema.js"

export type Db = ReturnType<typeof createDb>["db"]

export function createDb(url: string, max = 10) {
  const pool = new pg.Pool({ connectionString: url, max })
  const db = drizzle({ client: pool, schema })
  return { db, pool }
}
