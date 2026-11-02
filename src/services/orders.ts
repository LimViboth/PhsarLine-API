import { randomInt } from "node:crypto"
import type { PoolClient } from "pg"

import { query, queryOne, tx } from "../db.ts"
import { createKhqrCharge, newPaymentReference } from "./khqr.ts"
import { getSettings } from "./settings.ts"
import { notifyNewOrder } from "./telegram.ts"

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message)
  }
}

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789" // no 0/O/1/I
// Random (not sequential) so an order code can't be enumerated by guessing neighbours.
const newOrderCode = () =>
  "PL-" + Array.from({ length: 6 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join("")

export type NewOrder = {
  shopSlug: string
  customer: { name: string; phone: string; telegram?: string }
  address: string
  latitude?: number
  longitude?: number
  paymentMethod: "cod" | "khqr"
  items: { productId: number; size: string; color: string; quantity: number }[]
}

export async function createOrder(input: NewOrder) {
  const settings = await getSettings()
  if (input.paymentMethod === "khqr" && !settings.khqr_enabled) throw new HttpError(400, "KHQR is currently unavailable.")
  if (input.paymentMethod === "cod" && !settings.cod_enabled) throw new HttpError(400, "Cash on delivery is currently unavailable.")

  const seller = await queryOne<{ id: number }>("SELECT id FROM sellers WHERE slug = $1 AND status = 'active'", [
    input.shopSlug,
  ])
  if (!seller) throw new HttpError(404, "This shop is not available.")

  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const result = await tx(async (db) => {
        let subtotal = 0
        const lines: { productId: number; name: string; size: string; color: string; quantity: number; unitPrice: number }[] = []

        // Lock rows in a stable order so concurrent checkouts can't deadlock.
        const sorted = [...input.items].sort((a, b) => a.productId - b.productId)
        for (const item of sorted) {
          const { rows } = await db.query<{
            name: string
            price: number
            sizes: string[]
            colors: { name: string }[]
            quantity: number
          }>(
            `SELECT p.name, p.price, p.sizes, p.colors, i.quantity
               FROM products p JOIN inventory i ON i.product_id = p.id
              WHERE p.id = $1 AND p.seller_id = $2 AND p.active
              FOR UPDATE OF i`,
            [item.productId, seller.id]
          )
          const p = rows[0]
          if (!p) throw new HttpError(400, "A product in your order is no longer available.")
          if (!p.sizes.includes(item.size)) throw new HttpError(400, `Invalid size for ${p.name}.`)
          if (!p.colors.some((c) => c.name === item.color)) throw new HttpError(400, `Invalid colour for ${p.name}.`)
          if (p.quantity < item.quantity) throw new HttpError(409, `Only ${p.quantity} left of ${p.name}.`)

          await db.query("UPDATE inventory SET quantity = quantity - $1 WHERE product_id = $2", [
            item.quantity,
            item.productId,
          ])
          subtotal += p.price * item.quantity
          lines.push({ productId: item.productId, name: p.name, size: item.size, color: item.color, quantity: item.quantity, unitPrice: p.price })
        }

        subtotal = Math.round(subtotal * 100) / 100
        const total = Math.round((subtotal + settings.delivery_fee) * 100) / 100
        const code = newOrderCode()

        const { rows: orderRows } = await db.query<{ id: number }>(
          `INSERT INTO orders (code, seller_id, customer_name, customer_phone, customer_telegram, address,
                               latitude, longitude, payment_method, subtotal, delivery_fee, total)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
          [
            code, seller.id, input.customer.name, input.customer.phone, input.customer.telegram || null,
            input.address, input.latitude ?? null, input.longitude ?? null, input.paymentMethod,
            subtotal, settings.delivery_fee, total,
          ]
        )
        const orderId = orderRows[0].id
        for (const l of lines) {
          await db.query(
            `INSERT INTO order_items (order_id, product_id, name, size, color, quantity, unit_price)
             VALUES ($1,$2,$3,$4,$5,$6,$7)`,
            [orderId, l.productId, l.name, l.size, l.color, l.quantity, l.unitPrice]
          )
          await db.query(
            `INSERT INTO stock_movements (product_id, seller_id, delta, reason, ref) VALUES ($1,$2,$3,'sale',$4)`,
            [l.productId, seller.id, -l.quantity, code]
          )
        }

        const reference = newPaymentReference()
        let payment: { reference: string; qrPayload: string | null; expiresAt: Date | null } = {
          reference,
          qrPayload: null,
          expiresAt: null,
        }
        if (input.paymentMethod === "khqr") {
          const charge = await createKhqrCharge({ reference, amount: total })
          payment = { reference, qrPayload: charge.qrPayload, expiresAt: charge.expiresAt }
        }
        await db.query(
          `INSERT INTO payments (reference, order_id, method, amount, qr_payload, expires_at)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [reference, orderId, input.paymentMethod, total, payment.qrPayload, payment.expiresAt]
        )
        return { orderId, code, total, payment }
      })

      void notifyNewOrder(result.orderId)
      return { code: result.code, total: result.total, payment: result.payment }
    } catch (err) {
      // 23505 = unique_violation: the (rare) random order code collided, so retry with a new one.
      if ((err as { code?: string }).code === "23505" && attempt < 4) continue
      throw err
    }
  }
  throw new HttpError(500, "Could not create the order. Please try again.")
}

