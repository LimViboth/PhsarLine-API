import { Router } from "express"
import { z } from "zod"

import { requireRole } from "../auth.ts"
import { config } from "../config.ts"
import { query, queryOne, tx } from "../db.ts"
import { idParam, parse } from "../http.ts"
import { createKhqrCharge, newPaymentReference } from "../services/khqr.ts"
import { HttpError, listOrders, updateOrderStatus } from "../services/orders.ts"
import { recordMovement } from "../services/inventory.ts"
import { IMAGE_URL_SQL, imageBody, sniffImageType } from "../services/product-images.ts"
import { saveLogo } from "../services/shop-logo.ts"
import { logisticsRouter } from "./logistics.ts"
import { procurementRouter } from "./procurement.ts"

export const sellerRouter = Router()
sellerRouter.use(requireRole("seller"))

const TZ = "Asia/Phnom_Penh"
const sid = (req: { user?: { sellerId: number | null } }) => {
  if (!req.user?.sellerId) throw new HttpError(403, "No shop is linked to this account.")
  return req.user.sellerId
}

sellerRouter.use("/procurement", procurementRouter)
sellerRouter.use("/logistics", logisticsRouter)

const pct = (cur: number, prev: number) => (prev === 0 ? null : Math.round(((cur - prev) / prev) * 1000) / 10)

/** Paid revenue per day for the last 7 days (oldest first), in Cambodia time. */
const dailyRevenue = (sellerId: number) =>
  query<{ date: string; value: number }>(
    `SELECT d::date AS date, COALESCE(SUM(o.total), 0) AS value
       FROM generate_series((now() AT TIME ZONE '${TZ}')::date - 6, (now() AT TIME ZONE '${TZ}')::date, interval '1 day') d
       LEFT JOIN orders o ON o.seller_id = $1 AND o.status <> 'cancelled' AND o.payment_status = 'paid'
                         AND (o.created_at AT TIME ZONE '${TZ}')::date = d::date
      GROUP BY d ORDER BY d`,
    [sellerId]
  )

sellerRouter.get("/dashboard", async (req, res) => {
  const sellerId = sid(req)
  const stats = await queryOne<Record<string, number>>(
    `WITH base AS (
       SELECT total, status, payment_status, customer_phone,
              (created_at AT TIME ZONE '${TZ}')::date AS d
         FROM orders WHERE seller_id = $1),
     t AS (SELECT (now() AT TIME ZONE '${TZ}')::date AS today)
     SELECT
       COALESCE(SUM(total) FILTER (WHERE status <> 'cancelled' AND payment_status = 'paid' AND d > today - 7), 0) AS revenue,
       COALESCE(SUM(total) FILTER (WHERE status <> 'cancelled' AND payment_status = 'paid' AND d <= today - 7 AND d > today - 14), 0) AS "revenuePrev",
       COUNT(*) FILTER (WHERE status <> 'cancelled' AND d > today - 7) AS orders,
       COUNT(*) FILTER (WHERE status <> 'cancelled' AND d <= today - 7 AND d > today - 14) AS "ordersPrev",
       COUNT(DISTINCT customer_phone) FILTER (WHERE status <> 'cancelled' AND d > today - 7) AS customers,
       COUNT(DISTINCT customer_phone) FILTER (WHERE status <> 'cancelled' AND d <= today - 7 AND d > today - 14) AS "customersPrev"
       FROM base, t`,
    [sellerId]
  )
  const s = stats!
  const [daily, lowStock, live, recentOrders] = await Promise.all([
    dailyRevenue(sellerId),
    query(
      `SELECT p.id, p.name, i.quantity AS stock FROM products p JOIN inventory i ON i.product_id = p.id
        WHERE p.seller_id = $1 AND p.active AND i.quantity <= 8 ORDER BY i.quantity, p.name`,
      [sellerId]
    ),
    queryOne<{ n: number }>(
      `SELECT COUNT(*) AS n FROM products p JOIN inventory i ON i.product_id = p.id
        WHERE p.seller_id = $1 AND p.active AND i.quantity > 0`,
      [sellerId]
    ),
    listOrders(sellerId, undefined, 4),
  ])
  res.json({
    revenue: { value: s.revenue, delta: pct(s.revenue, s.revenuePrev) },
    orders: { value: s.orders, delta: pct(s.orders, s.ordersPrev) },
    customers: { value: s.customers, delta: pct(s.customers, s.customersPrev) },
    productsLive: live!.n,
    daily,
    lowStock,
    recentOrders,
  })
})

/* -------------------------------- Orders -------------------------------- */

