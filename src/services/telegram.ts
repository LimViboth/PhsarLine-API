import { config } from "../config.ts"
import { query, queryOne } from "../db.ts"
import { decrypt, encrypt } from "./crypto.ts"
import { HttpError } from "./orders.ts"
import { getSettings } from "./settings.ts"

/**
 * One Telegram bot per store. Each seller connects their own bot (made with @BotFather); that bot
 * greets the store's customers with the store's link and delivers the store's order alerts.
 * Every bot is long-polled by this process.
 */

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
const money = (n: number) => `$${n.toFixed(2)}`
// Telegram refuses inline-button URLs that aren't public https links (e.g. localhost).
const canButton = (url: string) => url.startsWith("https://")
const TOKEN_RE = /^\d{5,}:[A-Za-z0-9_-]{30,}$/

async function call<T>(token: string, method: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal,
  })
  const data = (await res.json()) as { ok: boolean; result: T; description?: string }
  // Never include the URL (it contains the token) in errors.
  if (!data.ok) throw new Error(`Telegram ${method} failed: ${data.description}`)
  return data.result
}

async function sendMessage(token: string, chatId: number, html: string, button?: { text: string; url: string }) {
  await call(token, "sendMessage", {
    chat_id: chatId,
    text: html,
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
    ...(button && canButton(button.url)
      ? { reply_markup: { inline_keyboard: [[{ text: button.text, url: button.url }]] } }
      : {}),
  })
}

const shopUrl = (slug: string) => `${config.FRONTEND_URL}/shop/${slug}`

/* ----------------------------- Seller alerts ----------------------------- */

type OrderAlert = {
  code: string
  customer_name: string
  customer_telegram: string | null
  address: string
  payment_method: string
  payment_status: string
  total: number
  telegram_chat_id: number | null
  bot_token_enc: string | null
  items: { name: string; size: string; color: string; quantity: number }[]
}

async function loadAlert(orderId: number) {
  const order = await queryOne<Omit<OrderAlert, "items">>(
    `SELECT o.code, o.customer_name, o.customer_telegram, o.address, o.payment_method,
            o.payment_status, o.total, s.telegram_chat_id, s.bot_token_enc
       FROM orders o JOIN sellers s ON s.id = o.seller_id WHERE o.id = $1`,
    [orderId]
  )
  if (!order) return null
  const items = await query<OrderAlert["items"][number]>(
    "SELECT name, size, color, quantity FROM order_items WHERE order_id = $1",
    [orderId]
  )
  return { ...order, items }
}

const portalButton = { text: "Open seller portal", url: `${config.FRONTEND_URL}/seller/orders` }

async function alertSeller(orderId: number, build: (o: OrderAlert) => string) {
  try {
    if (!(await getSettings()).telegram_alerts) return
    const o = await loadAlert(orderId)
    // No bot connected, or the owner hasn't linked their chat yet: nothing to send.
    if (!o?.bot_token_enc || !o.telegram_chat_id) return
    await sendMessage(decrypt(o.bot_token_enc), o.telegram_chat_id, build(o), portalButton)
  } catch (err) {
    // A Telegram outage must never fail checkout or payment.
    console.error("Telegram alert failed:", (err as Error).message)
  }
}

/** Step 8: alert the seller (through the store's own bot) about a new order. */
export const notifyNewOrder = (orderId: number) =>
  alertSeller(orderId, (o) =>
    [
      `🛒 <b>New order ${o.code}</b>`,
      `${escapeHtml(o.customer_name)}${o.customer_telegram ? ` · ${escapeHtml(o.customer_telegram)}` : ""}`,
      ...o.items.map((i) => `${escapeHtml(i.name)} × ${i.quantity} (${escapeHtml(i.size)}, ${escapeHtml(i.color)})`),
      `Total ${money(o.total)} · ${o.payment_method.toUpperCase()}${o.payment_status === "paid" ? " · Paid ✅" : ""}`,
      `📍 ${escapeHtml(o.address)}`,
    ].join("\n")
  )

export const notifyOrderPaid = (orderId: number) =>
  alertSeller(orderId, (o) => `✅ Order <b>${o.code}</b> was paid by KHQR (${money(o.total)}).`)

/* --------------------------- Bot message handling --------------------------- */

type Update = { update_id: number; message?: { chat: { id: number; type: string }; text?: string } }

async function handleMessage(sellerId: number, token: string, chatId: number, text: string) {
  const seller = await queryOne<{ shop_name: string; slug: string; status: string }>(
    "SELECT shop_name, slug, status FROM sellers WHERE id = $1",
    [sellerId]
  )
  if (!seller || seller.status !== "active") return

  const [command, arg] = text.trim().split(/\s+/, 2)
  const cmd = command.toLowerCase().replace(/@\w+$/, "")

  // The store owner links their chat to receive alerts: /start link_CODE or /link CODE.
  // The code only matches THIS store, so it can't be used on another store's bot.
  const code = cmd === "/link" ? arg : cmd === "/start" && arg?.startsWith("link_") ? arg.slice(5) : null
  if (code) {
    const linked = await queryOne(
      "UPDATE sellers SET telegram_chat_id = $1 WHERE id = $2 AND telegram_link_code = $3 RETURNING id",
      [chatId, sellerId, code.toUpperCase()]
    )
    return sendMessage(
      token,
      chatId,
      linked
        ? `✅ Linked! You'll get new-order alerts for <b>${escapeHtml(seller.shop_name)}</b> here.`
        : "That link code isn't valid. Copy it again from the seller portal."
    )
  }

  // Step 2: every other message gets this store's greeting + storefront link.
  const url = shopUrl(seller.slug)
  return sendMessage(
    token,
    chatId,
    `Hello 👋 Welcome to <b>${escapeHtml(seller.shop_name)}</b>!\nBrowse the catalogue, pick your size and colour, and order in seconds.\nPay by KHQR or cash on delivery.\n\n${url}`,
    { text: "Open shop", url }
  )
}

