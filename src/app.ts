import cookieParser from "cookie-parser"
import express from "express"
import helmet from "helmet"

import { loadUser } from "./auth.ts"
import { config } from "./config.ts"
import { errorHandler } from "./http.ts"
import { adminRouter } from "./routes/admin.ts"
import { authRouter } from "./routes/auth.ts"
import { publicRouter } from "./routes/public.ts"
import { sellerRouter } from "./routes/seller.ts"

export function createApp() {
  const app = express()
  app.disable("x-powered-by")
  // The frontend proxies /api/* to this server (same-origin cookies), so no CORS is needed.
  app.use(helmet())
  app.use(express.json({ limit: "100kb" }))
  app.use(cookieParser())

  app.get("/health", (_req, res) => res.json({ ok: true, khqr: config.KHQR_MODE }))

  app.use("/api", loadUser)
  app.use("/api/auth", authRouter)
  app.use("/api/seller", sellerRouter)
  app.use("/api/admin", adminRouter)
  app.use("/api", publicRouter)

  app.use((_req, res) => res.status(404).json({ error: "Not found." }))
  app.use(errorHandler)
  return app
}
