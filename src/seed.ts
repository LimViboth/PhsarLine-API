import { randomBytes } from "node:crypto"
import bcrypt from "bcryptjs"

import { config } from "./config.ts"
import { pool, tx } from "./db.ts"

// Same demo catalogue the UI preview used, so the screens look familiar.
const catalogue = [
  { name: "Khmer Cotton Krama Shirt", category: "Clothing", price: 18.5, stock: 42, tone: "from-rose-200 to-orange-100",
    description: "Breathable checked cotton shirt woven from traditional krama fabric. Relaxed fit, ideal for the hot season.",
    sizes: ["S", "M", "L", "XL"], colors: [{ name: "Red", hex: "#dc2626" }, { name: "Navy", hex: "#1e3a8a" }, { name: "Forest", hex: "#166534" }] },
  { name: "Phnom Penh Canvas Sneakers", category: "Shoes", price: 32, stock: 7, tone: "from-sky-200 to-indigo-100",
    description: "Lightweight canvas sneakers with a cushioned insole. Built for city walking and weekend markets.",
    sizes: ["38", "39", "40", "41", "42", "43"], colors: [{ name: "White", hex: "#f4f4f5" }, { name: "Black", hex: "#18181b" }] },
  { name: "Silk Scarf — Angkor Pattern", category: "Accessories", price: 24, stock: 15, tone: "from-amber-200 to-yellow-100",
    description: "Hand-finished silk scarf printed with an Angkor-inspired motif. Soft, light and gift-ready.",
    sizes: ["One size"], colors: [{ name: "Gold", hex: "#ca8a04" }, { name: "Teal", hex: "#0f766e" }, { name: "Plum", hex: "#86198f" }] },
  { name: "Leather Crossbody Bag", category: "Bags", price: 45, stock: 0, tone: "from-stone-300 to-amber-100",
    description: "Full-grain leather crossbody with an adjustable strap and two inner pockets.",
    sizes: ["One size"], colors: [{ name: "Tan", hex: "#a16207" }, { name: "Black", hex: "#18181b" }] },
  { name: "Linen Wide-Leg Pants", category: "Clothing", price: 27, stock: 31, tone: "from-lime-200 to-emerald-100",
    description: "Soft washed linen with an elastic waist and deep pockets. Cool, comfortable, and easy to style.",
    sizes: ["S", "M", "L"], colors: [{ name: "Sand", hex: "#d6c7a1" }, { name: "Olive", hex: "#4d5b2a" }] },
  { name: "Rattan Woven Sandals", category: "Shoes", price: 21, stock: 4, tone: "from-orange-200 to-stone-100",
    description: "Handwoven rattan upper with a flexible rubber sole. Lightweight and durable.",
    sizes: ["37", "38", "39", "40", "41"], colors: [{ name: "Natural", hex: "#b08968" }] },
]

const sellers = [
  { shop: "Krama House", owner: "Sokha Pich", email: "sokha@kramahouse.test", slug: "krama-house", status: "active", withCatalogue: true },
  { shop: "Urban Step PP", owner: "Chenda Mao", email: "chenda@urbanstep.test", slug: "urban-step-pp", status: "active", withCatalogue: false },
  { shop: "Mekong Leather", owner: "Rotha Dy", email: "rotha@mekongleather.test", slug: "mekong-leather", status: "pending", withCatalogue: false },
]

async function main() {
  const password = config.SEED_PASSWORD
  if (password.length < 8) {
    console.error("Set SEED_PASSWORD (min 8 characters) in .env before seeding.")
    process.exit(1)
  }
  const hash = await bcrypt.hash(password, 10)

  await tx(async (db) => {
    await db.query(
      `INSERT INTO users (email, password_hash, name, role) VALUES ('admin@phsaline.test', $1, 'Phsaline Admin', 'admin')
       ON CONFLICT (email) DO NOTHING`,
      [hash]
    )
    for (const s of sellers) {
      const { rows: u } = await db.query<{ id: number }>(
        `INSERT INTO users (email, password_hash, name, role) VALUES ($1, $2, $3, 'seller')
         ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
        [s.email, hash, s.owner]
      )
      const { rows: sel } = await db.query<{ id: number }>(
        `INSERT INTO sellers (user_id, shop_name, slug, status, telegram_link_code)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (slug) DO UPDATE SET shop_name = EXCLUDED.shop_name RETURNING id`,
        [u[0].id, s.shop, s.slug, s.status, randomBytes(4).toString("hex").toUpperCase()]
      )
      if (!s.withCatalogue) continue
      const existing = await db.query("SELECT 1 FROM products WHERE seller_id = $1 LIMIT 1", [sel[0].id])
      if (existing.rowCount) continue
      for (const p of catalogue) {
        const { rows } = await db.query<{ id: number }>(
          `INSERT INTO products (seller_id, name, category, description, price, sizes, colors, tone)
           VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8) RETURNING id`,
          [sel[0].id, p.name, p.category, p.description, p.price, JSON.stringify(p.sizes), JSON.stringify(p.colors), p.tone]
        )
        await db.query("INSERT INTO inventory (product_id, quantity) VALUES ($1,$2)", [rows[0].id, p.stock])
      }
    }
  })

  console.log("Seeded. Sign in with SEED_PASSWORD as the password for:")
  console.log("  admin   admin@phsaline.test")
  for (const s of sellers) console.log(`  seller  ${s.email}  (${s.shop}, ${s.status})`)
  await pool.end()
}

main().catch((err) => {
  console.error("Seed failed:", err.message)
  process.exit(1)
})
