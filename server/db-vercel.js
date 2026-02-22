/**
 * Stockage en mémoire pour Vercel (pas de better-sqlite3 = pas de crash).
 * Les données ne persistent pas entre invocations serverless.
 */

const bookings = [];
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
    if (row.status !== 'paid') continue;
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

module.exports = {
  initDb,
  getBookedDates,
  createBooking,
  setBookingPaid,
  getBookingById
};
