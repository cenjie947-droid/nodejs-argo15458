const express = require('express');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const { rateLimit } = require('express-rate-limit');
const multer = require('multer');
const crypto = require('crypto');
const { Pool } = require('pg');
const path = require('path');

const app = express();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.DATABASE_URL?.includes('render.com') ? { rejectUnauthorized: false } : undefined, max: 5 });
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const COOKIE_SECRET = process.env.COOKIE_SECRET;
if (!process.env.DATABASE_URL || !ADMIN_PASSWORD || !COOKIE_SECRET) {
  console.error('Missing required env: DATABASE_URL, ADMIN_PASSWORD, COOKIE_SECRET'); process.exit(1);
}
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '7mb' }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 3 * 1024 * 1024 } });
const limiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 80, standardHeaders: 'draft-7', legacyHeaders: false });
app.use('/api', limiter);

const schema = `
CREATE TABLE IF NOT EXISTS products (
 id BIGSERIAL PRIMARY KEY, name TEXT NOT NULL, category TEXT NOT NULL DEFAULT '数字商品',
 description TEXT NOT NULL DEFAULT '', price_cents INTEGER NOT NULL CHECK(price_cents >= 0),
 image_data TEXT, stock INTEGER NOT NULL DEFAULT -1, is_active BOOLEAN NOT NULL DEFAULT true,
 sort_order INTEGER NOT NULL DEFAULT 0, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS orders (
 id BIGSERIAL PRIMARY KEY, order_no TEXT NOT NULL UNIQUE, remark_code CHAR(6) NOT NULL UNIQUE,
 product_id BIGINT REFERENCES products(id) ON DELETE SET NULL, product_name TEXT NOT NULL,
 unit_price_cents INTEGER NOT NULL, quantity INTEGER NOT NULL CHECK(quantity > 0), total_cents INTEGER NOT NULL,
 payment_method TEXT NOT NULL CHECK(payment_method IN ('wechat','alipay')),
 customer_contact TEXT NOT NULL, status TEXT NOT NULL DEFAULT '待付款',
 delivery_note TEXT NOT NULL DEFAULT '', admin_note TEXT NOT NULL DEFAULT '',
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(), paid_at TIMESTAMPTZ, delivered_at TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS store_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL DEFAULT '');
CREATE INDEX IF NOT EXISTS orders_created_idx ON orders(created_at DESC);
CREATE INDEX IF NOT EXISTS orders_status_idx ON orders(status);
`;
async function init(){ await pool.query(schema); console.log('Database schema ready'); }
function sign(value){ return crypto.createHmac('sha256', COOKIE_SECRET).update(value).digest('hex'); }
function admin(req,res,next){
 const token=req.cookies.shihai_admin;
 if(!token) return res.status(401).json({error:'请先登录后台'});
 const [exp,sig]=token.split('.');
 if(!exp || Number(exp)<Date.now() || sign(exp)!==sig) return res.status(401).json({error:'登录已过期，请重新登录'});
 next();
}
const money = n => Number(n);
app.post('/api/admin/login', rateLimit({windowMs:15*60*1000,limit:8,standardHeaders:true,legacyHeaders:false}), (req,res)=>{
 const password=String(req.body.password||'');
 if(password.length>200 || !crypto.timingSafeEqual(Buffer.from(crypto.createHash('sha256').update(password).digest('hex')),Buffer.from(crypto.createHash('sha256').update(ADMIN_PASSWORD).digest('hex')))) return res.status(401).json({error:'密码错误'});
 const exp=String(Date.now()+12*60*60*1000);
 res.cookie('shihai_admin',exp+'.'+sign(exp),{httpOnly:true,secure:process.env.NODE_ENV==='production',sameSite:'strict',maxAge:12*60*60*1000});
 res.json({ok:true});
});
app.post('/api/admin/logout',admin,(req,res)=>{res.clearCookie('shihai_admin');res.json({ok:true});});
app.get('/api/products',async(req,res)=>{const {rows}=await pool.query('SELECT id,name,category,description,price_cents,image_data,stock FROM products WHERE is_active=true ORDER BY sort_order,id DESC');res.json(rows);});
app.get('/api/settings/public',async(req,res)=>{const {rows}=await pool.query("SELECT key,value FROM store_settings WHERE key IN ('wechat_qr','alipay_qr','announcement','store_name')");res.json(Object.fromEntries(rows.map(x=>[x.key,x.value])));});
app.post('/api/orders',async(req,res)=>{
 const {product_id,quantity,payment_method,customer_contact}=req.body;
 const q=Number(quantity);
 if(!Number.isInteger(q)||q<1||q>99||!['wechat','alipay'].includes(payment_method)||!String(customer_contact||'').trim()||String(customer_contact).length>180) return res.status(400).json({error:'请检查购买数量、支付方式和交付联系方式'});
 const client=await pool.connect();
 try{
  await client.query('BEGIN');
  const p=await client.query('SELECT * FROM products WHERE id=$1 AND is_active=true FOR UPDATE',[product_id]);
  if(!p.rowCount) throw new Error('商品不存在或已下架');
  const item=p.rows[0]; if(item.stock>=0 && item.stock<q) throw new Error('库存不足');
  const total=item.price_cents*q; let code='', orderNo='';
  for(let i=0;i<12;i++){code=String(crypto.randomInt(0,1000000)).padStart(6,'0');orderNo='SH'+Date.now().toString(36).toUpperCase()+crypto.randomBytes(2).toString('hex').toUpperCase();try{await client.query('INSERT INTO orders(order_no,remark_code,product_id,product_name,unit_price_cents,quantity,total_cents,payment_method,customer_contact) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',[orderNo,code,item.id,item.name,item.price_cents,q,total,payment_method,String(customer_contact).trim()]);break;}catch(e){if(e.code!=='23505'||i===11)throw e;}}
  if(item.stock>=0) await client.query('UPDATE products SET stock=stock-$1 WHERE id=$2',[q,item.id]);
  await client.query('COMMIT');
  res.json({order_no:orderNo,remark_code:code,total_cents:total,product_name:item.name,quantity:q,payment_method});
 }catch(e){await client.query('ROLLBACK');res.status(400).json({error:e.message||'创建订单失败'});}finally{client.release();}
});
app.get('/api/orders/:no',async(req,res)=>{const {rows}=await pool.query('SELECT order_no,product_name,quantity,total_cents,payment_method,status,delivery_note,created_at,paid_at,delivered_at FROM orders WHERE order_no=$1',[req.params.no]);if(!rows.length)return res.status(404).json({error:'未找到该订单'});res.json(rows[0]);});
app.get('/api/admin/overview',admin,async(req,res)=>{
 const [p,o,s]=await Promise.all([pool.query('SELECT * FROM products ORDER BY id DESC'),pool.query('SELECT * FROM orders ORDER BY created_at DESC LIMIT 300'),pool.query('SELECT key,value FROM store_settings')]);
 res.json({products:p.rows,orders:o.rows,settings:Object.fromEntries(s.rows.map(x=>[x.key,x.value]))});
});
app.post('/api/admin/products',admin,async(req,res)=>{const {name,category,description,price,stock,is_active,image_data}=req.body;const cents=Math.round(Number(price)*100);if(!String(name||'').trim()||!Number.isSafeInteger(cents)||cents<0)return res.status(400).json({error:'商品名称和价格无效'});const r=await pool.query('INSERT INTO products(name,category,description,price_cents,stock,is_active,image_data) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *',[name.trim(),category||'数字商品',description||'',cents,Number.isInteger(Number(stock))?Number(stock):-1,is_active!==false,image_data||null]);res.json(r.rows[0]);});
app.put('/api/admin/products/:id',admin,async(req,res)=>{const {name,category,description,price,stock,is_active,image_data}=req.body;const cents=Math.round(Number(price)*100);if(!String(name||'').trim()||!Number.isSafeInteger(cents)||cents<0)return res.status(400).json({error:'商品名称和价格无效'});const r=await pool.query('UPDATE products SET name=$1,category=$2,description=$3,price_cents=$4,stock=$5,is_active=$6,image_data=$7,updated_at=now() WHERE id=$8 RETURNING *',[name.trim(),category||'数字商品',description||'',cents,Number.isInteger(Number(stock))?Number(stock):-1,!!is_active,image_data||null,req.params.id]);if(!r.rowCount)return res.status(404).json({error:'商品不存在'});res.json(r.rows[0]);});
app.delete('/api/admin/products/:id',admin,async(req,res)=>{await pool.query('UPDATE products SET is_active=false WHERE id=$1',[req.params.id]);res.json({ok:true});});
app.patch('/api/admin/orders/:id',admin,async(req,res)=>{const allowed=['待付款','已付款','采购中','已交付','已退款','异常待核对'];const {status,delivery_note,admin_note}=req.body;if(!allowed.includes(status))return res.status(400).json({error:'无效订单状态'});const r=await pool.query('UPDATE orders SET status=$1,delivery_note=$2,admin_note=$3,paid_at=CASE WHEN $1 IN (\'已付款\',\'采购中\',\'已交付\') AND paid_at IS NULL THEN now() ELSE paid_at END,delivered_at=CASE WHEN $1=\'已交付\' THEN now() ELSE delivered_at END WHERE id=$4 RETURNING id',[status,delivery_note||'',admin_note||'',req.params.id]);if(!r.rowCount)return res.status(404).json({error:'订单不存在'});res.json({ok:true});});
app.put('/api/admin/settings',admin,async(req,res)=>{for(const key of ['wechat_qr','alipay_qr','announcement','store_name']){if(req.body[key]!==undefined)await pool.query('INSERT INTO store_settings(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=excluded.value',[key,String(req.body[key]).slice(0,5000000)]);}res.json({ok:true});});
app.post('/api/admin/upload',admin,upload.single('file'),(req,res)=>{if(!req.file)return res.status(400).json({error:'请选择图片'});if(!req.file.mimetype.startsWith('image/'))return res.status(400).json({error:'仅支持图片'});res.json({data_url:'data:'+req.file.mimetype+';base64,'+req.file.buffer.toString('base64')});});
app.get('/health',async(req,res)=>{await pool.query('SELECT 1');res.json({ok:true});});
app.use((err,req,res,next)=>{console.error(err);res.status(500).json({error:'服务器内部错误'});});
init().then(()=>app.listen(PORT,'0.0.0.0',()=>console.log('拾海商城 listening on '+PORT))).catch(e=>{console.error(e);process.exit(1);});
