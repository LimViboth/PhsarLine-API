import { query } from "../db.ts"

export type Settings = {
  standard_fee: number
  invoice_due_day: number
  delivery_fee: number
  khqr_enabled: boolean
  cod_enabled: boolean
  signups_open: boolean
  telegram_alerts: boolean
}

export async function getSettings(): Promise<Settings> {
  const rows = await query<{ key: string; value: unknown }>("SELECT key, value FROM admin_config")
  return Object.fromEntries(rows.map((r) => [r.key, r.value])) as Settings
}

export async function saveSettings(patch: Partial<Settings>) {
  for (const [key, value] of Object.entries(patch)) {
    await query(
      `INSERT INTO admin_config (key, value) VALUES ($1, $2::jsonb)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [key, JSON.stringify(value)]
    )
  }
}
