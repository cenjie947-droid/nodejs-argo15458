CREATE TABLE IF NOT EXISTS products (
 id BIGSERIAL PRIMARY KEY,
 name TEXT NOT NULL,
 category TEXT NOT NULL DEFAULT '数字商品',
 description TEXT NOT NULL DEFAULT '',
 price_cents INTEGER NOT NULL CHECK(price_cents >= 0),
 image_data TEXT,
 stock INTEGER NOT NULL DEFAULT -1,
 is_active BOOLEAN NOT NULL DEFAULT true,
 sort_order INTEGER NOT NULL DEFAULT 0,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS orders (
 id BIGSERIAL PRIMARY KEY,
 order_no TEXT NOT NULL UNIQUE,
 remark_code CHAR(6) NOT NULL UNIQUE,
 product_id BIGINT REFERENCES products(id) ON DELETE SET NULL,
 product_name TEXT NOT NULL,
 unit_price_cents INTEGER NOT NULL,
 quantity INTEGER NOT NULL CHECK(quantity > 0),
 total_cents INTEGER NOT NULL,
 payment_method TEXT NOT NULL CHECK(payment_method IN ('wechat','alipay')),
 customer_contact TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT '待付款',
 delivery_note TEXT NOT NULL DEFAULT '',
 admin_note TEXT NOT NULL DEFAULT '',
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 paid_at TIMESTAMPTZ,
 delivered_at TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS store_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL DEFAULT '');
CREATE INDEX IF NOT EXISTS orders_created_idx ON orders(created_at DESC);
CREATE INDEX IF NOT EXISTS orders_status_idx ON orders(status);
