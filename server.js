// server.js
const express = require('express');
const Database = require('better-sqlite3');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');

const PORT = process.env.PORT || 8080;
const API_KEY = process.env.API_KEY || 'change-me'; // set in env
const ORIGIN = process.env.CORS_ORIGIN || '*';      // lock to your domain in prod

// --- DB setup ---
const db = new Database('./stake.db');
db.pragma('journal_mode = WAL');

// tables
db.exec(`
CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,          -- stake user id
  name TEXT,
  created_at INTEGER DEFAULT (strftime('%s','now'))
);
CREATE TABLE IF NOT EXISTS cashouts (
  id TEXT PRIMARY KEY,          -- cashout id from preview
  account_id TEXT NOT NULL,
  game TEXT,
  currency TEXT,
  payout REAL,
  payout_multiplier REAL,
  amount REAL,
  amount_multiplier REAL,
  updated_at TEXT,
  captured_at INTEGER DEFAULT (strftime('%s','now')),
  raw_json TEXT,
  FOREIGN KEY (account_id) REFERENCES accounts(id)
);
CREATE INDEX IF NOT EXISTS idx_cashouts_account ON cashouts(account_id);
CREATE INDEX IF NOT EXISTS idx_cashouts_mul ON cashouts(payout_multiplier DESC);
`);

