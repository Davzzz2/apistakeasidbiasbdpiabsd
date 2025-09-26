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
} = process.env;

if (!MONGO_URI) {
  console.error("MONGO_URI is required");
  process.exit(1);
}

// --- Mongo ---
await mongoose.connect(MONGO_URI, { dbName: "staketracker" });
mongoose.connection.on("connected", () =>
  console.log("Mongo connected:", mongoose.connection.name)
);

// --- Schemas ---
const AccountSchema = new mongoose.Schema(
  {
    id: { type: String, unique: true, index: true }, // Stake user id
    name: String,
  },
  { timestamps: { createdAt: "createdAt", updatedAt: "updatedAt" } }
);

const CashoutSchema = new mongoose.Schema(
  {
    id: { type: String, unique: true, index: true }, // cashout id (preview)
    accountId: { type: String, index: true },
    game: String,
    currency: String,

    // crypto amounts
    payout: Number,
    payoutMultiplier: { type: Number, index: true },
    amount: Number,
    amountMultiplier: Number,

    // USD amounts (optional; client or server can populate)
    amountUSD: Number,
    payoutUSD: Number,

    updatedAt: String,
    capturedAt: { type: Date, default: Date.now, index: true },
    rawJson: Object,
  },
  { timestamps: false }
);

CashoutSchema.index({ accountId: 1, payoutMultiplier: -1 });
CashoutSchema.index({ capturedAt: -1 });

const Account = mongoose.model("Account", AccountSchema);
const Cashout = mongoose.model("Cashout", CashoutSchema);

// --- App ---
const app = express();

// IMPORTANT: behind Render/Cloudflare proxy
// 1 means "trust first proxy"; use `true` to trust all if you prefer.
app.set("trust proxy", 1);

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

