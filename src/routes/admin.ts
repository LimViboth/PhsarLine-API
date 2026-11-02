import { randomBytes } from "node:crypto"
import bcrypt from "bcryptjs"
import { Router } from "express"
import { z } from "zod"

import { requireRole } from "../auth.ts"
import { query, queryOne, tx } from "../db.ts"
import { idParam, parse } from "../http.ts"
import { HttpError } from "../services/orders.ts"
import { getSettings, saveSettings } from "../services/settings.ts"
import { imageBody, LOGO_URL_SQL } from "../services/product-images.ts"
import { saveLogo } from "../services/shop-logo.ts"
import { connectBot, disconnectBot, syncBot } from "../services/telegram.ts"

export const adminRouter = Router()
adminRouter.use(requireRole("admin"))

const TZ = "Asia/Phnom_Penh"
const pct = (cur: number, prev: number) => (prev === 0 ? null : Math.round(((cur - prev) / prev) * 1000) / 10)

adminRouter.get("/overview", async (_req, res) => {
  const [totals, daily, attention, payments] = await Promise.all([
    queryOne<Record<string, number>>(
      `WITH t AS (SELECT (now() AT TIME ZONE '${TZ}')::date AS today)
       SELECT
         COALESCE((SELECT SUM(total) FROM orders WHERE status <> 'cancelled' AND payment_status = 'paid'), 0) AS gmv,
         COALESCE((SELECT SUM(total) FROM orders, t WHERE status <> 'cancelled' AND payment_status = 'paid'
                    AND (created_at AT TIME ZONE '${TZ}')::date > t.today - 7), 0) AS week,
         COALESCE((SELECT SUM(total) FROM orders, t WHERE status <> 'cancelled' AND payment_status = 'paid'
                    AND (created_at AT TIME ZONE '${TZ}')::date <= t.today - 7
                    AND (created_at AT TIME ZONE '${TZ}')::date > t.today - 14), 0) AS "weekPrev",
         (SELECT COUNT(*) FROM orders WHERE status <> 'cancelled') AS orders,
         (SELECT COUNT(*) FROM sellers WHERE status = 'active') AS "activeSellers",
         COALESCE((SELECT SUM(amount) FROM invoices WHERE status = 'paid' AND period = to_char(now() AT TIME ZONE '${TZ}', 'YYYY-MM')), 0) AS mrr`
    ),
    query<{ date: string; value: number }>(
      `SELECT d::date AS date, COALESCE(SUM(o.total), 0) AS value
         FROM generate_series((now() AT TIME ZONE '${TZ}')::date - 6, (now() AT TIME ZONE '${TZ}')::date, interval '1 day') d
         LEFT JOIN orders o ON o.status <> 'cancelled' AND o.payment_status = 'paid'
                           AND (o.created_at AT TIME ZONE '${TZ}')::date = d::date
        GROUP BY d ORDER BY d`
    ),
    query(
      `SELECT s.id, s.shop_name AS name, u.name AS owner, s.status,
              CASE WHEN s.status = 'pending' THEN 'pending'
                   WHEN EXISTS (SELECT 1 FROM invoices i WHERE i.seller_id = s.id AND i.status = 'due' AND i.due_date < CURRENT_DATE)
                        THEN 'overdue'
                   ELSE NULL END AS flag
         FROM sellers s JOIN users u ON u.id = s.user_id
        WHERE s.status = 'pending'
           OR EXISTS (SELECT 1 FROM invoices i WHERE i.seller_id = s.id AND i.status = 'due' AND i.due_date < CURRENT_DATE)
        ORDER BY s.created_at DESC LIMIT 8`
    ),
    query(
      `SELECT p.reference AS id, COALESCE(o.code, i.code) AS ref, p.method, p.amount, p.state,
              p.created_at AS "createdAt"
         FROM payments p LEFT JOIN orders o ON o.id = p.order_id LEFT JOIN invoices i ON i.id = p.invoice_id
        ORDER BY p.created_at DESC LIMIT 6`
    ),
  ])
  const t = totals!
  res.json({
    gmv: t.gmv,
    weekDelta: pct(t.week, t.weekPrev),
    orders: t.orders,
    activeSellers: t.activeSellers,
    mrr: t.mrr,
    daily,
    attention,
    payments,
  })
})

/* ------------------------------- Insights -------------------------------- */

