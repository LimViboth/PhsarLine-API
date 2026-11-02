import { createApp } from "./app.ts"
import { config } from "./config.ts"
import { pool } from "./db.ts"
import { startAllBots, stopAllBots } from "./services/telegram.ts"

const app = createApp()
const server = app.listen(config.PORT, () => {
  console.log(`Phsaline API listening on http://localhost:${config.PORT} (KHQR: ${config.KHQR_MODE})`)
  void startAllBots().catch((e) => console.error("Failed to start store bots:", e.message))
})

function shutdown() {
  stopAllBots()
  server.close(() => pool.end().finally(() => process.exit(0)))
  setTimeout(() => process.exit(1), 5000).unref()
}
process.on("SIGINT", shutdown)
process.on("SIGTERM", shutdown)