// Basic rate limiting on API
app.use(
  "/api/",
  rateLimit({
    windowMs: 60 * 1000,
    max: 120,
    standardHeaders: true,
    legacyHeaders: false,
    // Optional explicit key (uses req.ip which respects trust proxy now)
    keyGenerator: (req) => req.ip,
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

// ---------------- USD helper (server-side backfill) ----------------
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

const priceCache = new Map(); // key = 'ltc', value = { usd, ts }
const PRICE_TTL_MS = 60_000;

async function getUsdRate(symLower) {
  try {
    const key = String(symLower || "").toLowerCase();
    const id = COINGECKO_IDS[key];
    if (!id) return null;

    const now = Date.now();
    const cached = priceCache.get(key);
    if (cached && now - cached.ts < PRICE_TTL_MS) return cached.usd;

    const url = `https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(
      id
    )}&vs_currencies=usd`;
    const r = await fetch(url, { headers: { "accept": "application/json" } });
    if (!r.ok) return null;
    const j = await r.json();
    const usd = (j && j[id] && typeof j[id].usd === "number") ? j[id].usd : null;
    if (typeof usd === "number") {
      priceCache.set(key, { usd, ts: now });
      return usd;
    }
    return null;
  } catch {
    return null;
  }
}

async function attachUsdIfMissing(doc) {
  // Leaves existing USD fields intact; fills them if absent
  if (!doc) return doc;
  if (typeof doc.amountUSD === "number" && typeof doc.payoutUSD === "number") {
    return doc;
  }
  const rate = await getUsdRate(doc.currency);
  if (typeof rate === "number") {
    if (typeof doc.amountUSD !== "number")
      doc.amountUSD = Number(doc.amount || 0) * rate;
    if (typeof doc.payoutUSD !== "number")
      doc.payoutUSD = Number(doc.payout || 0) * rate;
  } else {
    if (typeof doc.amountUSD !== "number") doc.amountUSD = 0;
    if (typeof doc.payoutUSD !== "number") doc.payoutUSD = 0;
  }
  return doc;
}

// ---------------- Routes ----------------

// Ingest a cashout payload: { minesCashout, user }
app.post("/api/cashouts", async (req, res) => {
  try {
    const { minesCashout, user } = req.body || {};
    if (!minesCashout?.id || !user?.id) {
      return res.status(400).json({ error: "missing minesCashout.id or user.id" });
    }

    await Account.updateOne(
      { id: user.id },
      { $set: { name: user.name ?? null } },
      { upsert: true }
    );

    await Cashout.updateOne(
      { id: minesCashout.id },
      {
        $setOnInsert: { id: minesCashout.id },
        $set: {
          accountId: user.id,
          game: minesCashout.game?.toLowerCase() ?? null,
          currency: minesCashout.currency?.toLowerCase() ?? null,
          payout: Number(minesCashout.payout || 0),
          payoutMultiplier: Number(minesCashout.payoutMultiplier || 0),
          amount: Number(minesCashout.amount || 0),
          amountMultiplier: Number(minesCashout.amountMultiplier || 0),

          // USD fields from client (if provided)
          amountUSD: Number(minesCashout.amountUSD ?? 0),
          payoutUSD: Number(minesCashout.payoutUSD ?? 0),

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

// List accounts
app.get("/api/accounts", async (_req, res) => {
  const accounts = await Account.find().sort({ createdAt: -1 }).lean();
  return res.json(accounts);
});

// Account summary (top3 + totals) with USD backfill
app.get("/api/accounts/:id/summary", async (req, res) => {
  const id = req.params.id;

  // Get top3 by multiplier
  let top3 = await Cashout.find({ accountId: id })
    .sort({ payoutMultiplier: -1 })
    .limit(3)
    .lean();

  // Backfill USD in the returned docs if missing
  await Promise.all(top3.map(async (doc, i) => {
    top3[i] = await attachUsdIfMissing(doc);
  }));

  // Totals (crypto + USD)
  const [totalsRaw] = await Cashout.aggregate([
    { $match: { accountId: id } },
    {
      $group: {
        _id: null,
        totalBets: { $sum: 1 },
        maxMult: { $max: "$payoutMultiplier" },
        totalPayout: { $sum: "$payout" },
        totalPayoutUSD: { $sum: "$payoutUSD" },
        totalAmountUSD: { $sum: "$amountUSD" },
      },
    },
  ]);

  // If DB lacks USD in old rows, totals might be low — do a cheap backfill estimate
  let totals = totalsRaw || {
    totalBets: 0,
    maxMult: 0,
    totalPayout: 0,
    totalPayoutUSD: 0,
    totalAmountUSD: 0,
  };

  if (!totalsRaw || totals.totalPayoutUSD === 0 || totals.totalAmountUSD === 0) {
    // Try to estimate totalsUSD from the most recent rate
    const latest = await Cashout.findOne({ accountId: id })
      .sort({ capturedAt: -1 })
      .lean();
    if (latest?.currency) {
      const r = await getUsdRate(latest.currency);
      if (typeof r === "number") {
        if (!totalsRaw || totals.totalAmountUSD === 0) {
          const sumAmt = await Cashout.aggregate([
            { $match: { accountId: id } },
            { $group: { _id: null, s: { $sum: "$amount" } } },
          ]);
          const sAmt = (sumAmt[0]?.s ?? 0) * r;
          totals.totalAmountUSD = Math.round(sAmt * 100) / 100;
        }
        if (!totalsRaw || totals.totalPayoutUSD === 0) {
          const sumPay = await Cashout.aggregate([
            { $match: { accountId: id } },
            { $group: { _id: null, s: { $sum: "$payout" } } },
          ]);
          const sPay = (sumPay[0]?.s ?? 0) * r;
          totals.totalPayoutUSD = Math.round(sPay * 100) / 100;
        }
      }
    }
  }

  return res.json({ top3, totals });
});

// Paginated cashouts
app.get("/api/accounts/:id/cashouts", async (req, res) => {
  const id = req.params.id;
  const page = Math.max(1, parseInt(req.query.page ?? "1", 10));
  const size = Math.min(200, Math.max(1, parseInt(req.query.size ?? "50", 10)));
  const skip = (page - 1) * size;

  const [rows, total] = await Promise.all([
    Cashout.find({ accountId: id })
      .sort({ capturedAt: -1 })
      .skip(skip)
      .limit(size)
      .lean(),
    Cashout.countDocuments({ accountId: id }),
  ]);

  return res.json({ page, size, total, rows });
});

// Global leaderboard (top N multipliers across all accounts)
app.get("/api/leaderboard", async (req, res) => {
  const size = Math.min(50, Math.max(1, parseInt(req.query.size ?? "10", 10)));
  const rows = await Cashout.find({ payoutMultiplier: { $gt: 0 } })
    .sort({ payoutMultiplier: -1 })
    .limit(size)
    .lean();

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

// Compat: flattened payloads
app.post("/api/cashout", async (req, res) => {
  try {
    const b = req.body || {};

    const flat = {
      id: b.id || b.cashoutId || b?.preview?.id,
      accountId: b.accountId || b?.user?.id || b?.preview?.user?.id,
      accountName: b.accountName || b?.user?.name || b?.preview?.user?.name,
      game: (b.game || b?.preview?.game || "mines")?.toLowerCase(),
      currency: (b.currency || b?.preview?.currency || "").toLowerCase(),
      payout: Number(b.payout ?? b?.preview?.payout ?? 0),
      payoutMultiplier: Number(b.payoutMultiplier ?? b?.preview?.payoutMultiplier ?? 0),
      amount: Number(b.amount ?? b?.preview?.amount ?? 0),
      amountMultiplier: Number(b.amountMultiplier ?? b?.preview?.amountMultiplier ?? 0),

      amountUSD: Number(b.amountUSD ?? b?.preview?.amountUSD ?? 0),
      payoutUSD: Number(b.payoutUSD ?? b?.preview?.payoutUSD ?? 0),

      updatedAt: b.updatedAt || b?.preview?.updatedAt || null,
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
          payout: flat.payout,
          payoutMultiplier: flat.payoutMultiplier,
          amount: flat.amount,
          amountMultiplier: flat.amountMultiplier,
          amountUSD: flat.amountUSD,
          payoutUSD: flat.payoutUSD,
          updatedAt: flat.updatedAt,
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

app.listen(PORT, () => console.log("listening on :" + PORT));