sellerRouter.get("/orders", async (req, res) => {
  const status = parse(
    z.enum(["pending", "confirmed", "shipping", "delivered", "cancelled"]).optional(),
    req.query.status || undefined
  )
  res.json(await listOrders(sid(req), status))
})

sellerRouter.patch("/orders/:id/status", async (req, res) => {
  const { status } = parse(z.object({ status: z.enum(["confirmed", "cancelled"]) }), req.body)
  res.json(await updateOrderStatus(sid(req), idParam(req.params.id), status))
})

/* ------------------------------- Products ------------------------------- */

const productFields = {
  name: z.string().trim().min(1).max(120),
  category: z.string().trim().min(1).max(60),
  description: z.string().trim().max(2000),
  price: z.number().min(0).max(100000),
  cost: z.number().min(0).max(100000).nullable(),
  sizes: z.array(z.string().trim().min(1).max(40)).min(1).max(20),
  colors: z
    .array(z.object({ name: z.string().trim().min(1).max(40), hex: z.string().regex(/^#[0-9a-fA-F]{6}$/) }))
    .min(1)
    .max(20),
}

const LIST_PRODUCTS = `SELECT p.id, p.name, p.category, p.description, p.price, p.cost, p.sizes, p.colors, p.tone, p.active,
        ${IMAGE_URL_SQL},
        i.quantity AS stock,
        COALESCE((SELECT SUM(oi.quantity) FROM order_items oi JOIN orders o ON o.id = oi.order_id
                   WHERE oi.product_id = p.id AND o.status <> 'cancelled'), 0)::int AS sold
   FROM products p JOIN inventory i ON i.product_id = p.id`

sellerRouter.get("/products", async (req, res) => {
  res.json(await query(`${LIST_PRODUCTS} WHERE p.seller_id = $1 ORDER BY p.created_at DESC`, [sid(req)]))
})

const TONES = [
  "from-rose-200 to-orange-100",
  "from-sky-200 to-indigo-100",
  "from-amber-200 to-yellow-100",
  "from-lime-200 to-emerald-100",
  "from-orange-200 to-stone-100",
  "from-violet-200 to-pink-100",
]

sellerRouter.post("/products", async (req, res) => {
  const sellerId = sid(req)
  const body = parse(
    z.object({
      ...productFields,
      description: productFields.description.default(""),
      cost: productFields.cost.optional(),
      sizes: productFields.sizes.default(["One size"]),
      colors: productFields.colors.default([{ name: "Default", hex: "#a1a1aa" }]),
      stock: z.number().int().min(0).max(100000),
    }),
    req.body
  )
  const id = await tx(async (db) => {
    const { rows } = await db.query<{ id: number }>(
      `INSERT INTO products (seller_id, name, category, description, price, cost, sizes, colors, tone)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9) RETURNING id`,
      [sellerId, body.name, body.category, body.description, body.price, body.cost ?? null,
       JSON.stringify(body.sizes), JSON.stringify(body.colors), TONES[Math.floor(Math.random() * TONES.length)]]
    )
    await db.query("INSERT INTO inventory (product_id, quantity) VALUES ($1, $2)", [rows[0].id, body.stock])
    if (body.stock > 0) await recordMovement(db, rows[0].id, sellerId, body.stock, "initial", "new product")
    return rows[0].id
  })
  res.status(201).json(await queryOne(`${LIST_PRODUCTS} WHERE p.id = $1`, [id]))
})

sellerRouter.patch("/products/:id", async (req, res) => {
  const sellerId = sid(req)
  const id = idParam(req.params.id)
  const body = parse(
    z.object({
      name: productFields.name.optional(),
      category: productFields.category.optional(),
      description: productFields.description.optional(),
      price: productFields.price.optional(),
      cost: productFields.cost.optional(),
      sizes: productFields.sizes.optional(),
      colors: productFields.colors.optional(),
      active: z.boolean().optional(),
      stock: z.number().int().min(0).max(100000).optional(),
      stockDelta: z.number().int().min(-100000).max(100000).optional(),
    }),
    req.body
  )
  await tx(async (db) => {
    const owned = await db.query("SELECT 1 FROM products WHERE id = $1 AND seller_id = $2 FOR UPDATE", [id, sellerId])
    if (owned.rowCount === 0) throw new HttpError(404, "Product not found.")

    // Column names are a fixed allow-list; only the values come from the request.
    const cols: [string, unknown][] = [
      ["name", body.name], ["category", body.category], ["description", body.description],
      ["price", body.price], ["cost", body.cost], ["active", body.active],
      ["sizes", body.sizes && JSON.stringify(body.sizes)], ["colors", body.colors && JSON.stringify(body.colors)],
    ]
    const set = cols.filter(([, v]) => v !== undefined)
    if (set.length) {
      const jsonb = new Set(["sizes", "colors"])
      await db.query(
        `UPDATE products SET ${set.map(([c], i) => `${c} = $${i + 3}${jsonb.has(c) ? "::jsonb" : ""}`).join(", ")}
          WHERE id = $1 AND seller_id = $2`,
        [id, sellerId, ...set.map(([, v]) => v)]
      )
    }
    if (body.stock !== undefined || body.stockDelta !== undefined) {
      const { rows } = await db.query<{ quantity: number }>(
        "SELECT quantity FROM inventory WHERE product_id = $1 FOR UPDATE",
        [id]
      )
      const next = body.stock !== undefined ? body.stock : rows[0].quantity + (body.stockDelta ?? 0)
      if (next < 0) throw new HttpError(409, "Stock cannot go below zero.")
      const delta = next - rows[0].quantity
      if (delta !== 0) {
        await db.query("UPDATE inventory SET quantity = $1 WHERE product_id = $2", [next, id])
        await recordMovement(db, id, sellerId, delta, "adjustment", "manual")
      }
    }
  })
  res.json(await queryOne(`${LIST_PRODUCTS} WHERE p.id = $1`, [id]))
})

// Product photo: the browser sends the (already resized) image as the raw request body.
sellerRouter.put("/products/:id/image", imageBody, async (req, res) => {
  const id = idParam(req.params.id)
  const buf: unknown = req.body
  if (!Buffer.isBuffer(buf) || buf.length === 0) throw new HttpError(400, "Upload a JPEG, PNG or WebP image.")
  const type = sniffImageType(buf)
  if (!type) throw new HttpError(400, "That file isn't a valid JPEG, PNG or WebP image.")
  const row = await queryOne(
    `UPDATE products SET image_data = $3, image_type = $4, image_updated_at = now()
      WHERE id = $1 AND seller_id = $2 RETURNING id`,
    [id, sid(req), buf, type]
  )
  if (!row) throw new HttpError(404, "Product not found.")
  res.json(await queryOne(`${LIST_PRODUCTS} WHERE p.id = $1`, [id]))
})

sellerRouter.delete("/products/:id/image", async (req, res) => {
  const id = idParam(req.params.id)
  const row = await queryOne(
    `UPDATE products SET image_data = NULL, image_type = NULL, image_updated_at = NULL
      WHERE id = $1 AND seller_id = $2 RETURNING id`,
    [id, sid(req)]
  )
  if (!row) throw new HttpError(404, "Product not found.")
  res.json(await queryOne(`${LIST_PRODUCTS} WHERE p.id = $1`, [id]))
})

// Products that have been ordered or purchased keep their history; those can only be unlisted.
sellerRouter.delete("/products/:id", async (req, res) => {
  const id = idParam(req.params.id)
  const used = await queryOne(
    `SELECT 1 FROM products p WHERE p.id = $1 AND p.seller_id = $2
        AND (EXISTS (SELECT 1 FROM order_items WHERE product_id = p.id)
          OR EXISTS (SELECT 1 FROM purchase_order_items WHERE product_id = p.id))`,
    [id, sid(req)]
  )
  if (used) throw new HttpError(409, "This product has order or purchase history, so it cannot be deleted. Unlist it instead.")
  const gone = await queryOne("DELETE FROM products WHERE id = $1 AND seller_id = $2 RETURNING id", [id, sid(req)])
  if (!gone) throw new HttpError(404, "Product not found.")
  res.json({ ok: true })
})

// Stock ledger: every sale, cancellation, purchase receipt and manual adjustment.
sellerRouter.get("/stock-movements", async (req, res) => {
  res.json(
    await query(
      `SELECT m.id, p.name AS product, m.delta, m.reason, m.ref, m.created_at AS "createdAt"
         FROM stock_movements m JOIN products p ON p.id = m.product_id
        WHERE m.seller_id = $1 ORDER BY m.created_at DESC, m.id DESC LIMIT 100`,
      [sid(req)]
    )
  )
})

/* -------------------------------- Reports -------------------------------- */

sellerRouter.get("/reports", async (req, res) => {
  const sellerId = sid(req)
  const [daily, totals, mix, best] = await Promise.all([
    dailyRevenue(sellerId),
    queryOne<{ orders: number }>(
      `SELECT COUNT(*) AS orders FROM orders
        WHERE seller_id = $1 AND status <> 'cancelled' AND created_at > now() - interval '7 days'`,
      [sellerId]
    ),
    query<{ method: string; revenue: number }>(
      `SELECT payment_method AS method, COALESCE(SUM(total), 0) AS revenue FROM orders
        WHERE seller_id = $1 AND status <> 'cancelled' AND payment_status = 'paid' AND created_at > now() - interval '7 days'
        GROUP BY payment_method`,
      [sellerId]
    ),
    query(
      `SELECT oi.name, SUM(oi.quantity)::int AS units, SUM(oi.quantity * oi.unit_price) AS revenue
         FROM order_items oi JOIN orders o ON o.id = oi.order_id
        WHERE o.seller_id = $1 AND o.status <> 'cancelled'
        GROUP BY oi.name ORDER BY revenue DESC LIMIT 8`,
      [sellerId]
    ),
  ])
  const revenue = daily.reduce((sum, d) => sum + d.value, 0)
  const share = (m: string) => (revenue ? Math.round(((mix.find((x) => x.method === m)?.revenue ?? 0) / revenue) * 100) : 0)
  res.json({
    daily,
    revenue,
    orders: totals!.orders,
    avgOrderValue: totals!.orders ? revenue / totals!.orders : 0,
    khqrShare: share("khqr"),
    codShare: share("cod"),
    bestSellers: best,
  })
})

/* --------------------------- Billing & Telegram --------------------------- */

sellerRouter.get("/invoices", async (req, res) => {
  res.json(
    await query(
      `SELECT id, code, period, amount, status, due_date AS "dueDate", paid_at AS "paidAt"
         FROM invoices WHERE seller_id = $1 ORDER BY period DESC`,
      [sid(req)]
    )
  )
})

// Step 12: the seller pays the monthly Phsaline charge via KHQR.
sellerRouter.post("/invoices/:id/pay", async (req, res) => {
  const sellerId = sid(req)
  const invoice = await queryOne<{ id: number; amount: number; status: string }>(
    "SELECT id, amount, status FROM invoices WHERE id = $1 AND seller_id = $2",
    [idParam(req.params.id), sellerId]
  )
  if (!invoice) throw new HttpError(404, "Invoice not found.")
  if (invoice.status === "paid") throw new HttpError(409, "This invoice is already paid.")

  // Retire any earlier QR so only the newest one can be paid.
  await query("UPDATE payments SET state = 'failed' WHERE invoice_id = $1 AND state = 'pending'", [invoice.id])
  const reference = newPaymentReference()
  const charge = await createKhqrCharge({ reference, amount: invoice.amount })
  await query(
    `INSERT INTO payments (reference, invoice_id, method, amount, qr_payload, expires_at)
     VALUES ($1,$2,'khqr',$3,$4,$5)`,
    [reference, invoice.id, invoice.amount, charge.qrPayload, charge.expiresAt]
  )
  res.status(201).json({ reference, amount: invoice.amount, qrPayload: charge.qrPayload, expiresAt: charge.expiresAt })
})

sellerRouter.get("/invoices/:id/status", async (req, res) => {
  const row = await queryOne(
    "SELECT status FROM invoices WHERE id = $1 AND seller_id = $2",
    [idParam(req.params.id), sid(req)]
  )
  if (!row) throw new HttpError(404, "Invoice not found.")
  res.json(row)
})

sellerRouter.get("/shop", async (req, res) => {
  const shop = await queryOne<{
    name: string
    slug: string
    status: string
    linkCode: string
    linked: boolean
    botUsername: string | null
    logoUrl: string | null
  }>(
    `SELECT shop_name AS name, slug, status, telegram_link_code AS "linkCode",
            telegram_chat_id IS NOT NULL AS linked, bot_username AS "botUsername",
            CASE WHEN logo_type IS NOT NULL
                 THEN '/api/shops/' || slug || '/logo?v=' || EXTRACT(EPOCH FROM logo_updated_at)::bigint END AS "logoUrl"
       FROM sellers WHERE id = $1`,
    [sid(req)]
  )
  const bot = shop!.botUsername
  res.json({
    ...shop,
    shopUrl: `${config.FRONTEND_URL}/shop/${shop!.slug}`,
    // The store's own bot: customers chat with it, and the owner links their chat to it for alerts.
    customerBotLink: bot ? `https://t.me/${bot}` : null,
    sellerLinkUrl: bot ? `https://t.me/${bot}?start=link_${shop!.linkCode}` : null,
  })
})

// Shop logo: shown on the storefront and pushed to the store's Telegram bot as its picture.
sellerRouter.put("/logo", imageBody, async (req, res) => res.json(await saveLogo(sid(req), req.body)))
sellerRouter.delete("/logo", async (req, res) => res.json(await saveLogo(sid(req), null)))

// Bot setup (token, connect/disconnect) is admin-only: see PUT/DELETE /api/admin/sellers/:id/bot.
