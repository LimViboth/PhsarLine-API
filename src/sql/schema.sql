-- Phsaline schema (idempotent: safe to run repeatedly)

CREATE TABLE IF NOT EXISTS users (
  id            BIGSERIAL PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  name          TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('seller', 'admin')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sellers (
  id                 BIGSERIAL PRIMARY KEY,
  user_id            BIGINT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  shop_name          TEXT NOT NULL,
  slug               TEXT NOT NULL UNIQUE,
  plan               TEXT NOT NULL DEFAULT 'standard',
  status             TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'suspended')),
  telegram_chat_id   BIGINT,
  telegram_link_code TEXT UNIQUE,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS products (
  id          BIGSERIAL PRIMARY KEY,
  seller_id   BIGINT NOT NULL REFERENCES sellers(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  category    TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  price       NUMERIC(10, 2) NOT NULL CHECK (price >= 0),
  sizes       JSONB NOT NULL DEFAULT '["One size"]',
  colors      JSONB NOT NULL DEFAULT '[{"name":"Default","hex":"#a1a1aa"}]',
  tone        TEXT NOT NULL DEFAULT 'from-zinc-200 to-zinc-100',
  active      BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS products_seller_idx ON products(seller_id);

CREATE TABLE IF NOT EXISTS inventory (
  product_id BIGINT PRIMARY KEY REFERENCES products(id) ON DELETE CASCADE,
  quantity   INTEGER NOT NULL DEFAULT 0 CHECK (quantity >= 0)
);

CREATE TABLE IF NOT EXISTS orders (
  id               BIGSERIAL PRIMARY KEY,
  code             TEXT NOT NULL UNIQUE,
  seller_id        BIGINT NOT NULL REFERENCES sellers(id),
  customer_name    TEXT NOT NULL,
  customer_phone   TEXT NOT NULL,
  customer_telegram TEXT,
  address          TEXT NOT NULL,
  latitude         DOUBLE PRECISION,
  longitude        DOUBLE PRECISION,
  payment_method   TEXT NOT NULL CHECK (payment_method IN ('cod', 'khqr')),
  payment_status   TEXT NOT NULL DEFAULT 'unpaid' CHECK (payment_status IN ('unpaid', 'paid')),
  status           TEXT NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending', 'confirmed', 'shipping', 'delivered', 'cancelled')),
  subtotal         NUMERIC(10, 2) NOT NULL,
  delivery_fee     NUMERIC(10, 2) NOT NULL DEFAULT 0,
  total            NUMERIC(10, 2) NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS orders_seller_idx ON orders(seller_id, created_at DESC);

CREATE TABLE IF NOT EXISTS order_items (
  id         BIGSERIAL PRIMARY KEY,
  order_id   BIGINT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id BIGINT REFERENCES products(id) ON DELETE SET NULL,
  name       TEXT NOT NULL,
  size       TEXT NOT NULL,
  color      TEXT NOT NULL,
  quantity   INTEGER NOT NULL CHECK (quantity > 0),
  unit_price NUMERIC(10, 2) NOT NULL
);
CREATE INDEX IF NOT EXISTS order_items_order_idx ON order_items(order_id);

CREATE TABLE IF NOT EXISTS invoices (
  id         BIGSERIAL PRIMARY KEY,
  code       TEXT NOT NULL UNIQUE,
  seller_id  BIGINT NOT NULL REFERENCES sellers(id) ON DELETE CASCADE,
  period     TEXT NOT NULL,                 -- e.g. 2026-11
  amount     NUMERIC(10, 2) NOT NULL,
  status     TEXT NOT NULL DEFAULT 'due' CHECK (status IN ('due', 'paid')),
  due_date   DATE NOT NULL,
  paid_at    TIMESTAMPTZ,
  UNIQUE (seller_id, period)
);

CREATE TABLE IF NOT EXISTS payments (
  id         BIGSERIAL PRIMARY KEY,
  reference  TEXT NOT NULL UNIQUE,
  order_id   BIGINT REFERENCES orders(id) ON DELETE CASCADE,
  invoice_id BIGINT REFERENCES invoices(id) ON DELETE CASCADE,
  method     TEXT NOT NULL CHECK (method IN ('cod', 'khqr')),
  amount     NUMERIC(10, 2) NOT NULL,
  state      TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'settled', 'failed')),
  qr_payload TEXT,
  expires_at TIMESTAMPTZ,
  settled_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((order_id IS NOT NULL) <> (invoice_id IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS admin_config (
  key   TEXT PRIMARY KEY,
  value JSONB NOT NULL
);

-- Each store connects its own Telegram bot. The token is stored encrypted (AES-256-GCM).
ALTER TABLE sellers ADD COLUMN IF NOT EXISTS bot_token_enc TEXT;
ALTER TABLE sellers ADD COLUMN IF NOT EXISTS bot_username  TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS sellers_bot_username_key ON sellers (lower(bot_username));

-- Superseded by per-store bots (a customer's chat is now always with that store's own bot).
DROP TABLE IF EXISTS bot_sessions;

INSERT INTO admin_config (key, value) VALUES
  ('standard_fee',     '15'),
  ('invoice_due_day',  '5'),
  ('delivery_fee',     '1.5'),
  ('khqr_enabled',     'true'),
  ('cod_enabled',      'true'),
  ('signups_open',     'false'),
  ('telegram_alerts',  'true')
ON CONFLICT (key) DO NOTHING;

/* ------------------------- Procurement & stock ledger ------------------------- */

ALTER TABLE products ADD COLUMN IF NOT EXISTS cost NUMERIC(10, 2) CHECK (cost IS NULL OR cost >= 0);

-- Every change to a product's stock, so the quantity is always explainable.
CREATE TABLE IF NOT EXISTS stock_movements (
  id         BIGSERIAL PRIMARY KEY,
  product_id BIGINT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  seller_id  BIGINT NOT NULL REFERENCES sellers(id) ON DELETE CASCADE,
  delta      INTEGER NOT NULL CHECK (delta <> 0),
  reason     TEXT NOT NULL CHECK (reason IN ('initial', 'sale', 'cancel', 'purchase', 'adjustment')),
  ref        TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS stock_movements_seller_idx ON stock_movements(seller_id, created_at DESC);

CREATE TABLE IF NOT EXISTS suppliers (
  id           BIGSERIAL PRIMARY KEY,
  seller_id    BIGINT NOT NULL REFERENCES sellers(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  contact_name TEXT,
  phone        TEXT,
  email        TEXT,
  address      TEXT,
  notes        TEXT,
  active       BOOLEAN NOT NULL DEFAULT true,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS suppliers_seller_idx ON suppliers(seller_id);

CREATE SEQUENCE IF NOT EXISTS po_code_seq START 1001;

CREATE TABLE IF NOT EXISTS purchase_orders (
  id            BIGSERIAL PRIMARY KEY,
  code          TEXT NOT NULL UNIQUE,
  seller_id     BIGINT NOT NULL REFERENCES sellers(id) ON DELETE CASCADE,
  supplier_id   BIGINT NOT NULL REFERENCES suppliers(id) ON DELETE RESTRICT,
  status        TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'ordered', 'received', 'cancelled')),
  expected_date DATE,
  shipping_cost NUMERIC(10, 2) NOT NULL DEFAULT 0 CHECK (shipping_cost >= 0),
  notes         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  ordered_at    TIMESTAMPTZ,
  received_at   TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS purchase_orders_seller_idx ON purchase_orders(seller_id, created_at DESC);

CREATE TABLE IF NOT EXISTS purchase_order_items (
  id         BIGSERIAL PRIMARY KEY,
  po_id      BIGINT NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  product_id BIGINT NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  quantity   INTEGER NOT NULL CHECK (quantity > 0),
  unit_cost  NUMERIC(10, 2) NOT NULL CHECK (unit_cost >= 0)
);
CREATE INDEX IF NOT EXISTS po_items_po_idx ON purchase_order_items(po_id);

/* -------------------------------- Logistics -------------------------------- */

CREATE TABLE IF NOT EXISTS couriers (
  id         BIGSERIAL PRIMARY KEY,
  seller_id  BIGINT NOT NULL REFERENCES sellers(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  phone      TEXT,
  kind       TEXT NOT NULL DEFAULT 'own' CHECK (kind IN ('own', 'partner')),
  active     BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS couriers_seller_idx ON couriers(seller_id);

CREATE TABLE IF NOT EXISTS shipments (
  id            BIGSERIAL PRIMARY KEY,
  order_id      BIGINT NOT NULL UNIQUE REFERENCES orders(id) ON DELETE CASCADE,
  seller_id     BIGINT NOT NULL REFERENCES sellers(id) ON DELETE CASCADE,
  courier_id    BIGINT REFERENCES couriers(id) ON DELETE SET NULL,
  tracking_code TEXT,
  status        TEXT NOT NULL DEFAULT 'assigned'
                CHECK (status IN ('assigned', 'picked_up', 'in_transit', 'delivered', 'failed', 'cancelled')),
  cod_amount    NUMERIC(10, 2) NOT NULL DEFAULT 0,
  note          TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS shipments_seller_idx ON shipments(seller_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS shipment_events (
  id          BIGSERIAL PRIMARY KEY,
  shipment_id BIGINT NOT NULL REFERENCES shipments(id) ON DELETE CASCADE,
  status      TEXT NOT NULL,
  note        TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS shipment_events_idx ON shipment_events(shipment_id, created_at);

-- Opening balance for products that existed before the ledger (idempotent).
INSERT INTO stock_movements (product_id, seller_id, delta, reason, ref)
SELECT p.id, p.seller_id, i.quantity, 'initial', 'opening balance'
  FROM products p JOIN inventory i ON i.product_id = p.id
 WHERE i.quantity > 0 AND NOT EXISTS (SELECT 1 FROM stock_movements m WHERE m.product_id = p.id);

/* ------------------------------ Product images ------------------------------ */

-- Stored in the database (resized client-side to ~1000px, capped at 2 MB) so there is no file storage to manage.
ALTER TABLE products ADD COLUMN IF NOT EXISTS image_data       BYTEA;
ALTER TABLE products ADD COLUMN IF NOT EXISTS image_type       TEXT;
ALTER TABLE products ADD COLUMN IF NOT EXISTS image_updated_at TIMESTAMPTZ;

/* ------------------------------ Profile pictures ------------------------------ */

ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_data       BYTEA;
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_type       TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_updated_at TIMESTAMPTZ;

/* -------------------------------- Shop logos -------------------------------- */

-- The store's logo (JPEG). Also pushed to the store's Telegram bot as its profile picture.
ALTER TABLE sellers ADD COLUMN IF NOT EXISTS logo_data       BYTEA;
ALTER TABLE sellers ADD COLUMN IF NOT EXISTS logo_type       TEXT;
ALTER TABLE sellers ADD COLUMN IF NOT EXISTS logo_updated_at TIMESTAMPTZ;
