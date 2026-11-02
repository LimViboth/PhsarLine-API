import "dotenv/config"
import { z } from "zod"

const schema = z.object({
  PORT: z.coerce.number().default(4000),
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  FRONTEND_URL: z.string().url().default("http://localhost:3001"),
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  JWT_SECRET: z.string().min(32, "JWT_SECRET must be at least 32 characters"),
  // 32-byte hex key used to encrypt sellers' Telegram bot tokens at rest.
  BOT_TOKEN_KEY: z.string().regex(/^[0-9a-f]{64}$/i, "BOT_TOKEN_KEY must be 64 hex characters"),
  KHQR_MODE: z.enum(["mock", "live"]).default("mock"),
  KHQR_WEBHOOK_SECRET: z.string().optional().default(""),
  SEED_PASSWORD: z.string().optional().default(""),
})

const parsed = schema.safeParse(process.env)
if (!parsed.success) {
  console.error("Invalid environment configuration:")
  for (const issue of parsed.error.issues) console.error(`  ${issue.path.join(".")}: ${issue.message}`)
  console.error("\nCopy .env.example to .env and fill it in.")
  process.exit(1)
}

export const config = parsed.data
export const isProd = config.NODE_ENV === "production"
