import type { ErrorRequestHandler } from "express"
import type { ZodType } from "zod"

import { isProd } from "./config.ts"
import { HttpError } from "./services/orders.ts"

/** Parse + validate untrusted input, turning failures into a 400 with a readable message. */
export function parse<T>(schema: ZodType<T>, data: unknown): T {
  const result = schema.safeParse(data)
  if (!result.success) {
    const issue = result.error.issues[0]
    const field = issue.path.join(".")
    throw new HttpError(400, field ? `${field}: ${issue.message}` : issue.message)
  }
  return result.data
}

export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message })
  if (err?.type === "entity.parse.failed") return res.status(400).json({ error: "Invalid JSON body." })
  if (err?.type === "entity.too.large") return res.status(413).json({ error: "That file is too large." })
  console.error(err)
  res.status(500).json({ error: isProd ? "Something went wrong." : String(err?.message ?? err) })
}

/** The shop id of the signed-in seller (routes are mounted behind requireRole("seller")). */
export const sellerIdOf = (req: { user?: { sellerId: number | null } }) => {
  if (!req.user?.sellerId) throw new HttpError(403, "No shop is linked to this account.")
  return req.user.sellerId
}

export const idParam = (v: unknown) => {
  const n = Number(v)
  if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, "Invalid id.")
  return n
}