const NEXT: Record<string, string[]> = {
  pending: ["confirmed", "cancelled"],
  confirmed: ["shipping", "cancelled"],
  shipping: ["delivered", "cancelled"],
  delivered: [],
  cancelled: [],
}

/**
 * Moves an order to its next status inside an existing transaction. Used by the seller's
 * confirm/cancel actions and by logistics (shipping on dispatch, delivered on drop-off).
 */
export async function applyOrderStatus(db: PoolClient, sellerId: number, orderId: number, next: string) {
  const { rows } = await db.query<{
    id: number
    code: string
    status: string
    payment_method: string
    payment_status: string
  }>(
    "SELECT id, code, status, payment_method, payment_status FROM orders WHERE id = $1 AND seller_id = $2 FOR UPDATE",
    [orderId, sellerId]
  )
  const order = rows[0]
  if (!order) throw new HttpError(404, "Order not found.")
  if (!NEXT[order.status]?.includes(next)) throw new HttpError(409, `Can't move an order from ${order.status} to ${next}.`)
  if (next === "cancelled" && order.payment_status === "paid") {
    throw new HttpError(409, "This order is already paid. Contact support to refund it.")
  }

  if (next === "cancelled") {
    // Put the stock back (and record it), void any open payment, and stop any delivery in progress.
    await db.query(
      `INSERT INTO stock_movements (product_id, seller_id, delta, reason, ref)
       SELECT oi.product_id, $2, oi.quantity, 'cancel', $3 FROM order_items oi
        WHERE oi.order_id = $1 AND oi.product_id IS NOT NULL`,
      [orderId, sellerId, order.code]
    )
    await db.query(
      `UPDATE inventory i SET quantity = i.quantity + oi.quantity
         FROM order_items oi WHERE oi.order_id = $1 AND oi.product_id = i.product_id`,
      [orderId]
    )
    await db.query("UPDATE payments SET state = 'failed' WHERE order_id = $1 AND state = 'pending'", [orderId])
    const { rows: ship } = await db.query<{ id: number }>(
      `UPDATE shipments SET status = 'cancelled', updated_at = now()
        WHERE order_id = $1 AND status NOT IN ('delivered', 'cancelled') RETURNING id`,
      [orderId]
    )
    if (ship[0]) {
      await db.query("INSERT INTO shipment_events (shipment_id, status, note) VALUES ($1, 'cancelled', 'Order cancelled')", [ship[0].id])
    }
  }
  if (next === "delivered" && order.payment_method === "cod") {
    // Courier collected the cash.
    await db.query("UPDATE payments SET state = 'settled', settled_at = now() WHERE order_id = $1 AND state = 'pending'", [orderId])
    await db.query("UPDATE orders SET payment_status = 'paid' WHERE id = $1", [orderId])
  }
  await db.query("UPDATE orders SET status = $1 WHERE id = $2", [next, orderId])
  return { id: orderId, status: next }
}

export const updateOrderStatus = (sellerId: number, orderId: number, next: string) =>
  tx((db) => applyOrderStatus(db, sellerId, orderId, next))

/** Orders for a seller, newest first, each with its line items. */
export async function listOrders(sellerId: number, status?: string, limit = 200) {
  return query(
    `SELECT o.id, o.code, o.customer_name AS customer, o.customer_telegram AS telegram, o.customer_phone AS phone,
            o.address, o.payment_method AS payment, o.payment_status AS "paymentStatus", o.status, o.total,
            o.created_at AS "createdAt",
            (SELECT json_build_object('id', sh.id, 'status', sh.status, 'trackingCode', sh.tracking_code)
               FROM shipments sh WHERE sh.order_id = o.id) AS shipment,
            COALESCE((SELECT json_agg(json_build_object('name', oi.name, 'size', oi.size, 'color', oi.color,
                                                         'quantity', oi.quantity, 'unitPrice', oi.unit_price) ORDER BY oi.id)
                        FROM order_items oi WHERE oi.order_id = o.id), '[]') AS items
       FROM orders o
      WHERE o.seller_id = $1 AND ($2::text IS NULL OR o.status = $2)
      ORDER BY o.created_at DESC
      LIMIT $3`,
    [sellerId, status ?? null, limit]
  )
}
