// server.js
import express from "express";
import mongoose from "mongoose";
import helmet from "helmet";
import cors from "cors";
import morgan from "morgan";
import compression from "compression";
import rateLimit from "express-rate-limit";
import dotenv from "dotenv";

dotenv.config();

const {
  PORT = 8080,
  API_KEY = "supersecret",
  MONGO_URI,
  ALLOWED_ORIGINS = "*",
  COINGECKO_BASE = "https://api.coingecko.com/api/v3",
  PRICE_TTL_MS = "60000", // 60s default
} = process.env;

if (!MONGO_URI) {
  console.error("MONGO_URI is required");
  process.exit(1);
}

// -----------------------------
// Mongo
// -----------------------------
await mongoose.connect(MONGO_URI, { dbName: "staketracker" });
mongoose.connection.on("connected", () =>
  console.log("Mongo connected:", mongoose.connection.name)
);

// -----------------------------
// Schemas / Models
// -----------------------------
const AccountSchema = new mongoose.Schema(
  {
    id: { type: String, unique: true, index: true }, // Stake user id
    name: String,
  },
  { timestamps: { createdAt: "createdAt", updatedAt: "updatedAt" } }
);

const CashoutSchema = new mongoose.Schema(
  {
    id: { type: String, unique: true, index: true }, // cashout id
    accountId: { type: String, index: true },
    game: String,

    // originals in crypto (as sent by Stake preview)
    currency: String, // e.g. 'ltc'
    amount: Number, // CRYPTO amount
    payout: Number, // CRYPTO payout
    amountMultiplier: Number,
    payoutMultiplier: { type: Number, index: true },

    // optional USD values (preferred if present)
    amountUSD: Number,
    payoutUSD: Number,

    updatedAt: String,         // preview's updatedAt (string)
    capturedAt: { type: Date, default: Date.now, index: true },
    rawJson: Object,
  },
  { timestamps: false }
);

CashoutSchema.index({ accountId: 1, payoutMultiplier: -1 });
CashoutSchema.index({ capturedAt: -1 });

const Account = mongoose.model("Account", AccountSchema);
const Cashout = mongoose.model("Cashout", CashoutSchema);

// -----------------------------
// Helpers: pricing (CoinGecko)
// -----------------------------
const COINGECKO_IDS = {
  ltc: "litecoin",
  btc: "bitcoin",
  eth: "ethereum",
  doge: "dogecoin",
  bch: "bitcoin-cash",
  xrp: "ripple",
  usdt: "tether",
  usdc: "usd-coin",
};

const priceCache = new Map(); // key: symbol (lower), val: { price, ts }

async function getUsdRate(symbol) {
  if (!symbol) return null;
  const sym = String(symbol).toLowerCase();
  const id = COINGECKO_IDS[sym];
  if (!id) return null;

  const ttl = Number(PRICE_TTL_MS) || 60000;
  const now = Date.now();
  const cached = priceCache.get(sym);
  if (cached && now - cached.ts < ttl) return cached.price;

  try {
    const url = `${COINGECKO_BASE}/simple/price?ids=${encodeURIComponent(
      id
    )}&vs_currencies=usd`;
    const resp = await fetch(url, { headers: { "Accept": "application/json" } });
    if (!resp.ok) throw new Error(`coingecko ${resp.status}`);
    const data = await resp.json();
    const price = data?.[id]?.usd;
    if (typeof price === "number") {
      priceCache.set(sym, { price, ts: now });
      return price;
    }
  } catch (e) {
    console.warn("[price] fetch failed:", e.message);
  }
  return null;
}

// Normalize a single cashout document for RESPONSE:
// - Preserve originals as amountCrypto/payoutCrypto
// - Put USD into .amount / .payout (what the frontend expects)
async function normalizeCashoutToUSD(doc) {
  if (!doc) return doc;
  const out = { ...doc };

  out.amountCrypto = Number(out.amount || 0);
  out.payoutCrypto = Number(out.payout || 0);

  let amountUSD =
    typeof out.amountUSD === "number" ? out.amountUSD : undefined;
  let payoutUSD =
    typeof out.payoutUSD === "number" ? out.payoutUSD : undefined;

  if (amountUSD === undefined || payoutUSD === undefined) {
    const r = await getUsdRate(out.currency);
    if (typeof r === "number") {
      if (amountUSD === undefined) amountUSD = out.amountCrypto * r;
      if (payoutUSD === undefined) payoutUSD = out.payoutCrypto * r;
    } else {
      amountUSD ??= 0;
      payoutUSD ??= 0;
    }
  }

  out.amount = amountUSD; // USD in the fields the frontend reads
  out.payout = payoutUSD; // USD in the fields the frontend reads

  return out;
}