const upsertAccount = db.prepare(`
  INSERT INTO accounts (id, name) VALUES (?, ?)
  ON CONFLICT(id) DO UPDATE SET name=excluded.name
`);
const insertCashout = db.prepare(`
  INSERT OR IGNORE INTO cashouts (
    id, account_id, game, currency, payout, payout_multiplier,
    amount, amount_multiplier, updated_at, raw_json
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

// --- App setup ---
const app = express();
app.use(helmet());
app.use(cors({ origin: ORIGIN }));
app.use(express.json({ limit: '1mb' }));
app.use(morgan('tiny'));

// simple API key guard
app.use('/api', (req, res, next) => {
  const got = (req.headers['authorization'] || '').replace(/^Bearer /i,'').trim();
  if (got && got === API_KEY) return next();
  res.status(401).json({ error: 'Unauthorized' });
});

// Health
app.get('/health', (_req, res) => res.json({ ok: true }));

// Ingest a cashout
app.post('/api/cashouts', (req, res) => {
  try {
    const { minesCashout, user } = req.body || {};
    if (!minesCashout?.id || !user?.id) {
      return res.status(400).json({ error: 'missing fields' });
    }

    // upsert account
    upsertAccount.run(user.id, user.name || null);

    // insert cashout
    insertCashout.run(
      minesCashout.id,
      user.id,
      (minesCashout.game || '').toLowerCase(),
      (minesCashout.currency || '').toLowerCase(),
      Number(minesCashout.payout || 0),
      Number(minesCashout.payoutMultiplier || 0),
      Number(minesCashout.amount || 0),
      Number(minesCashout.amountMultiplier || 0),
      minesCashout.updatedAt || null,
      JSON.stringify(req.body)
    );

    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'server' });
  }
});

// Accounts list
app.get('/api/accounts', (_req, res) => {
  const rows = db.prepare(`SELECT id, name, created_at FROM accounts ORDER BY created_at DESC`).all();
  res.json(rows);
});

// Account summary (top multipliers + counts)
app.get('/api/accounts/:id/summary', (req, res) => {
  const id = req.params.id;
  const top3 = db.prepare(`
    SELECT id, payout, payout_multiplier, currency, game, updated_at, captured_at
    FROM cashouts WHERE account_id = ? AND payout_multiplier > 0
    ORDER BY payout_multiplier DESC LIMIT 3
  `).all(id);
  const totals = db.prepare(`
    SELECT COUNT(*) as total_bets,
           MAX(payout_multiplier) as max_mult,
           SUM(payout) as total_payout
    FROM cashouts WHERE account_id = ?
  `).get(id);
  res.json({ top3, totals });
});

// Paginated bets (all cashouts)
app.get('/api/accounts/:id/cashouts', (req, res) => {
  const id = req.params.id;
  const page = Math.max(1, parseInt(req.query.page || '1', 10));
  const size = Math.min(200, Math.max(1, parseInt(req.query.size || '50', 10)));
  const offset = (page - 1) * size;

  const rows = db.prepare(`
    SELECT id, game, currency, payout, payout_multiplier, amount, amount_multiplier,
           updated_at, captured_at
    FROM cashouts WHERE account_id = ?
    ORDER BY captured_at DESC
    LIMIT ? OFFSET ?
  `).all(id, size, offset);

  res.json({ page, size, rows });
});

// Simple dashboard
app.get('/dashboard', (_req, res) => {
  const accounts = db.prepare(`SELECT id, name FROM accounts ORDER BY created_at DESC`).all();
  // super simple HTML page referencing API
  res.set('Content-Type','text/html').send(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Stake Dashboard</title>
<style>
  body { font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; color:#eee; background:#0b1420; }
  .wrap { max-width: 1100px; margin: 40px auto; }
  h1,h2 { margin: 0 0 12px; }
  .card { background:#0f2130; border:1px solid #1e2f44; border-radius:12px; padding:16px; margin-bottom:16px; }
  table { width:100%; border-collapse: collapse; }
  th, td { padding:8px 10px; border-bottom:1px solid #1e2f44; }
  th { background:#0e212e; }
  a { color:#6ec1ff; text-decoration:none; }
  .muted { color:#9ab; }
</style>
</head>
<body>
<div class="wrap">
  <h1>Stake Accounts</h1>
  ${accounts.map(a => `
    <div class="card">
      <h2>${a.name || a.id}</h2>
      <div class="muted">${a.id}</div>
      <div id="summary-${a.id}">Loading summary…</div>
      <div id="table-${a.id}"></div>
    </div>
  `).join('')}
</div>
<script>
  const fmt = n => (n==null?'—':(typeof n==='number'?n.toLocaleString():n));
  ${accounts.map(a => `
    fetch('/api/accounts/${a.id}/summary', { headers: { 'Authorization': 'Bearer ${API_KEY}' }})
      .then(r=>r.json())
      .then(d=>{
        document.getElementById('summary-${a.id}').innerHTML =
          '<strong>Total Bets:</strong> '+fmt(d.totals.total_bets)+
          ' &nbsp; <strong>Top Mult:</strong> '+fmt(Math.round((d.totals.max_mult||0)*100)/100) + '× ' +
          ' &nbsp; <strong>Total Payout:</strong> ' + fmt(Math.round((d.totals.total_payout||0)*100)/100);
        return fetch('/api/accounts/${a.id}/cashouts?size=25', { headers: { 'Authorization': 'Bearer ${API_KEY}' }});
      })
      .then(r=>r.json())
      .then(({rows})=>{
        const el = document.getElementById('table-${a.id}');
        el.innerHTML = '<table><thead><tr>\
          <th>Time</th><th>Game</th><th>Currency</th><th>Bet Amt</th><th>Multiplier</th><th>Payout</th><th>ID</th>\
        </tr></thead><tbody>' + rows.map(x => '<tr>\
          <td>'+ (x.updated_at || '') +'</td>\
          <td>'+ (x.game || '') +'</td>\
          <td>'+ (x.currency || '') +'</td>\
          <td>'+ (x.amount || 0) +'</td>\
          <td>'+ Math.round((x.payout_multiplier||0)*100)/100 +'×</td>\
          <td>'+ (x.payout || 0) +'</td>\
          <td style="font-family:monospace">'+ x.id +'</td>\
        </tr>').join('') + '</tbody></table>';
      })
      .catch(()=>{ document.getElementById('summary-${a.id}').innerText='Failed to load'; });
  `).join('')}
</script>
</body></html>`);
});

app.listen(PORT, () => console.log('listening on :' + PORT));
