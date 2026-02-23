require('dotenv').config();
const express = require('express');
const path = require('path');
const Stripe = require('stripe');
const db = require('./server/db');
const blockedStore = require('./server/blocked-dates-store');

const app = express();
const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;

const WEEK_PRICE = 155;      // nuit en semaine (lundi-jeudi, + dimanche)
const WEEKEND_PRICE = 205;   // nuit de week-end (vendredi-samedi)

const OPTION_PRICES = {
  petales: 30,
  bouquet: 50,
  champagne: 50,
  formule80: 80,
  arrivee15: 40,
  depart14: 40
};

function getNightPrice(date) {
  const day = date.getDay(); // 0=dimanche, 1=lundi, ..., 6=samedi
  if (day === 5 || day === 6) return WEEKEND_PRICE; // ven/sam
  return WEEK_PRICE;
}

function computeBaseAmountEuros(dateArrivee, dateDepart) {
  const start = new Date(dateArrivee);
  const end = new Date(dateDepart);
  if (isNaN(start) || isNaN(end)) return { nights: 0, base: 0 };
  let nights = 0;
  let total = 0;
  const cursor = new Date(start.getTime());
  cursor.setHours(0, 0, 0, 0);
  const limit = new Date(end.getTime());
  limit.setHours(0, 0, 0, 0);
  while (cursor < limit) {
    total += getNightPrice(cursor);
    nights += 1;
    cursor.setDate(cursor.getDate() + 1);
  }
  return { nights, base: total };
}

function computeOptionsEuros(optionKeys) {
  if (!Array.isArray(optionKeys)) return 0;
  return optionKeys.reduce((sum, key) => sum + (OPTION_PRICES[key] || 0), 0);
}

// En production (Vercel), utiliser BASE_URL ou l’URL du déploiement pour que Stripe redirige au bon endroit
const BASE_URL = process.env.BASE_URL ||
  (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : null) ||
  'http://localhost:3000';

function buildBookingForClient(booking) {
  if (!booking) return null;
  return {
    nom: booking.nom,
    date_arrivee: booking.date_arrivee,
    date_depart: booking.date_depart,
    options: typeof booking.pack === 'string' ? booking.pack : (booking.pack || ''),
    amount_cents: booking.amount_cents
  };
}

try {
  db.initDb();
} catch (e) {
  console.error('DB init error:', e.message);
}

// Fichiers statiques : public/ (toujours, pour que GET / fonctionne sur Vercel)
app.use(express.static(path.join(__dirname, 'public')));
if (!process.env.VERCEL) {
  app.use(express.static(path.join(__dirname)));
}

// Webhook Stripe : body brut pour signature
app.use('/api/webhook/stripe', express.raw({ type: 'application/json' }), (req, res) => {
  if (!stripe || !process.env.STRIPE_WEBHOOK_SECRET) {
    return res.status(500).send('Webhook non configuré');
  }
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    return res.status(400).send('Webhook signature invalide');
  }
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const bookingId = session.metadata && session.metadata.booking_id;
    if (bookingId) {
      db.setBookingPaid(Number(bookingId), session.id);
      let booking = db.getBookingById(Number(bookingId));
      if (!booking && session.metadata && session.metadata.email) {
        booking = {
          email: session.metadata.email,
          nom: session.metadata.nom || '',
          date_arrivee: session.metadata.date_arrivee || '',
          date_depart: session.metadata.date_depart || '',
          pack: session.metadata.options || '',
          amount_cents: Number(session.metadata.amount_cents) || session.amount_total || 0
        };
      }
    }
  }
  res.json({ received: true });
});

// Corps JSON pour les autres routes
app.use(express.json());

