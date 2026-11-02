import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import pg from "pg"

import { config } from "./config.ts"
import { pool } from "./db.ts"

/** Creates the target database if it doesn't exist yet (connects via the `postgres` maintenance DB). */
async function ensureDatabase() {
  const url = new URL(config.DATABASE_URL)
  const dbName = decodeURIComponent(url.pathname.slice(1))
  if (!/^[a-zA-Z0-9_]+$/.test(dbName)) throw new Error(`Unsafe database name: ${dbName}`)

  url.pathname = "/postgres"
  const admin = new pg.Client({ connectionString: url.toString() })
  await admin.connect()
  try {
    const exists = await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [dbName])
    if (exists.rowCount === 0) {
      await admin.query(`CREATE DATABASE "${dbName}"`)
      console.log(`Created database "${dbName}"`)
    }
  } finally {
    await admin.end()
  }
}

async function main() {
  await ensureDatabase()
  const sql = readFileSync(fileURLToPath(new URL("./sql/schema.sql", import.meta.url)), "utf8")
  await pool.query(sql)
  console.log("Schema is up to date.")
  await pool.end()
}

main().catch((err) => {
  console.error("Migration failed:", err.message)
  process.exit(1)
})