// Platform-wide analytics for developers / stakeholders (read-only; every number is computed live).
adminRouter.get("/insights", async (_req, res) => {
  const day = `(o.created_at AT TIME ZONE '${TZ}')::date`
  const today = `(now() AT TIME ZONE '${TZ}')::date`
  const [totals, trend, statuses, methods, topSellers, topCategories, growth, billing, shipments] = await Promise.all([
    queryOne<Record<string, number>>(
      `SELECT
         COALESCE((SELECT SUM(total) FROM orders o WHERE status <> 'cancelled' AND payment_status = 'paid'), 0) AS gmv,
         COALESCE((SELECT SUM(total) FROM orders o WHERE status <> 'cancelled' AND payment_status = 'paid'
                    AND ${day} > ${today} - 30), 0) AS "gmv30",
         COALESCE((SELECT SUM(total) FROM orders o WHERE status <> 'cancelled' AND payment_status = 'paid'
                    AND ${day} <= ${today} - 30 AND ${day} > ${today} - 60), 0) AS "gmvPrev30",
         (SELECT COUNT(*) FROM orders) AS "ordersAll",
         (SELECT COUNT(*) FROM orders WHERE status = 'cancelled') AS cancelled,
         (SELECT COUNT(*) FROM orders WHERE status = 'delivered') AS delivered,
         COALESCE((SELECT AVG(total) FROM orders WHERE status <> 'cancelled'), 0) AS aov,
         (SELECT COUNT(DISTINCT customer_phone) FROM orders) AS customers,
         (SELECT COUNT(*) FROM sellers) AS "sellersTotal",
         (SELECT COUNT(*) FROM sellers WHERE status = 'active') AS "sellersActive",
         (SELECT COUNT(*) FROM sellers WHERE status = 'pending') AS "sellersPending",
         (SELECT COUNT(*) FROM sellers WHERE status = 'suspended') AS "sellersSuspended",
         (SELECT COUNT(*) FROM sellers WHERE bot_username IS NOT NULL) AS "sellersWithBot",
         (SELECT COUNT(*) FROM sellers s WHERE s.status = 'active'
             AND EXISTS (SELECT 1 FROM orders o WHERE o.seller_id = s.id AND ${day} > ${today} - 30)) AS "sellersSelling30",
         (SELECT COUNT(*) FROM products WHERE active) AS "productsLive",
         (SELECT COUNT(*) FROM products p JOIN inventory i ON i.product_id = p.id WHERE p.active AND i.quantity = 0) AS "outOfStock",
         (SELECT COUNT(*) FROM products p JOIN inventory i ON i.product_id = p.id WHERE p.active AND i.quantity BETWEEN 1 AND 8) AS "lowStock",
         (SELECT COUNT(*) FROM payments WHERE state = 'failed') AS "paymentsFailed",
         (SELECT COUNT(*) FROM payments WHERE state = 'pending' AND order_id IS NOT NULL) AS "paymentsPending"`
    ),
    query<{ date: string; value: number; orders: number }>(
      `SELECT d::date AS date,
              COALESCE(SUM(o.total) FILTER (WHERE o.payment_status = 'paid'), 0) AS value,
              COUNT(o.id) AS orders
         FROM generate_series(${today} - 29, ${today}, interval '1 day') d
         LEFT JOIN orders o ON o.status <> 'cancelled' AND ${day} = d::date
        GROUP BY d ORDER BY d`
    ),
    query<{ status: string; value: number }>(`SELECT status, COUNT(*) AS value FROM orders GROUP BY status`),
    query<{ method: string; orders: number; revenue: number }>(
      `SELECT payment_method AS method, COUNT(*) AS orders,
              COALESCE(SUM(total) FILTER (WHERE payment_status = 'paid'), 0) AS revenue
         FROM orders WHERE status <> 'cancelled' GROUP BY payment_method`
    ),
    query<{ id: number; name: string; value: number; orders: number }>(
      `SELECT s.id, s.shop_name AS name,
              COALESCE(SUM(o.total) FILTER (WHERE o.payment_status = 'paid'), 0) AS value,
              COUNT(o.id) AS orders
         FROM sellers s LEFT JOIN orders o ON o.seller_id = s.id AND o.status <> 'cancelled'
        GROUP BY s.id ORDER BY value DESC, orders DESC LIMIT 5`
    ),
    query<{ name: string; value: number }>(
      `SELECT p.category AS name, SUM(oi.quantity * oi.unit_price) AS value
         FROM order_items oi
         JOIN orders o ON o.id = oi.order_id AND o.status <> 'cancelled'
         JOIN products p ON p.id = oi.product_id
        GROUP BY p.category ORDER BY value DESC LIMIT 6`
    ),
    query<{ period: string; value: number }>(
      `SELECT to_char(m, 'YYYY-MM') AS period, COUNT(s.id) AS value
         FROM generate_series(date_trunc('month', now() AT TIME ZONE '${TZ}') - interval '5 months',
                              date_trunc('month', now() AT TIME ZONE '${TZ}'), interval '1 month') m
         LEFT JOIN sellers s ON date_trunc('month', s.created_at AT TIME ZONE '${TZ}') = m
        GROUP BY m ORDER BY m`
    ),
    queryOne<Record<string, number>>(
      `SELECT COALESCE(SUM(amount) FILTER (WHERE status = 'paid'), 0) AS paid,
              COALESCE(SUM(amount) FILTER (WHERE status = 'due' AND due_date >= CURRENT_DATE), 0) AS due,
              COALESCE(SUM(amount) FILTER (WHERE status = 'due' AND due_date < CURRENT_DATE), 0) AS overdue
         FROM invoices WHERE period = to_char(now() AT TIME ZONE '${TZ}', 'YYYY-MM')`
    ),
    query<{ status: string; value: number }>(`SELECT status, COUNT(*) AS value FROM shipments GROUP BY status`),
  ])
  const t = totals!
  const b = billing!
  const invoiced = b.paid + b.due + b.overdue
  const rate = (n: number, d: number) => (d === 0 ? null : Math.round((n / d) * 1000) / 10)
  res.json({
    kpis: {
      gmv: t.gmv,
      gmv30: t.gmv30,
      gmv30Delta: pct(t.gmv30, t.gmvPrev30),
      orders: t.ordersAll,
      aov: t.aov,
      customers: t.customers,
      cancelRate: rate(t.cancelled, t.ordersAll),
      deliveredRate: rate(t.delivered, t.ordersAll - t.cancelled),
    },
    sellers: {
      total: t.sellersTotal,
      active: t.sellersActive,
      pending: t.sellersPending,
      suspended: t.sellersSuspended,
      sellingLast30: t.sellersSelling30,
      withBot: t.sellersWithBot,
    },
    catalog: { productsLive: t.productsLive, outOfStock: t.outOfStock, lowStock: t.lowStock },
    payments: { failed: t.paymentsFailed, pending: t.paymentsPending },
    billing: { ...b, invoiced, collectionRate: rate(b.paid, invoiced) },
    trend,
    statuses,
    methods,
    topSellers,
    topCategories,
    growth,
    shipments,
  })
})

