import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto"

import { config } from "../config.ts"

const key = Buffer.from(config.BOT_TOKEN_KEY, "hex")

/** AES-256-GCM. Output format: v1.<iv>.<tag>.<ciphertext> (all base64url). */
export function encrypt(plain: string): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv("aes-256-gcm", key, iv)
  const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()])
  return ["v1", iv, cipher.getAuthTag(), data].map((p) => (typeof p === "string" ? p : p.toString("base64url"))).join(".")
}

export function decrypt(payload: string): string {
  const [version, iv, tag, data] = payload.split(".")
  if (version !== "v1" || !iv || !tag || !data) throw new Error("Unrecognised ciphertext format")
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"))
  decipher.setAuthTag(Buffer.from(tag, "base64url"))
  return Buffer.concat([decipher.update(Buffer.from(data, "base64url")), decipher.final()]).toString("utf8")
}
