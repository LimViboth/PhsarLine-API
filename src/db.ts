import pg from "pg"

import { config } from "./config.ts"

// NUMERIC (1700) -> number, BIGINT (20) -> number. Safe at this app's scale.
pg.types.setTypeParser(1700, (v) => parseFloat(v))
pg.types.setTypeParser(20, (v) => parseInt(v, 10))
// DATE (1082) stays a plain "YYYY-MM-DD" string instead of a timezone-shifted JS Date.
pg.types.setTypeParser(1082, (v) => v)

export const pool = new pg.Pool({ connectionString: config.DATABASE_URL })

export type Queryable = Pick<pg.Pool | pg.PoolClient, "query">

export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params: unknown[] = [],
  db: Queryable = pool
) {
  return (await db.query<T>(text, params)).rows
}

export async function queryOne<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params: unknown[] = [],
  db: Queryable = pool
) {
  return (await query<T>(text, params, db))[0] ?? null
}

export async function tx<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect()
  try {
    await client.query("BEGIN")
    const result = await fn(client)
    await client.query("COMMIT")
    return result
  } catch (err) {
    await client.query("ROLLBACK")
    throw err
  } finally {
    client.release()
  }
}