/* -------------------------------- Sellers -------------------------------- */

adminRouter.get("/sellers", async (_req, res) => {
  res.json(
    await query(
      `SELECT s.id, s.shop_name AS name, s.slug, u.name AS owner, u.email, s.plan, s.status,
              s.bot_username AS "botUsername", ${LOGO_URL_SQL},
              COUNT(o.id) FILTER (WHERE o.status <> 'cancelled')::int AS orders,
              COALESCE(SUM(o.total) FILTER (WHERE o.status <> 'cancelled' AND o.payment_status = 'paid'), 0) AS revenue,
              (SELECT CASE
                        WHEN COUNT(*) = 0 THEN 'trial'
                        WHEN bool_or(i.status = 'due' AND i.due_date < CURRENT_DATE) THEN 'overdue'
                        WHEN bool_or(i.status = 'due') THEN 'due'
                        ELSE 'paid' END
                 FROM invoices i WHERE i.seller_id = s.id) AS billing
         FROM sellers s
         JOIN users u ON u.id = s.user_id
         LEFT JOIN orders o ON o.seller_id = s.id
        GROUP BY s.id, u.id ORDER BY s.created_at DESC`
    )
  )
})

const slugify = (s: string) =>
  s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40)

adminRouter.post("/sellers", async (req, res) => {
  const body = parse(
    z.object({
      shopName: z.string().trim().min(2).max(80),
      ownerName: z.string().trim().min(1).max(100),
      email: z.string().trim().toLowerCase().email(),
      password: z.string().min(8).max(200),
      plan: z.enum(["standard", "premium"]).default("standard"),
    }),
    req.body
  )
  const base = slugify(body.shopName)
  if (!base) throw new HttpError(400, "shopName: use letters or numbers in the shop name")
  const hash = await bcrypt.hash(body.password, 10)

  try {
    const seller = await tx(async (db) => {
      const { rows: u } = await db.query<{ id: number }>(
        "INSERT INTO users (email, password_hash, name, role) VALUES ($1,$2,$3,'seller') RETURNING id",
        [body.email, hash, body.ownerName]
      )
      // Find a free slug (krama-house, krama-house-2, ...).
      let slug = base
      for (let n = 2; (await db.query("SELECT 1 FROM sellers WHERE slug = $1", [slug])).rowCount; n++) slug = `${base}-${n}`
      const { rows: s } = await db.query<{ id: number; slug: string }>(
        `INSERT INTO sellers (user_id, shop_name, slug, plan, status, telegram_link_code)
         VALUES ($1,$2,$3,$4,'active',$5) RETURNING id, slug`,
        [u[0].id, body.shopName, slug, body.plan, randomBytes(4).toString("hex").toUpperCase()]
      )
      return s[0]
    })
    res.status(201).json(seller)
  } catch (err) {
    if ((err as { code?: string }).code === "23505") throw new HttpError(409, "An account with this email already exists.")
    throw err
  }
})

