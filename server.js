// server.js
const express = require('express');
const mongoose = require('mongoose');
const helmet = require('helmet');
const cors = require('cors');
const morgan = require('morgan');

const PORT = process.env.PORT;
const API_KEY = process.env.API_KEY;
const MONGO_URI = process.env.MONGO_URI;

mongoose.connect(MONGO_URI, { useNewUrlParser: true, useUnifiedTopology: true });

const accountSchema = new mongoose.Schema({
  id: { type: String, unique: true },
  name: String,
  createdAt: { type: Date, default: Date.now }
});

const cashoutSchema = new mongoose.Schema({
  id: { type: String, unique: true },
  accountId: String,
  game: String,
  currency: String,
  payout: Number,
  payoutMultiplier: Number,
  amount: Number,
  amountMultiplier: Number,
  updatedAt: String,
  capturedAt: { type: Date, default: Date.now },
  rawJson: Object
});

const Account = mongoose.model('Account', accountSchema);
const Cashout = mongoose.model('Cashout', cashoutSchema);

const app = express();
app.use(express.json());
app.use(cors());
app.use(helmet());
app.use(morgan('tiny'));

// Auth middleware
app.use('/api', (req, res, next) => {
  const token = (req.headers['authorization'] || '').replace(/^Bearer /i, '');
  if (token === API_KEY) return next();
  res.status(401).json({ error: 'Unauthorized' });
});

// Ingest cashout
app.post('/api/cashouts', async (req, res) => {
  try {
    const { minesCashout, user } = req.body;
    if (!minesCashout?.id || !user?.id) return res.status(400).json({ error: 'bad payload' });

    await Account.updateOne({ id: user.id }, { name: user.name }, { upsert: true });
    await Cashout.updateOne(
      { id: minesCashout.id },
      {
        accountId: user.id,
        game: minesCashout.game,
        currency: minesCashout.currency,
        payout: minesCashout.payout,
        payoutMultiplier: minesCashout.payoutMultiplier,
        amount: minesCashout.amount,
        amountMultiplier: minesCashout.amountMultiplier,
        updatedAt: minesCashout.updatedAt,
        rawJson: req.body
      },
      { upsert: true }
    );

    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'server error' });
  }
});

// Accounts
app.get('/api/accounts', async (_req, res) => {
  const accounts = await Account.find().sort({ createdAt: -1 });
  res.json(accounts);
});

// Account summary
app.get('/api/accounts/:id/summary', async (req, res) => {
  const id = req.params.id;
  const top3 = await Cashout.find({ accountId: id }).sort({ payoutMultiplier: -1 }).limit(3);
  const totals = await Cashout.aggregate([
    { $match: { accountId: id } },
    {
      $group: {
        _id: null,
        totalBets: { $sum: 1 },
        maxMult: { $max: '$payoutMultiplier' },
        totalPayout: { $sum: '$payout' }
      }
    }
  ]);
  res.json({ top3, totals: totals[0] || {} });
});

app.listen(PORT, () => console.log(`listening on :${PORT}`));
