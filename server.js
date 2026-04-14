const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const line = require('@line/bot-sdk');
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'clinic-secret-2024';

const lineConfig = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN || '',
  channelSecret: process.env.LINE_CHANNEL_SECRET || '',
};
const lineClient = new line.messagingApi.MessagingApiClient({ channelAccessToken: lineConfig.channelAccessToken });

const db = new Database(process.env.DB_PATH || '/tmp/clinic.db');
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    line_user_id TEXT UNIQUE,
    name TEXT,
    role TEXT DEFAULT 'staff',
    created_at TEXT DEFAULT (datetime('now','localtime'))
  );
  CREATE TABLE IF NOT EXISTS revenues (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT, item TEXT, amount REAL, note TEXT,
    created_by TEXT,
    created_at TEXT DEFAULT (datetime('now','localtime'))
  );
  CREATE TABLE IF NOT EXISTS expenses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT, item TEXT, amount REAL, category TEXT, note TEXT,
    created_by TEXT,
    created_at TEXT DEFAULT (datetime('now','localtime'))
  );
  CREATE TABLE IF NOT EXISTS petty_cash (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT, item TEXT, amount REAL, tx_type TEXT,
    created_by TEXT,
    created_at TEXT DEFAULT (datetime('now','localtime'))
  );
  CREATE TABLE IF NOT EXISTS petty_init (
    id INTEGER PRIMARY KEY DEFAULT 1,
    amount REAL DEFAULT 5000
  );
  CREATE TABLE IF NOT EXISTS accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE, init_amount REAL, balance REAL
  );
  CREATE TABLE IF NOT EXISTS account_tx (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT, account TEXT, item TEXT, amount REAL, dir TEXT,
    created_at TEXT DEFAULT (datetime('now','localtime'))
  );
  CREATE TABLE IF NOT EXISTS invite_codes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT UNIQUE,
    role TEXT DEFAULT 'staff',
    used INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now','localtime'))
  );
