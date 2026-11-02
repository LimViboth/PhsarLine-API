import type { PoolClient } from "pg"

export type MovementReason = "initial" | "sale" | "cancel" | "purchase" | "adjustment"

/** Appends a stock-ledger entry. Call inside the same transaction that changes `inventory`. */
export function recordMovement(
  db: PoolClient,
  productId: number,
  sellerId: number,
  delta: number,
  reason: MovementReason,
  ref?: string
) {
  return db.query(
    "INSERT INTO stock_movements (product_id, seller_id, delta, reason, ref) VALUES ($1,$2,$3,$4,$5)",
    [productId, sellerId, delta, reason, ref ?? null]
  )
}
