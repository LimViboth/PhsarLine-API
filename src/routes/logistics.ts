import { randomBytes } from "node:crypto"
import { Router } from "express"
import type { PoolClient } from "pg"
import { z } from "zod"

import { idParam, parse, sellerIdOf } from "../http.ts"
import { query, queryOne, tx } from "../db.ts"
import { applyOrderStatus, HttpError } from "../services/orders.ts"

/** Logistics: couriers and shipments. Mounted at /api/seller/logistics (seller-only). */
export const logisticsRouter = Router()

const optText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((v) => v || null)

/* -------------------------------- Couriers -------------------------------- */

const COURIER_COLUMNS = `id, name, phone, kind, active,
  (SELECT COUNT(*) FROM shipments s WHERE s.courier_id = couriers.id AND s.status IN ('assigned', 'picked_up', 'in_transit'))::int AS "openShipments"`

const courierSchema = z.object({
  name: z.string().trim().min(1).max(100),
  phone: optText(40),
  kind: z.enum(["own", "partner"]).default("own"),
})

logisticsRouter.get("/couriers", async (req, res) => {
  res.json(await query(`SELECT ${COURIER_COLUMNS} FROM couriers WHERE seller_id = $1 ORDER BY active DESC, name`, [sellerIdOf(req)]))
})

logisticsRouter.post("/couriers", async (req, res) => {
  const b = parse(courierSchema, req.body)
  res.status(201).json(
    await queryOne(
      `INSERT INTO couriers (seller_id, name, phone, kind) VALUES ($1,$2,$3,$4) RETURNING ${COURIER_COLUMNS}`,
      [sellerIdOf(req), b.name, b.phone, b.kind]
    )
  )
})

logisticsRouter.patch("/couriers/:id", async (req, res) => {
  const b = parse(courierSchema.partial().extend({ active: z.boolean().optional() }), req.body)
  const cols: [string, unknown][] = [["name", b.name], ["phone", b.phone], ["kind", b.kind], ["active", b.active]]
  const set = cols.filter(([, v]) => v !== undefined)
  if (set.length === 0) throw new HttpError(400, "Nothing to update.")
  const row = await queryOne(
    `UPDATE couriers SET ${set.map(([c], i) => `${c} = $${i + 3}`).join(", ")}
      WHERE id = $1 AND seller_id = $2 RETURNING ${COURIER_COLUMNS}`,
    [idParam(req.params.id), sellerIdOf(req), ...set.map(([, v]) => v)]
  )
  if (!row) throw new HttpError(404, "Courier not found.")
  res.json(row)
})

/* -------------------------------- Shipments -------------------------------- */

const SHIPMENT_SELECT = `
  SELECT sh.id, sh.status, sh.tracking_code AS "trackingCode", sh.cod_amount AS "codAmount", sh.note,
         sh.created_at AS "createdAt", sh.updated_at AS "updatedAt",
         sh.courier_id AS "courierId", c.name AS courier, c.phone AS "courierPhone",
         o.id AS "orderId", o.code AS "orderCode", o.customer_name AS customer, o.customer_phone AS phone,
         o.address, o.latitude, o.longitude, o.total, o.payment_method AS payment,
         COALESCE((SELECT json_agg(json_build_object('status', e.status, 'note', e.note, 'at', e.created_at)
                                   ORDER BY e.created_at, e.id)
                     FROM shipment_events e WHERE e.shipment_id = sh.id), '[]') AS events
    FROM shipments sh
    JOIN orders o ON o.id = sh.order_id
    LEFT JOIN couriers c ON c.id = sh.courier_id`

logisticsRouter.get("/shipments", async (req, res) => {
  res.json(await query(`${SHIPMENT_SELECT} WHERE sh.seller_id = $1 ORDER BY sh.updated_at DESC LIMIT 200`, [sellerIdOf(req)]))
})

// Confirmed orders that still need a delivery arranged.
logisticsRouter.get("/ready", async (req, res) => {
  res.json(
    await query(
      `SELECT o.id, o.code, o.customer_name AS customer, o.customer_phone AS phone, o.address, o.total,
              o.payment_method AS payment, o.payment_status AS "paymentStatus", o.created_at AS "createdAt"
         FROM orders o
        WHERE o.seller_id = $1 AND o.status = 'confirmed'
          AND NOT EXISTS (SELECT 1 FROM shipments s WHERE s.order_id = o.id)
        ORDER BY o.created_at`,
      [sellerIdOf(req)]
    )
  )
})

