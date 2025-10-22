
import 'dotenv/config';
import express from 'express';
import morgan from 'morgan';
import cors from 'cors';
import bodyParser from 'body-parser';
import path from 'path';
import fs from 'fs';
import axios from 'axios';
import Database from 'better-sqlite3';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 8080;
const APP_URL = process.env.APP_URL || `http://localhost:${PORT}`;
const DB_PATH = process.env.DATABASE_URL || './data/store.db';
const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_IDS = (process.env.ADMIN_TELEGRAM_IDS || '').split(',').map(s=>s.trim()).filter(Boolean);

// --- AUTO MIGRATION (создание таблиц, если их нет)
function ensureSchema() {
  db.exec(`
  PRAGMA journal_mode=WAL;
  CREATE TABLE IF NOT EXISTS products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sku TEXT UNIQUE NOT NULL,
    title TEXT NOT NULL,
    description TEXT,
    price INTEGER NOT NULL,
    currency TEXT NOT NULL DEFAULT 'USD',
    image_url TEXT,
    is_active INTEGER NOT NULL DEFAULT 1
  );
  CREATE TABLE IF NOT EXISTS keys (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id INTEGER NOT NULL,
    code TEXT NOT NULL,
    is_used INTEGER NOT NULL DEFAULT 0,
    used_at TEXT,
    order_id INTEGER,
    FOREIGN KEY(product_id) REFERENCES products(id)
  );
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tg_id TEXT UNIQUE NOT NULL,
    tg_username TEXT,
    is_admin INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    product_id INTEGER NOT NULL,
    amount INTEGER NOT NULL,
    currency TEXT NOT NULL,
    status TEXT NOT NULL,
    provider TEXT,
    provider_invoice_id TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    paid_at TEXT,
    delivered_key TEXT,
    FOREIGN KEY(user_id) REFERENCES users(id),
    FOREIGN KEY(product_id) REFERENCES products(id)
  );`);
  console.log('SQLite schema ensured at', DB_PATH);
}


fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

function verifyTelegramInitData(initData) {
  if (!initData || !BOT_TOKEN) return false;
  const urlParams = new URLSearchParams(initData);
  const hash = urlParams.get('hash');
  const dataCheckArr = [];
  urlParams.forEach((value, key) => { if (key !== 'hash') dataCheckArr.push(`${key}=${value}`); });
  dataCheckArr.sort();
  const dataCheckString = dataCheckArr.join('\n');
  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  const hmac = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
  return hmac === hash;
}
function getUserFromInitData(initData) {
  if (!initData) return null;
  const params = new URLSearchParams(initData);
  const userStr = params.get('user');
  try { return JSON.parse(userStr); } catch { return null; }
}
async function sendDM(tgId, text) {
  if (!BOT_TOKEN) return;
  const api = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
  await axios.post(api, { chat_id: tgId, text, parse_mode: 'Markdown' });
}

const app = express();
app.use(morgan('dev'));
app.use(cors());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

function auth(req,res,next){
  if (process.env.NODE_ENV !== 'production' && req.query.devUser) {
    req.user = { id: String(req.query.devUser), username: 'dev' };
    return next();
  }
  const initData = req.header('x-telegram-init-data') || req.query.initData;
  if (!initData) return res.status(401).json({ error:'Missing initData'});
  const ok = verifyTelegramInitData(initData);
  if (!ok) return res.status(401).json({ error:'Invalid initData'});
  const user = getUserFromInitData(initData);
  if (!user) return res.status(401).json({ error:'Bad user'});
  req.user = { id: String(user.id), username: user.username };
  db.prepare(`INSERT OR IGNORE INTO users (tg_id, tg_username) VALUES (?,?)`).run(req.user.id, req.user.username||null);
  db.prepare(`UPDATE users SET tg_username=? WHERE tg_id=?`).run(req.user.username||null, req.user.id);
  next();
}
function adminOnly(req,res,next){ if (ADMIN_IDS.includes(req.user?.id)) return next(); return res.status(403).json({ error:'Admin only' }); }

