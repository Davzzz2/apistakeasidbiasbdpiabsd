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
  API_KEY = "change-me",
  MONGO_URI,
  ALLOWED_ORIGINS = "*",
} = process.env;

if (!MONGO_URI) {
  console.error("MONGO_URI is required");
  process.exit(1);
}

// --- Mongo ---
await mongoose.connect(MONGO_URI, {
  dbName: "staketracker",
});
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
    payout: Number,
    payoutMultiplier: { type: Number, index: true },
    amount: Number,
    amountMultiplier: Number,
    updatedAt: String, // preview's updatedAt
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

// --- Routes ---

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

// Account summary (top3 + totals)
app.get("/api/accounts/:id/summary", async (req, res) => {
  const id = req.params.id;
  const top3 = await Cashout.find({ accountId: id })
    .sort({ payoutMultiplier: -1 })
    .limit(3)
    .lean();

  const [totals] = await Cashout.aggregate([
    { $match: { accountId: id } },
    {
      $group: {
        _id: null,
        totalBets: { $sum: 1 },
        maxMult: { $max: "$payoutMultiplier" },
        totalPayout: { $sum: "$payout" },
      },
    },
  ]);

  return res.json({ top3, totals: totals || { totalBets: 0, maxMult: 0, totalPayout: 0 } });
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

app.listen(PORT, () => console.log("listening on :" + PORT));
