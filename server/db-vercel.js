/**
 * Stockage en mémoire pour Vercel (pas de better-sqlite3 = pas de crash).
 * Les données ne persistent pas entre invocations serverless.
 */

const bookings = [];
const blockedDates = [];
let nextId = 1;

function getDb() {
  return null;
}

function initDb() {
  // rien à faire
}

function getBookedDates() {
  const dates = new Set();
  for (const row of bookings) {
    if (row.status !== 'paid' && row.status !== 'pending') continue;
    const start = new Date(row.date_arrivee);
    const end = new Date(row.date_depart);
    for (let d = new Date(start); d < end; d.setDate(d.getDate() + 1)) {
      dates.add(d.toISOString().slice(0, 10));
    }
  }
  return Array.from(dates);
}

function createBooking(data) {
  const id = nextId++;
  bookings.push({
    id,
    date_arrivee: data.date_arrivee,
    date_depart: data.date_depart,
    pack: data.pack || 'aucun',
    nom: data.nom,
    email: data.email,
    telephone: data.telephone || null,
    message: data.message || null,
    amount_cents: data.amount_cents,
    stripe_session_id: null,
    status: 'pending',
    created_at: new Date().toISOString()
  });
  return id;
}

function setBookingPaid(bookingId, stripeSessionId) {
  const b = bookings.find((x) => x.id === Number(bookingId));
  if (b) {
    b.status = 'paid';
    b.stripe_session_id = stripeSessionId;
  }
}

function getBookingById(id) {
  return bookings.find((x) => x.id === Number(id)) || null;
}

function getBlockedDates() {
  return blockedDates.slice().sort();
}

function addBlockedDate(date) {
  const d = String(date).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return false;
  if (blockedDates.includes(d)) return false;
  blockedDates.push(d);
  return true;
}

function removeBlockedDate(date) {
  const d = String(date).slice(0, 10);
  const i = blockedDates.indexOf(d);
  if (i === -1) return false;
  blockedDates.splice(i, 1);
  return true;
}

function getAllBookings() {
  return bookings
    .map((b) => ({
      id: b.id,
      date_arrivee: b.date_arrivee,
      date_depart: b.date_depart,
      pack: b.pack,
      nom: b.nom,
      email: b.email,
      telephone: b.telephone,
      amount_cents: b.amount_cents,
      status: b.status,
      created_at: b.created_at
    }))
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
}

function deleteBooking(id) {
  const i = bookings.findIndex((x) => x.id === Number(id));
  if (i === -1) return false;
  bookings.splice(i, 1);
  return true;
}

module.exports = {
  initDb,
  getBookedDates,
  getBlockedDates,
  addBlockedDate,
  removeBlockedDate,
  createBooking,
  setBookingPaid,
  getBookingById,
  getAllBookings,
  deleteBooking
};
