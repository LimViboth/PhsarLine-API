import { randomBytes } from "node:crypto"

import { config } from "../config.ts"

export type KhqrCharge = { qrPayload: string; expiresAt: Date }

const TTL_MS = 10 * 60 * 1000

export const newPaymentReference = () => `PAY-${randomBytes(5).toString("hex").toUpperCase()}`

/**
 * Creates a KHQR charge. In `mock` mode this returns a fake payload and the payment is
 * settled through POST /api/payments/:reference/simulate. For `live`, call the Bakong /
 * bank KHQR provider here and return the EMV QR string it generates.
 */
export async function createKhqrCharge(input: {
  reference: string
  amount: number
  currency?: "USD" | "KHR"
}): Promise<KhqrCharge> {
  const expiresAt = new Date(Date.now() + TTL_MS)
  if (config.KHQR_MODE === "mock") {
    const qrPayload = `KHQR-MOCK|${input.reference}|${input.amount.toFixed(2)}|${input.currency ?? "USD"}`
    return { qrPayload, expiresAt }
  }
  throw new Error("KHQR live mode is not implemented: plug your payment provider into services/khqr.ts")
}
