import { query, queryOne } from "../db.ts"
import { HttpError } from "./orders.ts"
import { sniffImageType } from "./product-images.ts"
import { type BotPhotoResult, syncBotPhoto } from "./telegram.ts"

export type LogoResult = { logoUrl: string | null; bot: BotPhotoResult }

/** Saves (or, with `null`, removes) a store's logo and pushes it to the store's Telegram bot. */
export async function saveLogo(sellerId: number, body: unknown | null): Promise<LogoResult> {
  if (body !== null) {
    const buf = body as Buffer
    // Telegram only accepts JPG profile photos; the browser always sends a JPEG.
    if (!Buffer.isBuffer(buf) || buf.length === 0 || sniffImageType(buf) !== "image/jpeg") {
      throw new HttpError(400, "Upload the logo as a JPEG image.")
    }
    const row = await queryOne(
      "UPDATE sellers SET logo_data = $2, logo_type = 'image/jpeg', logo_updated_at = now() WHERE id = $1 RETURNING id",
      [sellerId, buf]
    )
    if (!row) throw new HttpError(404, "Shop not found.")
  } else {
    await query("UPDATE sellers SET logo_data = NULL, logo_type = NULL, logo_updated_at = NULL WHERE id = $1", [sellerId])
  }
  const url = await queryOne<{ logoUrl: string | null }>(
    `SELECT CASE WHEN logo_type IS NOT NULL
              THEN '/api/shops/' || slug || '/logo?v=' || EXTRACT(EPOCH FROM logo_updated_at)::bigint END AS "logoUrl"
       FROM sellers WHERE id = $1`,
    [sellerId]
  )
  return { logoUrl: url?.logoUrl ?? null, bot: await syncBotPhoto(sellerId) }
}
