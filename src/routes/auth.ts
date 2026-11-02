import bcrypt from "bcryptjs"
import { Router } from "express"
import rateLimit from "express-rate-limit"
import { z } from "zod"

import { clearSession, setSession } from "../auth.ts"
import { queryOne } from "../db.ts"
import { parse } from "../http.ts"
import { HttpError } from "../services/orders.ts"
import { imageBody, sniffImageType } from "../services/product-images.ts"

export const authRouter = Router()

/** The signed-in user's picture URL (versioned so browsers refetch after a change), or null. */
async function avatarUrlOf(userId: number) {
  const row = await queryOne<{ url: string | null }>(
    `SELECT CASE WHEN avatar_type IS NOT NULL
              THEN '/api/auth/avatar?v=' || EXTRACT(EPOCH FROM avatar_updated_at)::bigint END AS url
       FROM users WHERE id = $1`,
    [userId]
  )
  return row?.url ?? null
}

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  skipSuccessfulRequests: true,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { error: "Too many failed attempts. Try again in 15 minutes." },
})

// Compared against when the email doesn't exist, so response time doesn't reveal valid emails.
const DUMMY_HASH = bcrypt.hashSync("not-a-real-password", 10)

authRouter.post("/login", loginLimiter, async (req, res) => {
  const { email, password } = parse(
    z.object({ email: z.string().trim().toLowerCase().email(), password: z.string().min(1).max(200) }),
    req.body
  )
  const user = await queryOne<{ id: number; password_hash: string; role: string }>(
    "SELECT id, password_hash, role FROM users WHERE email = $1",
    [email]
  )
  const ok = await bcrypt.compare(password, user?.password_hash ?? DUMMY_HASH)
  if (!user || !ok) throw new HttpError(401, "Incorrect email or password.")
  setSession(res, user.id)
  res.json({ role: user.role })
})

authRouter.post("/logout", (_req, res) => {
  clearSession(res)
  res.json({ ok: true })
})

authRouter.get("/me", async (req, res) => {
  if (!req.user) return res.status(401).json({ error: "Not signed in." })
  const { id, role, name, email } = req.user
  res.json({ id, role, name, email, avatarUrl: await avatarUrlOf(id) })
})

// Profile picture. Only ever served to its owner (it's their own session's picture), never publicly.
authRouter.get("/avatar", async (req, res) => {
  const user = signedIn(req)
  const row = await queryOne<{ data: Buffer; type: string }>(
    "SELECT avatar_data AS data, avatar_type AS type FROM users WHERE id = $1 AND avatar_data IS NOT NULL",
    [user.id]
  )
  if (!row) throw new HttpError(404, "No profile picture.")
  res.set("Content-Type", row.type)
  res.set("Cache-Control", "private, max-age=31536000, immutable") // URL is versioned (?v=)
  res.send(row.data)
})

authRouter.put("/avatar", imageBody, async (req, res) => {
  const user = signedIn(req)
  const buf: unknown = req.body
  if (!Buffer.isBuffer(buf) || buf.length === 0) throw new HttpError(400, "Upload a JPEG, PNG or WebP image.")
  const type = sniffImageType(buf)
  if (!type) throw new HttpError(400, "That file isn't a valid JPEG, PNG or WebP image.")
  await queryOne("UPDATE users SET avatar_data = $2, avatar_type = $3, avatar_updated_at = now() WHERE id = $1", [user.id, buf, type])
  res.json({ avatarUrl: await avatarUrlOf(user.id) })
})

authRouter.delete("/avatar", async (req, res) => {
  const user = signedIn(req)
  await queryOne("UPDATE users SET avatar_data = NULL, avatar_type = NULL, avatar_updated_at = NULL WHERE id = $1", [user.id])
  res.json({ avatarUrl: null })
})

// --- Profile (shared by sellers and admins) ---------------------------------------------

function signedIn(req: { user?: { id: number } }) {
  if (!req.user) throw new HttpError(401, "Please sign in.")
  return req.user
}

authRouter.get("/profile", async (req, res) => {
  const user = signedIn(req)
  const row = await queryOne<{ createdAt: string; shopName: string | null; slug: string | null; shopStatus: string | null }>(
    `SELECT u.created_at AS "createdAt", s.shop_name AS "shopName", s.slug, s.status AS "shopStatus"
       FROM users u LEFT JOIN sellers s ON s.user_id = u.id
      WHERE u.id = $1`,
    [user.id]
  )
  res.json({
    id: user.id,
    name: req.user!.name,
    email: req.user!.email,
    role: req.user!.role,
    avatarUrl: await avatarUrlOf(user.id),
    createdAt: row?.createdAt ?? null,
    shopName: row?.shopName ?? null,
    slug: row?.slug ?? null,
    shopStatus: row?.shopStatus ?? null,
  })
})

authRouter.patch("/profile", async (req, res) => {
  const user = signedIn(req)
  const body = parse(
    z.object({
      // Every field is optional: send only what you want to change (e.g. just `name`).
      name: z.string().trim().min(1).max(100).optional(),
      email: z.string().trim().toLowerCase().email().max(200).optional(),
      shopName: z.string().trim().min(1).max(100).optional(),
      currentPassword: z.string().max(200).optional(),
    }),
    req.body
  )

  // Only an actual email change needs the current password (so a hijacked session can't lock the owner out).
  // A name or shop-name change never does.
  const emailChanged = body.email !== undefined && body.email !== req.user!.email.toLowerCase()
  if (emailChanged) {
    const row = await queryOne<{ password_hash: string }>("SELECT password_hash FROM users WHERE id = $1", [user.id])
    if (!body.currentPassword || !row || !(await bcrypt.compare(body.currentPassword, row.password_hash))) {
      throw new HttpError(403, "Enter your current password to change your email.")
    }
  }

  try {
    await queryOne("UPDATE users SET name = COALESCE($1, name), email = COALESCE($2, email) WHERE id = $3", [
      body.name ?? null,
      emailChanged ? body.email : null,
      user.id,
    ])
  } catch (err) {
    if ((err as { code?: string }).code === "23505") throw new HttpError(409, "An account with this email already exists.")
    throw err
  }
  if (body.shopName && req.user!.sellerId) {
    await queryOne("UPDATE sellers SET shop_name = $1 WHERE id = $2", [body.shopName, req.user!.sellerId])
  }
  res.json({ ok: true })
})

authRouter.post("/password", async (req, res) => {
  const user = signedIn(req)
  const { currentPassword, newPassword } = parse(
    z.object({ currentPassword: z.string().min(1).max(200), newPassword: z.string().min(8).max(200) }),
    req.body
  )
  const row = await queryOne<{ password_hash: string }>("SELECT password_hash FROM users WHERE id = $1", [user.id])
  if (!row || !(await bcrypt.compare(currentPassword, row.password_hash))) {
    throw new HttpError(403, "Current password is incorrect.")
  }
  await queryOne("UPDATE users SET password_hash = $1 WHERE id = $2", [await bcrypt.hash(newPassword, 10), user.id])
  res.json({ ok: true })
})