/* ------------------------------ Bot lifecycle ------------------------------ */

const running = new Map<number, { abort: AbortController }>()

function startPolling(sellerId: number, token: string) {
  stopPolling(sellerId)
  const abort = new AbortController()
  running.set(sellerId, { abort })
  void (async () => {
    let offset = 0
    while (!abort.signal.aborted) {
      try {
        const updates = await call<Update[]>(
          token,
          "getUpdates",
          { offset, timeout: 25, allowed_updates: ["message"] },
          abort.signal
        )
        for (const u of updates) {
          offset = u.update_id + 1
          const m = u.message
          if (m?.text && m.chat.type === "private") {
            await handleMessage(sellerId, token, m.chat.id, m.text).catch((e) =>
              console.error(`bot[${sellerId}] handler error:`, (e as Error).message)
            )
          }
        }
      } catch (err) {
        if (abort.signal.aborted) return
        console.error(`bot[${sellerId}] polling error:`, (err as Error).message)
        await new Promise((r) => setTimeout(r, 5000))
      }
    }
  })()
}

function stopPolling(sellerId: number) {
  running.get(sellerId)?.abort.abort()
  running.delete(sellerId)
}

/** Multipart call (needed to upload files). Like `call`, errors never include the token-bearing URL. */
async function callForm<T>(token: string, method: string, fields: Record<string, string>, file: { field: string; data: Buffer }) {
  const form = new FormData()
  for (const [k, v] of Object.entries(fields)) form.append(k, v)
  form.append(file.field, new Blob([new Uint8Array(file.data)], { type: "image/jpeg" }), `${file.field}.jpg`)
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, { method: "POST", body: form })
  const data = (await res.json()) as { ok: boolean; result: T; description?: string }
  if (!data.ok) throw new Error(`Telegram ${method} failed: ${data.description}`)
  return data.result
}

export type BotPhotoResult = { state: "none" | "updated" | "removed" | "failed"; error?: string }

/**
 * Makes the store's bot profile picture match the store's logo (set it, or remove it if there is no logo).
 * Never throws: a Telegram problem must not break saving the logo; the caller reports the result instead.
 */
export async function syncBotPhoto(sellerId: number): Promise<BotPhotoResult> {
  try {
    const s = await queryOne<{ bot_token_enc: string | null; logo_data: Buffer | null }>(
      "SELECT bot_token_enc, logo_data FROM sellers WHERE id = $1",
      [sellerId]
    )
    if (!s?.bot_token_enc) return { state: "none" }
    const token = decrypt(s.bot_token_enc)
    if (!s.logo_data) {
      await call(token, "removeMyProfilePhoto", {})
      return { state: "removed" }
    }
    // Telegram profile photos must be JPG and are uploaded as a new file (attach://).
    await callForm(token, "setMyProfilePhoto", { photo: JSON.stringify({ type: "static", photo: "attach://logo" }) }, { field: "logo", data: s.logo_data })
    return { state: "updated" }
  } catch (err) {
    return { state: "failed", error: (err as Error).message }
  }
}

/** Validates the token with Telegram, stores it encrypted, and starts the store's bot. */
export async function connectBot(sellerId: number, rawToken: string) {
  const token = rawToken.trim()
  if (!TOKEN_RE.test(token)) throw new HttpError(400, "That doesn't look like a bot token. Copy it from @BotFather.")

  let username: string
  try {
    username = (await call<{ username: string }>(token, "getMe", {})).username
  } catch {
    throw new HttpError(400, "Telegram rejected this token. Check it and try again.")
  }
  // Long polling and webhooks are mutually exclusive.
  await call(token, "deleteWebhook", {}).catch(() => {})

  try {
    await query(
      `UPDATE sellers SET bot_token_enc = $1, bot_username = $2, telegram_chat_id = NULL WHERE id = $3`,
      [encrypt(token), username, sellerId]
    )
  } catch (err) {
    if ((err as { code?: string }).code === "23505") throw new HttpError(409, "This bot is already connected to another store.")
    throw err
  }
  await syncBot(sellerId)
  // A new bot gets the store's logo as its picture right away (if the store has one).
  if (await queryOne("SELECT 1 FROM sellers WHERE id = $1 AND logo_data IS NOT NULL", [sellerId])) await syncBotPhoto(sellerId)
  return username
}

export async function disconnectBot(sellerId: number) {
  stopPolling(sellerId)
  await query("UPDATE sellers SET bot_token_enc = NULL, bot_username = NULL, telegram_chat_id = NULL WHERE id = $1", [sellerId])
}

/** Makes the running bot match the database: running only for active stores that have a token. */
export async function syncBot(sellerId: number) {
  const s = await queryOne<{ status: string; bot_token_enc: string | null }>(
    "SELECT status, bot_token_enc FROM sellers WHERE id = $1",
    [sellerId]
  )
  if (s?.status === "active" && s.bot_token_enc) startPolling(sellerId, decrypt(s.bot_token_enc))
  else stopPolling(sellerId)
}

export async function startAllBots() {
  const rows = await query<{ id: number }>("SELECT id FROM sellers WHERE status = 'active' AND bot_token_enc IS NOT NULL")
  for (const r of rows) {
    await syncBot(r.id).catch((e) => console.error(`bot[${r.id}] failed to start:`, (e as Error).message))
  }
  console.log(`Telegram: ${rows.length} store bot${rows.length === 1 ? "" : "s"} running.`)
}

export function stopAllBots() {
  for (const id of [...running.keys()]) stopPolling(id)
}
