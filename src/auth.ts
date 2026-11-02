import type { NextFunction, Request, Response } from "express"
import jwt from "jsonwebtoken"

import { config, isProd } from "./config.ts"
import { queryOne } from "./db.ts"

export type AuthUser = {
  id: number
  role: "seller" | "admin"
  name: string
  email: string
  sellerId: number | null
}

const COOKIE = "phsaline_token"
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

declare module "express-serve-static-core" {
  interface Request {
    user?: AuthUser
  }
}

export function setSession(res: Response, userId: number) {
  const token = jwt.sign({}, config.JWT_SECRET, { subject: String(userId), expiresIn: "7d" })
  res.cookie(COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: isProd,
    maxAge: MAX_AGE_MS,
    path: "/",
  })
}

export function clearSession(res: Response) {
  res.clearCookie(COOKIE, { path: "/" })
}

/** Loads the user from the cookie on every request (so suspensions/role changes apply immediately). */
export async function loadUser(req: Request, _res: Response, next: NextFunction) {
  try {
    const token = req.cookies?.[COOKIE]
    if (token) {
      const payload = jwt.verify(token, config.JWT_SECRET, { algorithms: ["HS256"] })
      const userId = Number(typeof payload === "string" ? NaN : payload.sub)
      if (!Number.isInteger(userId)) throw new Error("bad token")
      const user = await queryOne<AuthUser>(
        `SELECT u.id, u.role, u.name, u.email, s.id AS "sellerId"
           FROM users u LEFT JOIN sellers s ON s.user_id = u.id
          WHERE u.id = $1`,
        [userId]
      )
      if (user) req.user = user
    }
  } catch {
    // invalid/expired token -> treated as anonymous
  }
  next()
}

export function requireRole(role: AuthUser["role"]) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return res.status(401).json({ error: "Please sign in." })
    if (req.user.role !== role) return res.status(403).json({ error: "You don't have access to this." })
    next()
  }
}
