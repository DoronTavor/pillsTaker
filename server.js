require('dotenv').config();
const express = require('express');
const Database = require('better-sqlite3');
const cron = require('node-cron');
const twilio = require('twilio');
const path = require('path');

const app = express();
const dbPath = process.env.DB_PATH || 'pills.db';
const db = new Database(dbPath);

// ─── DB Setup ────────────────────────────────────────────────────────────────

db.exec(`
  CREATE TABLE IF NOT EXISTS pickups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pill_name TEXT NOT NULL,
    pickup_date TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sms_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pill_name TEXT NOT NULL,
    trigger_date TEXT NOT NULL,
    sent_at TEXT DEFAULT (datetime('now'))
  );
`);

// Default settings
const DEFAULT_SETTINGS = { phone_number: '', notify_days_before: '3' };
for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
  db.prepare(`INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)`).run(key, value);
}

// ─── Constants ───────────────────────────────────────────────────────────────

const PILL_INTERVALS = {
  Metadex:  30,
  Seroquel: 90,
  Viapax:   90,
  Clonex:   90
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getSetting(key) {
  return db.prepare(`SELECT value FROM settings WHERE key = ?`).get(key)?.value;
}

function getNextPickup(pillName) {
  const latest = db.prepare(
    `SELECT pickup_date FROM pickups WHERE pill_name = ? ORDER BY pickup_date DESC LIMIT 1`
  ).get(pillName);
  if (!latest) return null;
  const d = new Date(latest.pickup_date);
  d.setDate(d.getDate() + PILL_INTERVALS[pillName]);
  return d.toISOString().split('T')[0];
}

function getStatus() {
  const result = {};
  for (const pill of Object.keys(PILL_INTERVALS)) {
    const latest = db.prepare(
      `SELECT pickup_date FROM pickups WHERE pill_name = ? ORDER BY pickup_date DESC LIMIT 1`
    ).get(pill);
    if (latest) {
      const next = getNextPickup(pill);
      result[pill] = { lastPickup: latest.pickup_date, nextPickup: next, intervalDays: PILL_INTERVALS[pill] };
    } else {
      result[pill] = { lastPickup: null, nextPickup: null, intervalDays: PILL_INTERVALS[pill] };
    }
  }
  return result;
}

// ─── SMS ─────────────────────────────────────────────────────────────────────

function getTwilioClient() {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!sid || sid.startsWith('ACxx') || !token || token.startsWith('xxxx')) return null;
  return twilio(sid, token);
}

async function sendSms(to, body) {
  const client = getTwilioClient();
  if (!client) throw new Error('Twilio credentials not configured in .env');
  await client.messages.create({ from: process.env.TWILIO_FROM_NUMBER, to, body });
}

async function checkAndNotify() {
  const phone = getSetting('phone_number');
  if (!phone) return { skipped: 'No phone number configured' };

  const notifyDays = parseInt(getSetting('notify_days_before') || '3', 10);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayStr = today.toISOString().split('T')[0];

  const results = [];

  for (const pill of Object.keys(PILL_INTERVALS)) {
    const nextPickup = getNextPickup(pill);
    if (!nextPickup) continue;

    const nextDate = new Date(nextPickup);
    const daysLeft = Math.round((nextDate - today) / 86400000);

    // Notify on the day itself (daysLeft === 0) or N days before
    if (daysLeft !== 0 && daysLeft !== notifyDays) continue;

    // Deduplicate: don't send same pill notification twice today
    const alreadySent = db.prepare(
      `SELECT id FROM sms_log WHERE pill_name = ? AND trigger_date = ?`
    ).get(pill, todayStr);
    if (alreadySent) { results.push({ pill, status: 'already_sent' }); continue; }

    let msg;
    if (daysLeft === 0) {
      msg = `💊 Pills Tracker: Today is the day to pick up ${pill} from the pharmacy!`;
    } else {
      msg = `💊 Pills Tracker: Reminder — pick up ${pill} from the pharmacy in ${daysLeft} day${daysLeft !== 1 ? 's' : ''} (${nextPickup}).`;
    }

    try {
      await sendSms(phone, msg);
      db.prepare(`INSERT INTO sms_log (pill_name, trigger_date) VALUES (?, ?)`).run(pill, todayStr);
      results.push({ pill, status: 'sent', daysLeft });
    } catch (err) {
      results.push({ pill, status: 'error', error: err.message });
    }
  }

  return results;
}

// ─── Cron — runs every day at 09:00 ──────────────────────────────────────────

cron.schedule('0 9 * * *', async () => {
  console.log(`[${new Date().toISOString()}] Running daily SMS check...`);
  const results = await checkAndNotify();
  console.log('SMS check results:', JSON.stringify(results));
});

// ─── Routes ──────────────────────────────────────────────────────────────────

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Status
app.get('/api/status', (_req, res) => res.json(getStatus()));

// Settings
app.get('/api/settings', (_req, res) => {
  const rows = db.prepare(`SELECT key, value FROM settings`).all();
  const settings = Object.fromEntries(rows.map(r => [r.key, r.value]));
  settings.twilio_configured = getTwilioClient() !== null;
  res.json(settings);
});

app.post('/api/settings', (req, res) => {
  const { phone_number, notify_days_before } = req.body;
  if (phone_number !== undefined) {
    db.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES ('phone_number', ?)`).run(phone_number);
  }
  if (notify_days_before !== undefined) {
    const days = Math.max(1, Math.min(30, parseInt(notify_days_before, 10)));
    db.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES ('notify_days_before', ?)`).run(String(days));
  }
  res.json({ success: true });
});

// Pickup history
app.get('/api/history/:pill', (req, res) => {
  const { pill } = req.params;
  if (!PILL_INTERVALS[pill]) return res.status(400).json({ error: 'Unknown pill' });
  const rows = db.prepare(
    `SELECT id, pickup_date FROM pickups WHERE pill_name = ? ORDER BY pickup_date DESC LIMIT 20`
  ).all(pill);
  res.json(rows);
});

// Record pickup
app.post('/api/pickup', (req, res) => {
  const { pill, date } = req.body;
  if (!PILL_INTERVALS[pill]) return res.status(400).json({ error: 'Unknown pill' });
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'Invalid date format' });
  const existing = db.prepare(`SELECT id FROM pickups WHERE pill_name = ? AND pickup_date = ?`).get(pill, date);
  if (existing) return res.status(409).json({ error: 'Pickup already recorded for this date' });
  db.prepare(`INSERT INTO pickups (pill_name, pickup_date) VALUES (?, ?)`).run(pill, date);
  res.json({ success: true });
});

// Delete pickup
app.delete('/api/pickup/:id', (req, res) => {
  db.prepare(`DELETE FROM pickups WHERE id = ?`).run(req.params.id);
  res.json({ success: true });
});

// SMS send log
app.get('/api/sms-log', (_req, res) => {
  const rows = db.prepare(
    `SELECT pill_name, trigger_date, sent_at FROM sms_log ORDER BY sent_at DESC LIMIT 50`
  ).all();
  res.json(rows);
});

// Manual SMS check / test
app.post('/api/notify/run', async (_req, res) => {
  try {
    const results = await checkAndNotify();
    res.json({ success: true, results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Send a test SMS
app.post('/api/notify/test', async (req, res) => {
  const phone = getSetting('phone_number');
  if (!phone) return res.status(400).json({ error: 'No phone number configured' });
  try {
    await sendSms(phone, '💊 Pills Tracker: Test message — your SMS notifications are working!');
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Start ───────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Pills Tracker running at http://localhost:${PORT}`);
  console.log(`Daily SMS check scheduled at 09:00 every day`);
});
