import { Router } from "express"
import { z } from "zod"

import { idParam, parse, sellerIdOf } from "../http.ts"
import { query, queryOne, tx } from "../db.ts"
import { recordMovement } from "../services/inventory.ts"
import { HttpError } from "../services/orders.ts"

/** Procurement: suppliers and purchase orders. Mounted at /api/seller/procurement (seller-only). */
export const procurementRouter = Router()

const optText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((v) => v || null)

const supplierSchema = z.object({
  name: z.string().trim().min(1).max(120),
  contactName: optText(100),
  phone: optText(40),
  email: z.union([z.literal(""), z.string().trim().email().max(200)]).optional().transform((v) => v || null),
  address: optText(300),
  notes: optText(1000),
})

/* -------------------------------- Suppliers -------------------------------- */

const SUPPLIER_COLUMNS = `id, name, contact_name AS "contactName", phone, email, address, notes, active,
  (SELECT COUNT(*) FROM purchase_orders po WHERE po.supplier_id = suppliers.id)::int AS "orderCount"`

procurementRouter.get("/suppliers", async (req, res) => {
  res.json(await query(`SELECT ${SUPPLIER_COLUMNS} FROM suppliers WHERE seller_id = $1 ORDER BY active DESC, name`, [sellerIdOf(req)]))
})

procurementRouter.post("/suppliers", async (req, res) => {
  const b = parse(supplierSchema, req.body)
  const row = await queryOne(
    `INSERT INTO suppliers (seller_id, name, contact_name, phone, email, address, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING ${SUPPLIER_COLUMNS}`,
    [sellerIdOf(req), b.name, b.contactName, b.phone, b.email, b.address, b.notes]
  )
  res.status(201).json(row)
})

procurementRouter.patch("/suppliers/:id", async (req, res) => {
  const b = parse(supplierSchema.partial().extend({ active: z.boolean().optional() }), req.body)
  const cols: [string, unknown][] = [
    ["name", b.name], ["contact_name", b.contactName], ["phone", b.phone], ["email", b.email],
    ["address", b.address], ["notes", b.notes], ["active", b.active],
  ]
  // Optional fields that were not sent are `undefined` (kept); sent-but-empty become null (cleared).
  const set = cols.filter(([, v]) => v !== undefined)
  if (set.length === 0) throw new HttpError(400, "Nothing to update.")
  const row = await queryOne(
    `UPDATE suppliers SET ${set.map(([c], i) => `${c} = $${i + 3}`).join(", ")}
      WHERE id = $1 AND seller_id = $2 RETURNING ${SUPPLIER_COLUMNS}`,
    [idParam(req.params.id), sellerIdOf(req), ...set.map(([, v]) => v)]
  )
  if (!row) throw new HttpError(404, "Supplier not found.")
  res.json(row)
})

/* ----------------------------- Purchase orders ----------------------------- */

const PO_SELECT = `
  SELECT po.id, po.code, po.status, po.supplier_id AS "supplierId", s.name AS supplier,
         po.expected_date AS "expectedDate", po.shipping_cost AS "shippingCost", po.notes,
         po.created_at AS "createdAt", po.ordered_at AS "orderedAt", po.received_at AS "receivedAt",
         COALESCE(items.list, '[]') AS items,
         COALESCE(items.subtotal, 0) + po.shipping_cost AS total
    FROM purchase_orders po
    JOIN suppliers s ON s.id = po.supplier_id
    LEFT JOIN LATERAL (
      SELECT json_agg(json_build_object('productId', i.product_id, 'name', p.name, 'quantity', i.quantity,
                                        'unitCost', i.unit_cost) ORDER BY i.id) AS list,
             SUM(i.quantity * i.unit_cost) AS subtotal
        FROM purchase_order_items i JOIN products p ON p.id = i.product_id WHERE i.po_id = po.id
    ) items ON true`

procurementRouter.get("/orders", async (req, res) => {
  res.json(await query(`${PO_SELECT} WHERE po.seller_id = $1 ORDER BY po.created_at DESC LIMIT 200`, [sellerIdOf(req)]))
})

const poSchema = z.object({
  supplierId: z.number().int().positive(),
  status: z.enum(["draft", "ordered"]).default("draft"),
  expectedDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Use a valid date")
    .optional()
    .transform((v) => v || null),
  shippingCost: z.number().min(0).max(100000).default(0),
  notes: optText(1000),
  items: z
    .array(
      z.object({
        productId: z.number().int().positive(),
        quantity: z.number().int().min(1).max(100000),
        unitCost: z.number().min(0).max(100000),
      })
    )
    .min(1, "Add at least one item")
    .max(50),
})

