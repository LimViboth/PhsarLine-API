import { timingSafeEqual } from "node:crypto"
import { Router } from "express"
import rateLimit from "express-rate-limit"
import { z } from "zod"

import { config, isProd } from "../config.ts"
import { query, queryOne } from "../db.ts"
import { idParam, parse } from "../http.ts"
import { createOrder, HttpError } from "../services/orders.ts"
import { IMAGE_URL_SQL } from "../services/product-images.ts"
import { settlePayment } from "../services/payments.ts"
import { getSettings } from "../services/settings.ts"

export const publicRouter = Router()

const orderLimiter = rateLimit({ windowMs: 10 * 60 * 1000, limit: 20, standardHeaders: "draft-8", legacyHeaders: false })
const slugRe = /^[a-z0-9-]+$/

const PRODUCT_COLUMNS = `p.id, p.name, p.category, p.description, p.price, p.sizes, p.colors, p.tone,
  ${IMAGE_URL_SQL},
  i.quantity AS stock,
  COALESCE((SELECT SUM(oi.quantity) FROM order_items oi JOIN orders o ON o.id = oi.order_id
             WHERE oi.product_id = p.id AND o.status <> 'cancelled'), 0)::int AS sold`

async function activeShop(slug: string) {
  if (!slugRe.test(slug)) throw new HttpError(404, "Shop not found.")
  const shop = await queryOne<{ id: number; name: string; slug: string; botUsername: string | null }>(
    `SELECT id, shop_name AS name, slug, bot_username AS "botUsername" FROM sellers WHERE slug = $1 AND status = 'active'`,
    [slug]
  )
  if (!shop) throw new HttpError(404, "Shop not found.")
  return shop
}

publicRouter.get("/config", async (_req, res) => {
  const s = await getSettings()
  res.json({ khqr: s.khqr_enabled, cod: s.cod_enabled, deliveryFee: s.delivery_fee })
})

publicRouter.get("/shops", async (_req, res) => {
  res.json(
    await query(
      `SELECT s.shop_name AS name, s.slug,
              (SELECT COUNT(*) FROM products p WHERE p.seller_id = s.id AND p.active)::int AS "productCount"
         FROM sellers s WHERE s.status = 'active' ORDER BY s.shop_name`
    )
  )
})

publicRouter.get("/shops/:slug", async (req, res) => {
  const shop = await activeShop(String(req.params.slug))
  const products = await query(
    `SELECT ${PRODUCT_COLUMNS}
       FROM products p JOIN inventory i ON i.product_id = p.id
      WHERE p.seller_id = $1 AND p.active ORDER BY p.created_at DESC`,
    [shop.id]
  )
  res.json({
    shop: { name: shop.name, slug: shop.slug, telegramUrl: shop.botUsername ? `https://t.me/${shop.botUsername}` : null },
    products,
  })
})

// Shop logo. Public for active shops; admins and the owner can also preview a pending/suspended shop's.
publicRouter.get("/shops/:slug/logo", async (req, res) => {
  const slug = String(req.params.slug)
  if (!slugRe.test(slug)) throw new HttpError(404, "Logo not found.")
  const row = await queryOne<{ data: Buffer; type: string; id: number; status: string }>(
    "SELECT logo_data AS data, logo_type AS type, id, status FROM sellers WHERE slug = $1 AND logo_data IS NOT NULL",
    [slug]
  )
  const listed = row?.status === "active"
  const allowed = listed || (!!row && (req.user?.role === "admin" || req.user?.sellerId === row.id))
  if (!row || !allowed) throw new HttpError(404, "Logo not found.")
  res.set("Content-Type", row.type)
  res.set("Cache-Control", listed ? "public, max-age=31536000, immutable" : "private, no-store")
  res.send(row.data)
})

// Product photo. Public for listed products in active shops; an owner can also preview their own unlisted ones.
publicRouter.get("/products/:id/image", async (req, res) => {
  const row = await queryOne<{ data: Buffer; type: string; sellerId: number; listed: boolean }>(
    `SELECT p.image_data AS data, p.image_type AS type, p.seller_id AS "sellerId",
            (p.active AND s.status = 'active') AS listed
       FROM products p JOIN sellers s ON s.id = p.seller_id
      WHERE p.id = $1 AND p.image_data IS NOT NULL`,
    [idParam(req.params.id)]
  )
  const isOwner = !!row && req.user?.sellerId === row.sellerId
  if (!row || (!row.listed && !isOwner)) throw new HttpError(404, "Image not found.")
  res.set("Content-Type", row.type)
  // The URL carries a version (?v=), so listed images can be cached hard; unlisted previews never are.
  res.set("Cache-Control", row.listed ? "public, max-age=31536000, immutable" : "private, no-store")
  res.send(row.data)
})