// Confirmer la résa et envoyer l'email après paiement (si webhook non utilisé, ex. en local)
app.get('/api/confirm-session', async (req, res) => {
  const sessionId = req.query.session_id;
  if (!sessionId || !stripe) {
    return res.status(400).json({ error: 'session_id manquant ou Stripe non configuré' });
  }
  try {
    const session = await stripe.checkout.sessions.retrieve(sessionId);
    if (session.payment_status !== 'paid') {
      return res.status(400).json({ error: 'Paiement non reçu' });
    }
    const bookingId = session.metadata && session.metadata.booking_id;
    if (!bookingId) return res.status(400).json({ error: 'Réservation introuvable' });
    let booking = db.getBookingById(Number(bookingId));
    if (!booking && session.metadata && session.metadata.email) {
      booking = {
        email: session.metadata.email,
        nom: session.metadata.nom || '',
        date_arrivee: session.metadata.date_arrivee || '',
        date_depart: session.metadata.date_depart || '',
        pack: session.metadata.options || '',
        amount_cents: Number(session.metadata.amount_cents) || session.amount_total || 0
      };
    }
    if (!booking) return res.status(404).json({ error: 'Réservation introuvable' });
    const clientBooking = buildBookingForClient(booking);
    if (booking.status === 'paid') {
      return res.json({ ok: true, already: true, booking: clientBooking });
    }
    db.setBookingPaid(Number(bookingId), sessionId);
    const updated = db.getBookingById(Number(bookingId)) || booking;
    res.json({ ok: true, booking: buildBookingForClient(updated) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur lors de la confirmation' });
  }
});

// Créneaux déjà réservés + dates bloquées (à désactiver dans le calendrier)
app.get('/api/booked-dates', async (req, res) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  try {
    const fromBookings = db.getBookedDates();
    const fromBlocked = blockedStore.useRedis()
      ? await blockedStore.getBlockedDatesFromStore()
      : (db.getBlockedDates ? db.getBlockedDates() : []);
    const dates = [...new Set([...fromBookings, ...fromBlocked])];
    res.json({ dates });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ——— Admin : liste et suppression de réservations (créneaux)
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';

function requireAdmin(req, res, next) {
  if (!ADMIN_PASSWORD) {
    return res.status(503).json({ error: 'Admin non configuré (ADMIN_PASSWORD)' });
  }
  const token = req.headers['x-admin-password'] || req.body?.adminPassword || req.query?.adminPassword;
  if (token !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Accès refusé' });
  }
  next();
}

app.get('/api/admin/bookings', requireAdmin, (req, res) => {
  try {
    const bookings = db.getAllBookings();
    res.json({ bookings });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

app.delete('/api/admin/bookings/:id', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ error: 'ID invalide' });
  try {
    const deleted = db.deleteBooking(id);
    if (!deleted) return res.status(404).json({ error: 'Réservation introuvable' });
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Admin : dates bloquées (indisponibles au calendrier)
app.get('/api/admin/blocked-dates', requireAdmin, async (req, res) => {
  try {
    const dates = blockedStore.useRedis()
      ? await blockedStore.getBlockedDatesFromStore()
      : (db.getBlockedDates ? db.getBlockedDates() : []);
    res.json({ dates });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

app.post('/api/admin/blocked-dates', requireAdmin, async (req, res) => {
  const date = req.body && req.body.date;
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(String(date).slice(0, 10))) {
    return res.status(400).json({ error: 'Date invalide (format YYYY-MM-DD)' });
  }
  const normalized = String(date).slice(0, 10);
  try {
    const added = blockedStore.useRedis()
      ? await blockedStore.addBlockedDateToStore(normalized)
      : (db.addBlockedDate && db.addBlockedDate(normalized));
    if (!added) return res.status(409).json({ error: 'Date déjà bloquée' });
    res.json({ ok: true, date: normalized });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

app.delete('/api/admin/blocked-dates/:date', requireAdmin, async (req, res) => {
  const date = req.params.date;
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(String(date).slice(0, 10))) {
    return res.status(400).json({ error: 'Date invalide' });
  }
  const normalized = String(date).slice(0, 10);
  try {
    const removed = blockedStore.useRedis()
      ? await blockedStore.removeBlockedDateFromStore(normalized)
      : (db.removeBlockedDate && db.removeBlockedDate(normalized));
    if (!removed) return res.status(404).json({ error: 'Date non bloquée' });
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Créer une réservation et obtenir l’URL de paiement Stripe
app.post('/api/create-reservation', async (req, res) => {
  const { date_arrivee, date_depart, options, nom, email, telephone, message } = req.body || {};
  if (!date_arrivee || !date_depart || !nom || !email) {
    return res.status(400).json({ error: 'Champs obligatoires manquants' });
  }

  const optionKeys = Array.isArray(options) ? options : [];
  const baseInfo = computeBaseAmountEuros(date_arrivee, date_depart);
  const optionsEuros = computeOptionsEuros(optionKeys);
  let amountEuros = baseInfo.base + optionsEuros;
  if (baseInfo.nights >= 2) {
    amountEuros = amountEuros * 0.85; // remise 15 % dès 2 nuits
  }
  const amountCents = Math.round(amountEuros * 100);

  if (amountCents < 100) {
    return res.status(400).json({ error: 'Montant invalide' });
  }

  try {
    const bookingId = db.createBooking({
      date_arrivee,
      date_depart,
      pack: optionKeys.join(','),
      nom,
      email,
      telephone: telephone || null,
      message: message || null,
      amount_cents: amountCents
    });

    if (!stripe) {
      return res.status(503).json({
        error: 'Paiement non configuré',
        message: 'Configurez STRIPE_SECRET_KEY dans .env pour activer le paiement.',
        booking_id: bookingId
      });
    }

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: 'eur',
          unit_amount: amountCents,
          product_data: {
            name: 'Réservation Love Room — Nuit d\'Or',
            description: `Séjour du ${date_arrivee} au ${date_depart}` + (optionKeys.length ? ` — Options: ${optionKeys.join(', ')}` : '')
          }
        },
        quantity: 1
      }],
      success_url: `${BASE_URL}/reservation.html?success=1&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${BASE_URL}/reservation.html?cancel=1`,
      customer_email: email,
      metadata: {
        booking_id: String(bookingId),
        email,
        nom,
        date_arrivee,
        date_depart,
        options: optionKeys.join(','),
        amount_cents: String(amountCents)
      }
    });

    res.json({ url: session.url, booking_id: bookingId });
  } catch (err) {
    console.error('Create reservation error:', err);
    const message = err.message || 'Erreur inconnue';
    res.status(500).json({
      error: 'Erreur lors de la création de la réservation',
      detail: message
    });
  }
});

const PORT = process.env.PORT || 3000;
if (!process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log('Nuit d\'Or — serveur sur http://localhost:' + PORT);
    if (!process.env.STRIPE_SECRET_KEY) {
      console.warn('STRIPE_SECRET_KEY manquant : le paiement ne fonctionnera pas.');
    }
  });
}

module.exports = app;
