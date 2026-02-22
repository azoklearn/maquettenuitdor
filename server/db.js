if (process.env.VERCEL) {
  module.exports = require('./db-vercel');
  return;
}

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const defaultPath = process.env.VERCEL
  ? path.join('/tmp', 'nuitdor.db')
  : path.join(__dirname, '..', 'data', 'nuitdor.db');
const dbPath = process.env.SQLITE_PATH || defaultPath;

function getDb() {
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch (e) {
      console.error('DB mkdir failed:', e.message);
    }
  }
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  return db;
}

function initDb() {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS bookings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date_arrivee TEXT NOT NULL,
      date_depart TEXT NOT NULL,
      pack TEXT NOT NULL,
      nom TEXT NOT NULL,
      email TEXT NOT NULL,
      telephone TEXT,
      message TEXT,
      amount_cents INTEGER NOT NULL,
      stripe_session_id TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);
  db.close();
}

function getBookedDates() {
  const db = getDb();
  const rows = db.prepare(`
    SELECT date_arrivee, date_depart
    FROM bookings
    WHERE status = 'paid'
  `).all();
  db.close();

  const dates = new Set();
  for (const row of rows) {
    const start = new Date(row.date_arrivee);
    const end = new Date(row.date_depart);
    for (let d = new Date(start); d < end; d.setDate(d.getDate() + 1)) {
      dates.add(d.toISOString().slice(0, 10));
    }
  }
  return Array.from(dates);
}

function createBooking(data) {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO bookings (date_arrivee, date_depart, pack, nom, email, telephone, message, amount_cents, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')
  `);
  const info = stmt.run(
    data.date_arrivee,
    data.date_depart,
    data.pack || 'aucun',
    data.nom,
    data.email,
    data.telephone || null,
    data.message || null,
    data.amount_cents
  );
  db.close();
  return info.lastInsertRowid;
}

function setBookingPaid(bookingId, stripeSessionId) {
  const db = getDb();
  db.prepare(`
    UPDATE bookings SET status = 'paid', stripe_session_id = ? WHERE id = ?
  `).run(stripeSessionId, bookingId);
  db.close();
}

function getBookingById(id) {
  const db = getDb();
  const row = db.prepare('SELECT * FROM bookings WHERE id = ?').get(id);
  db.close();
  return row;
}

module.exports = {
  initDb,
  getBookedDates,
  createBooking,
  setBookingPaid,
  getBookingById
};