publicRouter.get("/shops/:slug/products/:id", async (req, res) => {
  const shop = await activeShop(String(req.params.slug))
  const product = await queryOne(
    `SELECT ${PRODUCT_COLUMNS}
       FROM products p JOIN inventory i ON i.product_id = p.id
      WHERE p.id = $1 AND p.seller_id = $2 AND p.active`,
    [idParam(req.params.id), shop.id]
  )
  if (!product) throw new HttpError(404, "Product not found.")
  res.json({ shop: { name: shop.name, slug: shop.slug }, product })
})

const orderSchema = z.object({
  customer: z.object({
    name: z.string().trim().min(1).max(100),
    phone: z.string().trim().regex(/^[+\d][\d\s-]{6,19}$/, "Enter a valid phone number"),
    telegram: z.string().trim().max(64).optional(),
  }),
  address: z.string().trim().min(5).max(500),
  latitude: z.number().min(-90).max(90).optional(),
  longitude: z.number().min(-180).max(180).optional(),
  paymentMethod: z.enum(["cod", "khqr"]),
  items: z
    .array(
      z.object({
        productId: z.number().int().positive(),
        size: z.string().min(1).max(40),
        color: z.string().min(1).max(40),
        quantity: z.number().int().min(1).max(20),
      })
    )
    .min(1)
    .max(20),
})

// Step 6/7: place the order. Prices are always taken from the database, never from the client.
publicRouter.post("/shops/:slug/orders", orderLimiter, async (req, res) => {
  const slug = String(req.params.slug)
  if (!slugRe.test(slug)) throw new HttpError(404, "Shop not found.")
  const body = parse(orderSchema, req.body)
  const result = await createOrder({ shopSlug: slug, ...body })
  res.status(201).json(result)
})

// Public order status, looked up by the unguessable order code. Contains no contact details.
publicRouter.get("/orders/:code", async (req, res) => {
  const order = await queryOne<{ id: number }>("SELECT id FROM orders WHERE code = $1", [String(req.params.code).toUpperCase()])
  if (!order) throw new HttpError(404, "Order not found.")
  const full = await queryOne(
    `SELECT o.code, o.status, o.payment_method AS "paymentMethod", o.payment_status AS "paymentStatus",
            o.subtotal, o.delivery_fee AS "deliveryFee", o.total, s.shop_name AS shop,
            (SELECT json_agg(json_build_object('name', oi.name, 'size', oi.size, 'color', oi.color,
                                                'quantity', oi.quantity, 'unitPrice', oi.unit_price) ORDER BY oi.id)
               FROM order_items oi WHERE oi.order_id = o.id) AS items,
            (SELECT json_build_object('reference', p.reference, 'state', p.state,
                                       'qrPayload', CASE WHEN p.state = 'pending' THEN p.qr_payload END,
                                       'expiresAt', p.expires_at)
               FROM payments p WHERE p.order_id = o.id ORDER BY p.id DESC LIMIT 1) AS payment,
            (SELECT json_build_object('status', sh.status, 'trackingCode', sh.tracking_code, 'courier', c.name,
                      'events', COALESCE((SELECT json_agg(json_build_object('status', e.status, 'note', e.note, 'at', e.created_at)
                                                          ORDER BY e.created_at, e.id)
                                            FROM shipment_events e WHERE e.shipment_id = sh.id), '[]'))
               FROM shipments sh LEFT JOIN couriers c ON c.id = sh.courier_id WHERE sh.order_id = o.id) AS shipment
       FROM orders o JOIN sellers s ON s.id = o.seller_id WHERE o.id = $1`,
    [order.id]
  )
  res.json(full)
})

/* ------------------------------ KHQR payments ------------------------------ */

// Real gateway callback. Authenticated with a shared secret; settlement is idempotent.
publicRouter.post("/payments/khqr/webhook", async (req, res) => {
  const expected = Buffer.from(config.KHQR_WEBHOOK_SECRET)
  const given = Buffer.from(String(req.header("x-khqr-signature") ?? ""))
  if (!expected.length || expected.length !== given.length || !timingSafeEqual(expected, given)) {
    throw new HttpError(401, "Invalid signature.")
  }
  const { reference } = parse(z.object({ reference: z.string().min(1).max(64) }), req.body)
  await settlePayment(reference)
  res.json({ ok: true })
})

// Development only: pretend the customer scanned the QR and paid.
publicRouter.post("/payments/:reference/simulate", async (req, res) => {
  if (config.KHQR_MODE !== "mock" || isProd) throw new HttpError(404, "Not found.")
  const settled = await settlePayment(String(req.params.reference))
  if (!settled) throw new HttpError(409, "This payment is not pending (already paid or expired).")
  res.json({ ok: true })
})