const trackingCode = () => "TRK-" + randomBytes(4).toString("hex").toUpperCase()

async function assertCourier(db: PoolClient, sellerId: number, courierId: number) {
  const r = await db.query("SELECT 1 FROM couriers WHERE id = $1 AND seller_id = $2 AND active", [courierId, sellerId])
  if (r.rowCount === 0) throw new HttpError(400, "Choose an active courier.")
}

// Arrange delivery: creates the shipment and moves the order to "shipping".
logisticsRouter.post("/shipments", async (req, res) => {
  const sellerId = sellerIdOf(req)
  const b = parse(
    z.object({
      orderId: z.number().int().positive(),
      courierId: z.number().int().positive(),
      trackingCode: optText(60),
      note: optText(500),
    }),
    req.body
  )
  const id = await tx(async (db) => {
    await assertCourier(db, sellerId, b.courierId)
    const { rows } = await db.query<{ status: string; payment_method: string; payment_status: string; total: number }>(
      "SELECT status, payment_method, payment_status, total FROM orders WHERE id = $1 AND seller_id = $2 FOR UPDATE",
      [b.orderId, sellerId]
    )
    const order = rows[0]
    if (!order) throw new HttpError(404, "Order not found.")
    if (order.status !== "confirmed") throw new HttpError(409, "Confirm the order before arranging delivery.")
    const existing = await db.query("SELECT 1 FROM shipments WHERE order_id = $1", [b.orderId])
    if (existing.rowCount) throw new HttpError(409, "This order already has a shipment.")

    // The courier only collects cash for unpaid COD orders.
    const cod = order.payment_method === "cod" && order.payment_status === "unpaid" ? order.total : 0
    const { rows: s } = await db.query<{ id: number }>(
      `INSERT INTO shipments (order_id, seller_id, courier_id, tracking_code, cod_amount, note)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [b.orderId, sellerId, b.courierId, b.trackingCode ?? trackingCode(), cod, b.note]
    )
    await db.query("INSERT INTO shipment_events (shipment_id, status, note) VALUES ($1, 'assigned', $2)", [s[0].id, b.note])
    await applyOrderStatus(db, sellerId, b.orderId, "shipping")
    return s[0].id
  })
  res.status(201).json(await queryOne(`${SHIPMENT_SELECT} WHERE sh.id = $1`, [id]))
})

const FLOW: Record<string, string[]> = {
  assigned: ["picked_up", "failed"],
  picked_up: ["in_transit", "failed"],
  in_transit: ["delivered", "failed"],
  failed: ["assigned"], // retry, optionally with a different courier
  delivered: [],
  cancelled: [],
}

logisticsRouter.patch("/shipments/:id/status", async (req, res) => {
  const sellerId = sellerIdOf(req)
  const id = idParam(req.params.id)
  const b = parse(
    z.object({
      status: z.enum(["assigned", "picked_up", "in_transit", "delivered", "failed"]),
      note: optText(500),
      courierId: z.number().int().positive().optional(),
    }),
    req.body
  )
  await tx(async (db) => {
    const { rows } = await db.query<{ status: string; order_id: number }>(
      "SELECT status, order_id FROM shipments WHERE id = $1 AND seller_id = $2 FOR UPDATE",
      [id, sellerId]
    )
    const sh = rows[0]
    if (!sh) throw new HttpError(404, "Shipment not found.")
    if (!FLOW[sh.status]?.includes(b.status)) throw new HttpError(409, `Cannot move a shipment from ${sh.status} to ${b.status}.`)

    if (b.courierId !== undefined) {
      if (b.status !== "assigned") throw new HttpError(400, "A courier can only be changed when retrying a failed delivery.")
      await assertCourier(db, sellerId, b.courierId)
      await db.query("UPDATE shipments SET courier_id = $1 WHERE id = $2", [b.courierId, id])
    }
    await db.query("UPDATE shipments SET status = $1, updated_at = now() WHERE id = $2", [b.status, id])
    await db.query("INSERT INTO shipment_events (shipment_id, status, note) VALUES ($1,$2,$3)", [id, b.status, b.note])
    // Drop-off completes the order (and settles COD cash).
    if (b.status === "delivered") await applyOrderStatus(db, sellerId, sh.order_id, "delivered")
  })
  res.json(await queryOne(`${SHIPMENT_SELECT} WHERE sh.id = $1`, [id]))
})