// -----------------------------
// App
// -----------------------------
const app = express();

// Let Express respect X-Forwarded-* (Render/Heroku/CF/CDN)
// Also silences express-rate-limit trust proxy warning.
app.set("trust proxy", true);

// Security & perf
app.use(helmet());
app.use(compression());
app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin || ALLOWED_ORIGINS === "*") return cb(null, true);
      const allowed = ALLOWED_ORIGINS.split(",").map((s) => s.trim());
      return cb(null, allowed.includes(origin));
    },
    credentials: false,
  })
);
app.use(express.json({ limit: "1mb" }));
app.use(morgan("tiny"));

// Rate limiting (120 req / 60s per IP)
app.use(
  "/api/",
  rateLimit({
    windowMs: 60 * 1000,
    max: 120,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req, _res) => req.ip || "global",
    skipFailedRequests: false,
    skipSuccessfulRequests: false,
  })
);

// Health + root
app.get("/", (_req, res) => res.json({ ok: true, service: "stake-tracker-api" }));
app.get("/health", (_req, res) => res.json({ ok: true }));

// API key guard
app.use("/api", (req, res, next) => {
  const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (token === API_KEY) return next();
  return res.status(401).json({ error: "Unauthorized" });
});

// -----------------------------
// Routes
// -----------------------------

// Ingest (preferred): { minesCashout, user }
// If userscript sent amountUSD/payoutUSD, we persist them.
// If not provided, they'll be backfilled on read via CoinGecko.
app.post("/api/cashouts", async (req, res) => {
  try {
    const { minesCashout, user } = req.body || {};
    if (!minesCashout?.id || !user?.id) {
      return res.status(400).json({ error: "missing minesCashout.id or user.id" });
    }

    // Upsert account
    await Account.updateOne(
      { id: user.id },
      { $set: { name: user.name ?? null } },
      { upsert: true }
    );

    // Upsert cashout
    await Cashout.updateOne(
      { id: minesCashout.id },
      {
        $setOnInsert: { id: minesCashout.id },
        $set: {
          accountId: user.id,
          game: minesCashout.game?.toLowerCase() ?? null,
          currency: minesCashout.currency?.toLowerCase() ?? null,

          // store crypto
          payout: Number(minesCashout.payout || 0),
          amount: Number(minesCashout.amount || 0),
          payoutMultiplier: Number(minesCashout.payoutMultiplier || 0),
          amountMultiplier: Number(minesCashout.amountMultiplier || 0),

          // optional USD from client
          payoutUSD:
            typeof minesCashout.payoutUSD === "number"
              ? minesCashout.payoutUSD
              : undefined,
          amountUSD:
            typeof minesCashout.amountUSD === "number"
              ? minesCashout.amountUSD
              : undefined,

          updatedAt: minesCashout.updatedAt ?? null,
          rawJson: req.body,
          capturedAt: new Date(),
        },
      },
      { upsert: true }
    );

    return res.json({ ok: true });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "server" });
  }
});

// Compat: flattened payloads at /api/cashout
app.post("/api/cashout", async (req, res) => {
  try {
    const b = req.body || {};

    const flat = {
      id: b.id || b.cashoutId || b?.preview?.id,
      accountId: b.accountId || b?.user?.id || b?.preview?.user?.id,
      accountName: b.accountName || b?.user?.name || b?.preview?.user?.name,
      game: (b.game || b?.preview?.game || "mines")?.toLowerCase(),
      currency: (b.currency || b?.preview?.currency || "").toLowerCase(),

      payout: Number(b.payout ?? b?.preview?.payout ?? 0), // crypto
      payoutMultiplier: Number(b.payoutMultiplier ?? b?.preview?.payoutMultiplier ?? 0),
      amount: Number(b.amount ?? b?.preview?.amount ?? 0), // crypto
      amountMultiplier: Number(b.amountMultiplier ?? b?.preview?.amountMultiplier ?? 0),
      updatedAt: b.updatedAt || b?.preview?.updatedAt || null,

      // accept client-provided USD if present
      payoutUSD: typeof b.payoutUSD === "number" ? b.payoutUSD : undefined,
      amountUSD: typeof b.amountUSD === "number" ? b.amountUSD : undefined,

      rawJson: b,
    };

    if (!flat.id || !flat.accountId) {
      return res.status(400).json({ error: "missing id or accountId" });
    }

    await Account.updateOne(
      { id: flat.accountId },
      { $set: { name: flat.accountName ?? null } },
      { upsert: true }
    );

    await Cashout.updateOne(
      { id: flat.id },
      {
        $setOnInsert: { id: flat.id },
        $set: {
          accountId: flat.accountId,
          game: flat.game,
          currency: flat.currency,
          payout: flat.payout, // crypto
          payoutMultiplier: flat.payoutMultiplier,
          amount: flat.amount, // crypto
          amountMultiplier: flat.amountMultiplier,
          updatedAt: flat.updatedAt,
          payoutUSD: flat.payoutUSD,
          amountUSD: flat.amountUSD,
          rawJson: flat.rawJson,
          capturedAt: new Date(),
        },
      },
      { upsert: true }
    );

    return res.json({ ok: true, id: flat.id });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "server" });
  }
});

