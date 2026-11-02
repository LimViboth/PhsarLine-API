import { tx } from "../db.ts"
import { notifyOrderPaid } from "./telegram.ts"

/**
 * Marks a pending KHQR payment as settled and updates the order / invoice it belongs to.
 * Idempotent: settling an already-settled (or expired) payment returns null and changes nothing.
 * Called by the gateway webhook and by the mock simulate endpoint.
 */
export async function settlePayment(reference: string) {
  const payment = await tx(async (db) => {
    const { rows } = await db.query<{ id: number; order_id: number | null; invoice_id: number | null }>(
      `UPDATE payments SET state = 'settled', settled_at = now()
        WHERE reference = $1 AND state = 'pending' AND method = 'khqr'
          AND (expires_at IS NULL OR expires_at > now())
        RETURNING id, order_id, invoice_id`,
      [reference]
    )
    const p = rows[0]
    if (!p) return null
    if (p.order_id) await db.query("UPDATE orders SET payment_status = 'paid' WHERE id = $1", [p.order_id])
    if (p.invoice_id) {
      await db.query("UPDATE invoices SET status = 'paid', paid_at = now() WHERE id = $1", [p.invoice_id])
    }
    return p
  })
  if (payment?.order_id) void notifyOrderPaid(payment.order_id)
  return payment
}