app.get('/api/products', (req,res)=>{
  const q = (req.query.search||'').toString().trim().toLowerCase();
  const page = parseInt(req.query.page||'1',10);
  const limit = parseInt(req.query.limit||'20',10);
  const offset = (page-1)*limit;
  let items;
  if (q) items = db.prepare(`SELECT * FROM products WHERE is_active=1 AND (lower(title) LIKE ? OR lower(sku) LIKE ?) LIMIT ? OFFSET ?`).all(`%${q}%`,`%${q}%`,limit,offset);
  else items = db.prepare(`SELECT * FROM products WHERE is_active=1 ORDER BY id DESC LIMIT ? OFFSET ?`).all(limit,offset);
  const total = db.prepare(`SELECT COUNT(*) as c FROM products WHERE is_active=1`).get().c;
  res.json({ items, total, page, pages: Math.max(1, Math.ceil(total/limit)) });
});
app.post('/api/products', auth, adminOnly, (req,res)=>{
  const { sku, title, description, price, currency, image_url, is_active } = req.body;
  const info = db.prepare(`INSERT INTO products (sku,title,description,price,currency,image_url,is_active) VALUES (?,?,?,?,?,?,?)`)
    .run(sku, title, description||'', price, (currency||'USD').toUpperCase(), image_url||'', is_active?1:1);
  res.json({ id: Number(info.lastInsertRowid) });
});
app.post('/api/products/:id/keys', auth, adminOnly, (req,res)=>{
  const pid = parseInt(req.params.id,10);
  const keys = Array.isArray(req.body?.keys) ? req.body.keys : [];
  const insert = db.prepare(`INSERT INTO keys (product_id, code) VALUES (?,?)`);
  const tx = db.transaction(arr => { for (const k of arr) insert.run(pid, String(k).trim()); });
  tx(keys);
  res.json({ added: keys.length });
});
app.post('/api/checkout', auth, async (req,res)=>{
  try{
    const { productId, provider } = req.body;
    const product = db.prepare(`SELECT * FROM products WHERE id=? AND is_active=1`).get(productId);
    if (!product) return res.status(404).json({ error:'Product not found' });
    const user = db.prepare(`SELECT * FROM users WHERE tg_id=?`).get(req.user.id);
    const info = db.prepare(`INSERT INTO orders (user_id, product_id, amount, currency, status, provider) VALUES (?,?,?,?, 'pending', ?)`)
      .run(user.id, product.id, product.price, product.currency, provider||'test');
    const orderId = Number(info.lastInsertRowid);
    let redirectUrl = `${APP_URL}/order.html?id=${orderId}`;
    if (provider === 'yookassa' && process.env.YOOKASSA_SHOP_ID && process.env.YOOKASSA_SECRET_KEY) redirectUrl = `${APP_URL}/pay/yookassa.html?order=${orderId}`;
    else if (provider === 'nowpayments' && process.env.NOWPAYMENTS_API_KEY) redirectUrl = `${APP_URL}/pay/nowpayments.html?order=${orderId}`;
    else if (process.env.NODE_ENV !== 'production') {
      db.prepare(`UPDATE orders SET status='paid', paid_at=CURRENT_TIMESTAMP WHERE id=?`).run(orderId);
      await deliverKey(orderId);
      redirectUrl = `${APP_URL}/order.html?id=${orderId}&paid=1`;
    }
    res.json({ orderId, redirectUrl });
  }catch(e){ console.error(e); res.status(500).json({ error:String(e.message||e) }); }
});
app.get('/api/my/orders', auth, (req,res)=>{
  const u = db.prepare(`SELECT * FROM users WHERE tg_id=?`).get(req.user.id);
  const rows = db.prepare(`SELECT * FROM orders WHERE user_id=? ORDER BY id DESC`).all(u.id);
  res.json({ items: rows });
});
app.post('/api/webhooks/yookassa', express.json(), async (req,res)=>{
  try{
    const ev = req.body;
    const orderId = Number(ev?.object?.metadata?.orderId || ev?.object?.metadata?.order_id);
    if (ev?.event === 'payment.succeeded' && orderId) {
      db.prepare(`UPDATE orders SET status='paid', paid_at=CURRENT_TIMESTAMP WHERE id=?`).run(orderId);
      await deliverKey(orderId);
    }
  }catch(e){ console.error(e); }
  res.json({ ok:true });
});
app.post('/api/webhooks/nowpayments', express.json(), async (req,res)=>{
  try{
    const ev = req.body;
    const orderId = Number(ev?.order_id || ev?.orderId);
    if (ev?.payment_status === 'finished' && orderId) {
      db.prepare(`UPDATE orders SET status='paid', paid_at=CURRENT_TIMESTAMP WHERE id=?`).run(orderId);
      await deliverKey(orderId);
    }
  }catch(e){ console.error(e); }
  res.json({ ok:true });
});
app.post('/api/telegram/webhook', express.json(), async (req,res)=>{
  try{
    const message = req.body?.message;
    if (message?.text === '/start' && BOT_TOKEN) {
      await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
        chat_id: message.from.id,
        text: 'Открыть магазин',
        reply_markup: { inline_keyboard: [[{ text: 'Открыть', web_app: { url: APP_URL } }]] }
      });
    }
  }catch(e){ console.error(e); }
  res.json({ ok:true });
});
async function deliverKey(orderId){
  const o = db.prepare(`SELECT o.*, p.title, u.tg_id FROM orders o JOIN products p ON p.id=o.product_id JOIN users u ON u.id=o.user_id WHERE o.id=?`).get(orderId);
  if (!o || o.status !== 'paid') return;
  if (o.delivered_key) return;
  const key = db.prepare(`SELECT * FROM keys WHERE product_id=? AND is_used=0 ORDER BY id ASC`).get(o.product_id);
  if (!key) throw new Error('No stock');
  db.prepare(`UPDATE keys SET is_used=1, used_at=CURRENT_TIMESTAMP, order_id=? WHERE id=?`).run(o.id, key.id);
  db.prepare(`UPDATE orders SET delivered_key=? WHERE id=?`).run(key.code, o.id);
  await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, { chat_id: o.tg_id, text: `Спасибо за покупку!\n\n*${o.title}*\nВаш ключ: \`${key.code}\``, parse_mode:'Markdown' });
}
app.get('*', (req,res)=>{ res.sendFile(path.join(__dirname, 'public', 'index.html')); });
app.listen(PORT, ()=>console.log('LITE API on', PORT));