// Telegram bot setup is done by the platform team, not sellers. The token is never returned.
adminRouter.put("/sellers/:id/bot", async (req, res) => {
  const { token } = parse(z.object({ token: z.string().trim().min(10).max(200) }), req.body)
  const id = idParam(req.params.id)
  if (!(await queryOne("SELECT 1 FROM sellers WHERE id = $1", [id]))) throw new HttpError(404, "Seller not found.")
  res.json({ botUsername: await connectBot(id, token) })
})

adminRouter.delete("/sellers/:id/bot", async (req, res) => {
  const id = idParam(req.params.id)
  if (!(await queryOne("SELECT 1 FROM sellers WHERE id = $1", [id]))) throw new HttpError(404, "Seller not found.")
  await disconnectBot(id)
  res.json({ ok: true })
})

adminRouter.put("/sellers/:id/logo", imageBody, async (req, res) => res.json(await saveLogo(idParam(req.params.id), req.body)))
adminRouter.delete("/sellers/:id/logo", async (req, res) => res.json(await saveLogo(idParam(req.params.id), null)))

adminRouter.patch("/sellers/:id/status", async (req, res) => {
  const { status } = parse(z.object({ status: z.enum(["pending", "active", "suspended"]) }), req.body)
  const row = await queryOne("UPDATE sellers SET status = $1 WHERE id = $2 RETURNING id, status", [status, idParam(req.params.id)])
  if (!row) throw new HttpError(404, "Seller not found.")
  await syncBot(idParam(req.params.id)) // suspending a store stops its bot; activating starts it
  res.json(row)
})

/* ------------------------------ Payments / config ------------------------------ */

adminRouter.get("/payments", async (_req, res) => {
  res.json(
    await query(
      `SELECT p.reference AS id, COALESCE(o.code, i.code) AS ref, p.method, p.amount, p.state,
              p.created_at AS "createdAt",
              CASE WHEN p.invoice_id IS NOT NULL THEN 'invoice' ELSE 'order' END AS kind
         FROM payments p LEFT JOIN orders o ON o.id = p.order_id LEFT JOIN invoices i ON i.id = p.invoice_id
        ORDER BY p.created_at DESC LIMIT 200`
    )
  )
})

adminRouter.get("/config", async (_req, res) => {
  res.json(await getSettings())
})

adminRouter.put("/config", async (req, res) => {
  const patch = parse(
    z.object({
      standard_fee: z.number().min(0).max(10000),
      invoice_due_day: z.number().int().min(1).max(28),
      delivery_fee: z.number().min(0).max(1000),
      khqr_enabled: z.boolean(),
      cod_enabled: z.boolean(),
      signups_open: z.boolean(),
      telegram_alerts: z.boolean(),
    }).partial(),
    req.body
  )
  await saveSettings(patch)
  res.json(await getSettings())
})

// Creates this month's invoice for every active seller. Safe to run repeatedly.
adminRouter.post("/invoices/generate", async (_req, res) => {
  const { standard_fee, invoice_due_day } = await getSettings()
  const created = await query<{ id: number }>(
    `WITH m AS (
       SELECT to_char(now() AT TIME ZONE '${TZ}', 'YYYY-MM') AS period,
              date_trunc('month', now() AT TIME ZONE '${TZ}')::date AS first_day)
     INSERT INTO invoices (code, seller_id, period, amount, due_date)
     SELECT 'INV-' || replace(m.period, '-', '') || '-' || lpad(s.id::text, 4, '0'), s.id, m.period, $1,
            m.first_day + ($2::int - 1)
       FROM sellers s, m WHERE s.status = 'active'
     ON CONFLICT (seller_id, period) DO NOTHING
     RETURNING id`,
    [standard_fee, invoice_due_day]
  )
  res.json({ created: created.length })
})