procurementRouter.post("/orders", async (req, res) => {
  const sellerId = sellerIdOf(req)
  const b = parse(poSchema, req.body)
  if (new Set(b.items.map((i) => i.productId)).size !== b.items.length) {
    throw new HttpError(400, "items: each product can only appear once")
  }

  const id = await tx(async (db) => {
    const supplier = await db.query("SELECT 1 FROM suppliers WHERE id = $1 AND seller_id = $2 AND active", [b.supplierId, sellerId])
    if (supplier.rowCount === 0) throw new HttpError(400, "Choose an active supplier.")
    const owned = await db.query("SELECT COUNT(*)::int AS n FROM products WHERE seller_id = $1 AND id = ANY($2)", [
      sellerId,
      b.items.map((i) => i.productId),
    ])
    if (owned.rows[0].n !== b.items.length) throw new HttpError(400, "One of the products doesn't belong to your store.")

    const { rows } = await db.query<{ id: number }>(
      `INSERT INTO purchase_orders (code, seller_id, supplier_id, status, expected_date, shipping_cost, notes, ordered_at)
       VALUES ('PO-' || nextval('po_code_seq'), $1, $2, $3, $4, $5, $6, CASE WHEN $3 = 'ordered' THEN now() END)
       RETURNING id`,
      [sellerId, b.supplierId, b.status, b.expectedDate, b.shippingCost, b.notes]
    )
    for (const i of b.items) {
      await db.query("INSERT INTO purchase_order_items (po_id, product_id, quantity, unit_cost) VALUES ($1,$2,$3,$4)", [
        rows[0].id, i.productId, i.quantity, i.unitCost,
      ])
    }
    return rows[0].id
  })
  res.status(201).json(await queryOne(`${PO_SELECT} WHERE po.id = $1`, [id]))
})

const PO_NEXT: Record<string, string[]> = {
  draft: ["ordered", "cancelled"],
  ordered: ["received", "cancelled"],
  received: [],
  cancelled: [],
}

procurementRouter.patch("/orders/:id/status", async (req, res) => {
  const sellerId = sellerIdOf(req)
  const poId = idParam(req.params.id)
  const { status } = parse(z.object({ status: z.enum(["ordered", "received", "cancelled"]) }), req.body)

  await tx(async (db) => {
    const { rows } = await db.query<{ code: string; status: string }>(
      "SELECT code, status FROM purchase_orders WHERE id = $1 AND seller_id = $2 FOR UPDATE",
      [poId, sellerId]
    )
    const po = rows[0]
    if (!po) throw new HttpError(404, "Purchase order not found.")
    if (!PO_NEXT[po.status].includes(status)) throw new HttpError(409, `Cannot move a ${po.status} purchase order to ${status}.`)

    if (status === "received") {
      // Stock comes in, the ledger records it, and each product's cost updates to what we just paid.
      const { rows: items } = await db.query<{ product_id: number; quantity: number; unit_cost: number }>(
        "SELECT product_id, quantity, unit_cost FROM purchase_order_items WHERE po_id = $1 ORDER BY product_id",
        [poId]
      )
      for (const i of items) {
        await db.query("UPDATE inventory SET quantity = quantity + $1 WHERE product_id = $2", [i.quantity, i.product_id])
        await db.query("UPDATE products SET cost = $1 WHERE id = $2", [i.unit_cost, i.product_id])
        await recordMovement(db, i.product_id, sellerId, i.quantity, "purchase", po.code)
      }
    }
    await db.query(
      `UPDATE purchase_orders SET status = $1,
              ordered_at  = CASE WHEN $1 = 'ordered'  THEN now() ELSE ordered_at END,
              received_at = CASE WHEN $1 = 'received' THEN now() ELSE received_at END
        WHERE id = $2`,
      [status, poId]
    )
  })
  res.json(await queryOne(`${PO_SELECT} WHERE po.id = $1`, [poId]))
})

// Drafts that were never sent can simply be deleted.
procurementRouter.delete("/orders/:id", async (req, res) => {
  const gone = await queryOne(
    "DELETE FROM purchase_orders WHERE id = $1 AND seller_id = $2 AND status = 'draft' RETURNING id",
    [idParam(req.params.id), sellerIdOf(req)]
  )
  if (!gone) throw new HttpError(409, "Only draft purchase orders can be deleted.")
  res.json({ ok: true })
})