`);
const pi = db.prepare('SELECT * FROM petty_init WHERE id=1').get();
if (!pi) db.prepare('INSERT INTO petty_init (id,amount) VALUES (1,5000)').run();

app.use(cors());
app.use('/webhook', express.raw({ type: '*/*' }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function auth(req, res, next) {
  const token = req.headers['authorization']?.split(' ')[1];
  if (!token) return res.status(401).json({ error: '請先登入' });
  try { req.user = jwt.verify(token, JWT_SECRET); next(); }
  catch { res.status(401).json({ error: 'Token 無效' }); }
}
function adminOnly(req, res, next) {
  if (req.user.role !== 'admin') return res.status(403).json({ error: '需要管理員權限' });
  next();
}

app.post('/webhook', line.middleware(lineConfig), async (req, res) => {
  res.sendStatus(200);
  const events = req.body.events || [];
  for (const event of events) {
    if (event.type !== 'message' || event.message.type !== 'text') continue;
    const userId = event.source.userId;
    const text = event.message.text.trim();
    const replyToken = event.replyToken;
    const user = db.prepare('SELECT * FROM users WHERE line_user_id=?').get(userId);
    if (text.startsWith('邀請碼:') || text.startsWith('邀請碼：')) {
      const code = text.replace(/邀請碼[：:]/,'').trim();
      const inv = db.prepare('SELECT * FROM invite_codes WHERE code=? AND used=0').get(code);
      if (!inv) { await replyText(replyToken,'邀請碼無效或已使用'); continue; }
      let profile;
      try { profile = await lineClient.getProfile(userId); } catch { profile = { displayName: '使用者' }; }
      if (user) { db.prepare('UPDATE users SET role=? WHERE line_user_id=?').run(inv.role, userId); }
      else { db.prepare('INSERT OR IGNORE INTO users (line_user_id,name,role) VALUES (?,?,?)').run(userId, profile.displayName, inv.role); }
      db.prepare('UPDATE invite_codes SET used=1 WHERE id=?').run(inv.id);
      const roleLabel = inv.role === 'admin' ? '管理員' : '一般員工';
      await replyText(replyToken, `✅ 綁定成功！\n姓名：${profile.displayName}\n權限：${roleLabel}\n\n請點選以下連結開啟記帳系統：\n${process.env.LIFF_URL || ''}`);
      continue;
    }
    if (!user) { await replyText(replyToken, '您尚未綁定帳號\n請輸入「邀請碼:XXXX」來綁定'); continue; }
    if (text === '報表' || text === '今日報表') {
      const month = new Date().toISOString().slice(0,7);
      const revSum = db.prepare('SELECT SUM(amount) as s FROM revenues WHERE date LIKE ?').get(month+'%')?.s || 0;
      const expSum = db.prepare('SELECT SUM(amount) as s FROM expenses WHERE date LIKE ?').get(month+'%')?.s || 0;
      const pettyInit = db.prepare('SELECT amount FROM petty_init WHERE id=1').get()?.amount || 0;
      const pettyTx = db.prepare('SELECT SUM(CASE WHEN tx_type="in" THEN amount ELSE -amount END) as s FROM petty_cash').get()?.s || 0;
      const msg = `📊 ${month} 財務報表\n\n💰 本月營收：NT$${Math.round(revSum).toLocaleString()}\n💸 本月支出：NT$${Math.round(expSum).toLocaleString()}\n📈 本月淨利：NT$${Math.round(revSum-expSum).toLocaleString()}\n💵 零用金餘額：NT$${Math.round(pettyInit+pettyTx).toLocaleString()}\n\n點此開啟系統：\n${process.env.LIFF_URL || ''}`;
      await replyText(replyToken, msg); continue;
    }
    if (text === '記帳' || text === '開啟記帳') { await replyText(replyToken, `請點以下連結：\n${process.env.LIFF_URL || ''}`); continue; }
    await replyText(replyToken, `您好 ${user.name}！\n\n📊 報表 - 查看本月報表\n💻 記帳 - 開啟記帳系統`);
  }
});

async function replyText(token, text) {
  try { await lineClient.replyMessage({ replyToken: token, messages: [{ type: 'text', text }] }); }
  catch(e) { console.error('Reply error:', e.message); }
}

app.post('/api/line-login', async (req, res) => {
  const { lineUserId, displayName } = req.body;
  if (!lineUserId) return res.status(400).json({ error: '缺少 LINE User ID' });
  let user = db.prepare('SELECT * FROM users WHERE line_user_id=?').get(lineUserId);
  if (!user) {
    db.prepare('INSERT INTO users (line_user_id,name,role) VALUES (?,?,?)').run(lineUserId, displayName||'使用者', 'pending');
    user = db.prepare('SELECT * FROM users WHERE line_user_id=?').get(lineUserId);
  }
  if (user.role === 'pending') return res.status(403).json({ error: '請先輸入邀請碼綁定帳號', needInvite: true });
  const token = jwt.sign({ id: user.id, lineUserId, name: user.name, role: user.role }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, user: { id: user.id, name: user.name, role: user.role } });
});

app.post('/api/invite', auth, adminOnly, (req, res) => {
  const { role = 'staff' } = req.body;
  const code = Math.random().toString(36).slice(2,8).toUpperCase();
  db.prepare('INSERT INTO invite_codes (code,role) VALUES (?,?)').run(code, role);
  res.json({ code, role });
});
app.get('/api/users', auth, adminOnly, (req, res) => {
  res.json(db.prepare('SELECT id,name,role,created_at FROM users WHERE role != "pending"').all());
});
app.delete('/api/users/:id', auth, adminOnly, (req, res) => {
  db.prepare('DELETE FROM users WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

app.get('/api/revenues', auth, (req, res) => {
  const { month } = req.query;
  res.json(month ? db.prepare('SELECT * FROM revenues WHERE date LIKE ? ORDER BY date DESC').all(month+'%') : db.prepare('SELECT * FROM revenues ORDER BY date DESC').all());
});
app.post('/api/revenues', auth, (req, res) => {
  const { date, item, amount, note } = req.body;
  const r = db.prepare('INSERT INTO revenues (date,item,amount,note,created_by) VALUES (?,?,?,?,?)').run(date,item,amount,note||'',req.user.name);
  res.json({ id: r.lastInsertRowid });
});
app.delete('/api/revenues/:id', auth, (req, res) => { db.prepare('DELETE FROM revenues WHERE id=?').run(req.params.id); res.json({ ok: true }); });

app.get('/api/expenses', auth, (req, res) => {
  const { month } = req.query;
  res.json(month ? db.prepare('SELECT * FROM expenses WHERE date LIKE ? ORDER BY date DESC').all(month+'%') : db.prepare('SELECT * FROM expenses ORDER BY date DESC').all());
});
app.post('/api/expenses', auth, (req, res) => {
  const { date, item, amount, category, note } = req.body;
  const r = db.prepare('INSERT INTO expenses (date,item,amount,category,note,created_by) VALUES (?,?,?,?,?,?)').run(date,item,amount,category||'其他',note||'',req.user.name);
  res.json({ id: r.lastInsertRowid });
});
app.delete('/api/expenses/:id', auth, (req, res) => { db.prepare('DELETE FROM expenses WHERE id=?').run(req.params.id); res.json({ ok: true }); });

app.get('/api/petty', auth, (req, res) => {
  const init = db.prepare('SELECT amount FROM petty_init WHERE id=1').get()?.amount || 0;
  const txs = db.prepare('SELECT * FROM petty_cash ORDER BY date DESC').all();
  res.json({ init, txs });
});
app.post('/api/petty/init', auth, adminOnly, (req, res) => { db.prepare('UPDATE petty_init SET amount=? WHERE id=1').run(req.body.amount); res.json({ ok: true }); });
app.post('/api/petty', auth, (req, res) => {
  const { date, item, amount, txType } = req.body;
  db.prepare('INSERT INTO petty_cash (date,item,amount,tx_type,created_by) VALUES (?,?,?,?,?)').run(date,item,amount,txType,req.user.name);
  res.json({ ok: true });
});
app.delete('/api/petty/:id', auth, (req, res) => { db.prepare('DELETE FROM petty_cash WHERE id=?').run(req.params.id); res.json({ ok: true }); });

app.get('/api/accounts', auth, (req, res) => { res.json(db.prepare('SELECT * FROM accounts').all()); });
app.post('/api/accounts', auth, adminOnly, (req, res) => {
  const { name, initAmount } = req.body;
  db.prepare('INSERT OR IGNORE INTO accounts (name,init_amount,balance) VALUES (?,?,?)').run(name, initAmount, initAmount);
  res.json({ ok: true });
});
app.get('/api/account-tx', auth, (req, res) => { res.json(db.prepare('SELECT * FROM account_tx ORDER BY date DESC, id DESC').all()); });
app.post('/api/account-tx', auth, (req, res) => {
  const { account, item, amount, dir } = req.body;
  const date = new Date().toISOString().slice(0,10);
  db.prepare('INSERT INTO account_tx (date,account,item,amount,dir) VALUES (?,?,?,?,?)').run(date,account,item,amount,dir);
  db.prepare('UPDATE accounts SET balance=balance+? WHERE name=?').run(dir==='in'?amount:-amount, account);
  res.json({ ok: true });
});

app.get('/api/stats', auth, (req, res) => {
  const months = [];
  const now = new Date();
  for (let i=5;i>=0;i--) {
    const d = new Date(now.getFullYear(), now.getMonth()-i, 1);
    months.push(d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0'));
  }
  res.json(months.map(m => {
    const rev = db.prepare('SELECT SUM(amount) as s FROM revenues WHERE date LIKE ?').get(m+'%')?.s || 0;
    const exp = db.prepare('SELECT SUM(amount) as s FROM expenses WHERE date LIKE ?').get(m+'%')?.s || 0;
    return { month: m, revenue: rev, expense: exp, profit: rev-exp };
  }));
});
app.get('/init-admin', (req, res) => {
  const code = 'ADMIN001';
  db.prepare('INSERT OR IGNORE INTO invite_codes (code,role) VALUES (?,?)').run(code, 'admin');
  res.json({ ok: true, code });
});
app.get('*', (req, res) => { res.sendFile(path.join(__dirname, 'public', 'index.html')); });
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
