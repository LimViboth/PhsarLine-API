import express from "express"

export const MAX_IMAGE_BYTES = 2 * 1024 * 1024

/** Accepts only the raw bytes of a JPEG / PNG / WebP (never SVG, which can carry scripts). */
export const imageBody = express.raw({ type: ["image/jpeg", "image/png", "image/webp"], limit: MAX_IMAGE_BYTES })

/** Decide the type from the file's own signature, not from what the client claims. */
export function sniffImageType(buf: Buffer): "image/jpeg" | "image/png" | "image/webp" | null {
  if (buf.length < 12) return null
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg"
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png"
  if (buf.subarray(0, 4).toString("latin1") === "RIFF" && buf.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp"
  return null
}

/** SQL fragment: the image URL (versioned so browsers refetch after a change) or NULL when there is none. */
export const IMAGE_URL_SQL = `CASE WHEN p.image_type IS NOT NULL
  THEN '/api/products/' || p.id || '/image?v=' || EXTRACT(EPOCH FROM p.image_updated_at)::bigint END AS "imageUrl"`

/** SQL fragment (table alias `s` = sellers): the shop logo URL, versioned, or NULL. */
export const LOGO_URL_SQL = `CASE WHEN s.logo_type IS NOT NULL
  THEN '/api/shops/' || s.slug || '/logo?v=' || EXTRACT(EPOCH FROM s.logo_updated_at)::bigint END AS "logoUrl"`
