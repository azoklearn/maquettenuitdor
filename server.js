require('dotenv').config();
const express = require('express');
const path = require('path');
const Stripe = require('stripe');
const db = require('./server/db');
const mail = require('./server/mail');

const app = express();
const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;

const BASE_PRICE_PER_NIGHT = Number(process.env.BASE_PRICE_PER_NIGHT) || 150;
const PACK_PRICES = {
  aucun: 0,
  champagne: 45,
  romance: 75,
  luxe: 120,
  evasion: 160
};

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';

try {
  db.initDb();
} catch (e) {
  console.error('DB init error:', e.message);
}

// Fichiers statiques (en local uniquement ; sur Vercel, public/ est servi par le CDN)
if (!process.env.VERCEL) {
  app.use(express.static(path.join(__dirname, 'public')));
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
      const booking = db.getBookingById(Number(bookingId));
      if (booking) {
        mail.sendConfirmationEmail(booking).catch((err) => console.error('Email confirmation:', err));
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
    const booking = db.getBookingById(Number(bookingId));
    if (!booking) return res.status(404).json({ error: 'Réservation introuvable' });
    if (booking.status === 'paid') {
      return res.json({ ok: true, already: true });
    }
    db.setBookingPaid(Number(bookingId), sessionId);
    const updated = db.getBookingById(Number(bookingId));
    if (updated) mail.sendConfirmationEmail(updated).catch((e) => console.error('Email:', e));
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur lors de la confirmation' });
  }
});

// Créneaux déjà réservés (dates à désactiver dans le calendrier)
app.get('/api/booked-dates', (req, res) => {
  try {
    const dates = db.getBookedDates();
    res.json({ dates });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Créer une réservation et obtenir l’URL de paiement Stripe
app.post('/api/create-reservation', async (req, res) => {
  const { date_arrivee, date_depart, pack, nom, email, telephone, message } = req.body || {};
  if (!date_arrivee || !date_depart || !nom || !email) {
    return res.status(400).json({ error: 'Champs obligatoires manquants' });
  }

  const packKey = (pack && PACK_PRICES.hasOwnProperty(pack)) ? pack : 'aucun';
  const start = new Date(date_arrivee);
  const end = new Date(date_depart);
  const nights = Math.max(0, Math.ceil((end - start) / (24 * 60 * 60 * 1000)));
  const amountEuros = nights * BASE_PRICE_PER_NIGHT + (PACK_PRICES[packKey] || 0);
  const amountCents = Math.round(amountEuros * 100);

  if (amountCents < 100) {
    return res.status(400).json({ error: 'Montant invalide' });
  }

  try {
    const bookingId = db.createBooking({
      date_arrivee,
      date_depart,
      pack: packKey,
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
            description: `Séjour du ${date_arrivee} au ${date_depart}${packKey !== 'aucun' ? ` — Pack ${packKey}` : ''}`
          }
        },
        quantity: 1
      }],
      success_url: `${BASE_URL}/reservation.html?success=1&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${BASE_URL}/reservation.html?cancel=1`,
      customer_email: email,
      metadata: { booking_id: String(bookingId) }
    });

    res.json({ url: session.url, booking_id: bookingId });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur lors de la création de la réservation' });
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