// List accounts
app.get("/api/accounts", async (_req, res) => {
  const accounts = await Account.find().sort({ createdAt: -1 }).lean();
  return res.json(accounts);
});

// Account summary (top3 + totals) — USD in the fields the frontend expects
app.get("/api/accounts/:id/summary", async (req, res) => {
  const id = req.params.id;

  // Top 3 by multiplier
  let top3 = await Cashout.find({ accountId: id })
    .sort({ payoutMultiplier: -1 })
    .limit(3)
    .lean();

  top3 = await Promise.all(top3.map(normalizeCashoutToUSD));

  // Aggregate totals (prefer stored USD; fallback to rate if missing)
  const [t] = await Cashout.aggregate([
    { $match: { accountId: id } },
    {
      $group: {
        _id: null,
        totalBets: { $sum: 1 },
        maxMult: { $max: "$payoutMultiplier" },
        totalPayoutUSD: { $sum: "$payoutUSD" }, // may be NaN if undefined -> $sum treats as 0
        totalAmountUSD: { $sum: "$amountUSD" },
        totalPayoutCrypto: { $sum: "$payout" },
        totalAmountCrypto: { $sum: "$amount" },
        lastCurrency: { $last: "$currency" },
      },
    },
  ]);

  let totals = {
    totalBets: t?.totalBets || 0,
    maxMult: t?.maxMult || 0,
    totalPayout: t?.totalPayoutUSD || 0, // this key must be USD for the frontend
    totalAmountUSD: t?.totalAmountUSD || 0,
  };

  // If USD wasn’t stored, backfill using a live rate
  if (!t || totals.totalPayout === 0 || totals.totalAmountUSD === 0) {
    const r = await getUsdRate(t?.lastCurrency || "ltc");
    if (typeof r === "number") {
      if (totals.totalAmountUSD === 0)
        totals.totalAmountUSD = (t?.totalAmountCrypto || 0) * r;
      if (totals.totalPayout === 0)
        totals.totalPayout = (t?.totalPayoutCrypto || 0) * r;
    }
  }

  // Tidy rounding for display
  totals.totalPayout = Math.round(totals.totalPayout * 100) / 100;
  totals.totalAmountUSD = Math.round(totals.totalAmountUSD * 100) / 100;

  return res.json({ top3, totals });
});

// Paginated cashouts — USD in amount/payout fields
app.get("/api/accounts/:id/cashouts", async (req, res) => {
  const id = req.params.id;
  const page = Math.max(1, parseInt(req.query.page ?? "1", 10));
  const size = Math.min(200, Math.max(1, parseInt(req.query.size ?? "50", 10)));
  const skip = (page - 1) * size;

  const [rowsRaw, total] = await Promise.all([
    Cashout.find({ accountId: id })
      .sort({ capturedAt: -1 })
      .skip(skip)
      .limit(size)
      .lean(),
    Cashout.countDocuments({ accountId: id }),
  ]);

  const rows = await Promise.all(rowsRaw.map(normalizeCashoutToUSD));

  return res.json({ page, size, total, rows });
});

// Global leaderboard (top multipliers across all accounts)
app.get("/api/leaderboard", async (req, res) => {
  const size = Math.min(50, Math.max(1, parseInt(req.query.size ?? "10", 10)));
  const rowsRaw = await Cashout.find({ payoutMultiplier: { $gt: 0 } })
    .sort({ payoutMultiplier: -1 })
    .limit(size)
    .lean();

  const rows = await Promise.all(rowsRaw.map(normalizeCashoutToUSD));

  // attach names
  const ids = [...new Set(rows.map((r) => r.accountId))];
  const accs = await Account.find({ id: { $in: ids } }).lean();
  const nameById = Object.fromEntries(accs.map((a) => [a.id, a.name || a.id]));

  return res.json(
    rows.map((r) => ({
      ...r,
      accountName: nameById[r.accountId] ?? r.accountId,
    }))
  );
});

// -----------------------------
// Start
// -----------------------------
app.listen(PORT, () => console.log("listening on :" + PORT));
