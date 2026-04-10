require('dotenv').config();
const express = require('express');
const path = require('path');
const Stripe = require('stripe');
const db = require('./server/db');
const blockedStore = require('./server/blocked-dates-store');

const app = express();
const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;

/** Sessions Checkout Stripe avec pagination (évite de ne voir que les 100 plus récentes). */
async function listStripeCheckoutSessions(maxTotal = 500) {
  if (!stripe) return [];
  const cap = Math.min(Math.max(1, maxTotal), 1000);
  let allSessions = [];
  let hasMore = true;
  let lastId = null;
  while (hasMore && allSessions.length < cap) {
    const opts = { limit: 100 };
    if (lastId) opts.starting_after = lastId;
    const chunk = await stripe.checkout.sessions.list(opts);
    const data = chunk.data || [];
    allSessions = allSessions.concat(data);
    hasMore = !!chunk.has_more && data.length > 0;
    if (data.length > 0) lastId = data[data.length - 1].id;
    if (allSessions.length >= cap) break;
  }
  return allSessions.slice(0, cap);
}

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

// Codes promo : variable d’env PROMO_CODES au format "CODE1:10,CODE2:15" (pourcent de remise)
function getPromoCodesMap() {
  const raw = process.env.PROMO_CODES || '';
  const map = new Map();
  raw.split(',').forEach(part => {
    const [code, percent] = part.trim().split(':').map(s => s.trim());
    if (code && percent) {
      const p = parseInt(percent, 10);
      if (!isNaN(p) && p > 0 && p < 100) map.set(code.toUpperCase(), p);
    }
  });
  return map;
}

function validatePromoCode(code) {
  if (!code || typeof code !== 'string') return null;
  const normalized = code.trim().toUpperCase();
  if (!normalized) return null;
  const p = getPromoCodesMap().get(normalized);
  return p != null ? { valid: true, discount_percent: p } : { valid: false };
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
app.use('/api/webhook/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
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
      if (blockedStore.useRedis()) {
        const updated = await blockedStore.setBookingPaidInStore(Number(bookingId), session.id);
        if (!updated) {
          const meta = session.metadata || {};
          await blockedStore.ensurePaidBookingInStore(Number(bookingId), session.id, {
            ...meta,
            created: session.created ? new Date(session.created * 1000).toISOString() : new Date().toISOString()
          });
        }
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
    if (blockedStore.useRedis()) {
      const updatedInRedis = await blockedStore.setBookingPaidInStore(Number(bookingId), sessionId);
      if (!updatedInRedis) {
        const meta = session.metadata || {};
        await blockedStore.ensurePaidBookingInStore(Number(bookingId), sessionId, {
          ...meta,
          created: session.created ? new Date(session.created * 1000).toISOString() : new Date().toISOString()
        });
      }
    }
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
    let fromBookings = [];
    const cancelledIds = blockedStore.useRedis()
      ? await blockedStore.getCancelledBookingsFromStore()
      : [];
    const cancelledSet = new Set((cancelledIds || []).map((x) => String(x)));
    function isCancelledBooking(bookingId, stripeSessionId) {
      const idKey = bookingId != null ? String(bookingId) : null;
      const sidKey = stripeSessionId ? String(stripeSessionId) : null;
      if (sidKey) return cancelledSet.has('sess:' + sidKey);
      return !!(idKey && cancelledSet.has('id:' + idKey));
    }

    function addDatesFromRange(dateSet, dateArrivee, dateDepart, excludeBookingId, stripeSessionId) {
      if (isCancelledBooking(excludeBookingId, stripeSessionId)) return;
      const start = new Date(dateArrivee);
      const end = new Date(dateDepart);
      if (isNaN(start) || isNaN(end)) return;
      const cursor = new Date(start.getTime());
      cursor.setHours(0, 0, 0, 0);
      const limit = new Date(end.getTime());
      limit.setHours(0, 0, 0, 0);
      while (cursor < limit) {
        dateSet.add(cursor.toISOString().slice(0, 10));
        cursor.setDate(cursor.getDate() + 1);
      }
    }

    const dateSet = new Set();
    // 1) Stripe : sessions payées = dates bloquées (même pagination que l’admin, pas seulement 100)
    if (stripe) {
      try {
        const sessions = await listStripeCheckoutSessions(500);
        sessions.forEach((s) => {
          const isPaid = (s.payment_status === 'paid') || (s.status === 'complete');
          if (!isPaid) return;
          const meta = s.metadata || {};
          if (!meta.date_arrivee || !meta.date_depart) return;
          addDatesFromRange(dateSet, meta.date_arrivee, meta.date_depart, meta.booking_id, s.id);
        });
      } catch (e) {
        console.error('Stripe booked-dates:', e.message || e);
      }
    }
    // 2) Redis : fusionner les résas payées (webhook peut avoir ajouté sans que Stripe list les renvoie)
    if (blockedStore.useRedis()) {
      const list = await blockedStore.getBookingsFromStore();
      (list || []).forEach((b) => {
        if (b.status !== 'paid') return;
        if (!b.date_arrivee || !b.date_depart) return;
        addDatesFromRange(dateSet, b.date_arrivee, b.date_depart, b.id, b.stripe_session_id);
      });
    }
    if (dateSet.size > 0) {
      fromBookings = Array.from(dateSet);
    }
    // 3) Sinon SQLite (local)
    if (fromBookings.length === 0) {
      fromBookings = db.getBookedDates();
    }

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

app.get('/api/admin/bookings', requireAdmin, async (req, res) => {
  try {
    const cancelledIds = blockedStore.useRedis()
      ? await blockedStore.getCancelledBookingsFromStore()
      : [];
    const cancelledSet = new Set((cancelledIds || []).map((x) => String(x)));
    function isCancelledBooking(bookingId, stripeSessionId) {
      const idKey = bookingId != null ? String(bookingId) : null;
      const sidKey = stripeSessionId ? String(stripeSessionId) : null;
      if (sidKey) return cancelledSet.has('sess:' + sidKey);
      return !!(idKey && cancelledSet.has('id:' + idKey));
    }

    let bookings = [];

    // Si Redis est disponible, on le considère comme source principale pour l'admin
    // (plus fiable que Stripe seul, surtout en mode serverless).
    if (blockedStore.useRedis()) {
      const list = await blockedStore.getBookingsFromStore();
      bookings = (list || [])
        .filter((b) => !isCancelledBooking(b.id, b.stripe_session_id))
        .map((b) => ({
          id: b.id,
          date_arrivee: b.date_arrivee || '—',
          date_depart: b.date_depart || '—',
          pack: b.pack || '',
          nom: b.nom || '',
          email: b.email || '',
          telephone: b.telephone || null,
          amount_cents: b.amount_cents != null ? b.amount_cents : 0,
          status: b.status || 'pending',
          created_at: b.created_at || null,
          stripe_session_id: b.stripe_session_id || null
        }))
        .sort((a, b) => {
          if (!a.created_at && !b.created_at) return 0;
          if (!a.created_at) return 1;
          if (!b.created_at) return -1;
          return new Date(b.created_at) - new Date(a.created_at);
        });
    }

    const redisBookingsSnapshot = blockedStore.useRedis() ? bookings.slice() : null;

    // 1) Stripe (complément / debug) : on fusionne Stripe par-dessus Redis si besoin
    if (stripe) {
      try {
      let allSessions = await listStripeCheckoutSessions(500);
      res.locals._stripeSessionsCount = allSessions.length;
      // Inclure toutes les sessions avec metadata (notre formulaire) OU toute session payée (au cas où metadata manquante)
      const stripeBookings = (allSessions || [])
        .filter((s) => {
          const hasMeta = s.metadata && (s.metadata.booking_id || (s.metadata.date_arrivee && s.metadata.date_depart));
          const isPaid = (s.payment_status === 'paid') || (s.status === 'complete');
          return hasMeta || isPaid;
        })
        .map((s) => {
          const meta = s.metadata || {};
          const createdIso = s.created ? new Date(s.created * 1000).toISOString() : null;
          const amountCents = Number(meta.amount_cents) || s.amount_total || 0;
          const isPaid = (s.payment_status === 'paid') || (s.status === 'complete');
          return {
            id: meta.booking_id ? Number(meta.booking_id) : null,
            date_arrivee: meta.date_arrivee || null,
            date_depart: meta.date_depart || null,
            pack: meta.options || '',
            nom: meta.nom || '',
            email: meta.email || s.customer_email || '',
            telephone: null,
            amount_cents: amountCents,
            status: isPaid ? 'paid' : 'pending',
            created_at: createdIso,
            stripe_session_id: s.id
          };
        })
        .filter((b) => !isCancelledBooking(b.id, b.stripe_session_id));
      const stripeSessionIds = new Set(stripeBookings.map((b) => b.stripe_session_id).filter(Boolean));
      if (!blockedStore.useRedis()) {
        bookings = stripeBookings.map((b) => ({
          ...b,
          date_arrivee: b.date_arrivee || '—',
          date_depart: b.date_depart || '—'
        }));
      }

      if (blockedStore.useRedis()) {
        for (const s of allSessions || []) {
          const isPaid = (s.payment_status === 'paid') || (s.status === 'complete');
          const meta = s.metadata || {};
          const bid = meta.booking_id;
          if (isPaid && bid && (meta.date_arrivee || meta.email)) {
            await blockedStore.ensurePaidBookingInStore(Number(bid), s.id, {
              ...meta,
              created: s.created ? new Date(s.created * 1000).toISOString() : new Date().toISOString()
            });
          }
        }
        // Si Redis est la source principale, on garde sa liste et on n'ajoute depuis Stripe
        // que les sessions absentes du store (cas rares).
        const redisList = await blockedStore.getBookingsFromStore();
        bookings = (redisList || [])
          .filter((b) => !isCancelledBooking(b.id, b.stripe_session_id))
          .map((b) => ({
            id: b.id,
            date_arrivee: b.date_arrivee || '—',
            date_depart: b.date_depart || '—',
            pack: b.pack || '',
            nom: b.nom || '',
            email: b.email || '',
            telephone: b.telephone || null,
            amount_cents: b.amount_cents != null ? b.amount_cents : 0,
            status: b.status || 'pending',
            created_at: b.created_at || null,
            stripe_session_id: b.stripe_session_id || null
          }));
        const redisSessionIds = new Set((redisList || []).map((x) => x && x.stripe_session_id).filter(Boolean));
        for (const s of stripeBookings || []) {
          if (!s.stripe_session_id) continue;
          if (redisSessionIds.has(s.stripe_session_id)) continue;
          if (isCancelledBooking(s.id, s.stripe_session_id)) continue;
          bookings.push({
            id: s.id,
            date_arrivee: s.date_arrivee || '—',
            date_depart: s.date_depart || '—',
            pack: s.pack || '',
            nom: s.nom || '',
            email: s.email || '',
            telephone: s.telephone || null,
            amount_cents: s.amount_cents != null ? s.amount_cents : 0,
            status: s.status || 'pending',
            created_at: s.created_at || null,
            stripe_session_id: s.stripe_session_id || null
          });
        }
      }

      bookings.sort((a, b) => {
        if (!a.created_at && !b.created_at) return 0;
        if (!a.created_at) return 1;
        if (!b.created_at) return -1;
        return new Date(b.created_at) - new Date(a.created_at);
      });
      } catch (stripeErr) {
        console.error('Stripe admin bookings:', stripeErr.message || stripeErr);
        if (redisBookingsSnapshot !== null) {
          bookings = redisBookingsSnapshot;
        }
      }
    }

    // 2) Sinon Redis (Vercel sans Stripe)
    if (bookings.length === 0 && blockedStore.useRedis()) {
      const list = await blockedStore.getBookingsFromStore();
      bookings = list
        .filter((b) => !isCancelledBooking(b.id, b.stripe_session_id))
        .map((b) => ({
          id: b.id,
          date_arrivee: b.date_arrivee || '—',
          date_depart: b.date_depart || '—',
          pack: b.pack || '',
          nom: b.nom || '',
          email: b.email || '',
          telephone: b.telephone || null,
          amount_cents: b.amount_cents != null ? b.amount_cents : 0,
          status: b.status || 'pending',
          created_at: b.created_at || null,
          stripe_session_id: b.stripe_session_id || null
        }))
        .sort((a, b) => {
          if (!a.created_at && !b.created_at) return 0;
          if (!a.created_at) return 1;
          if (!b.created_at) return -1;
          return new Date(b.created_at) - new Date(a.created_at);
        });
    }

    // 3) Sinon SQLite (local)
    if (bookings.length === 0) {
      bookings = db.getAllBookings();
    }

    // Normaliser l'affichage : dates vides → "—" (anciennes résas sans metadata)
    bookings = bookings.map((b) => ({
      ...b,
      date_arrivee: b.date_arrivee || '—',
      date_depart: b.date_depart || '—'
    }));

    const out = { bookings };
    if (req.query.debug === '1') {
      let redisCount = null;
      if (blockedStore.useRedis()) {
        try {
          const list = await blockedStore.getBookingsFromStore();
          redisCount = (list || []).length;
        } catch (e) {
          redisCount = 'error: ' + (e.message || '');
        }
      }
      let storageHealth = null;
      try {
        storageHealth = await blockedStore.getStorageHealth();
      } catch (e) {
        storageHealth = { error: e.message || String(e) };
      }
      out._debug = {
        stripe_sessions_count: stripe ? (res.locals._stripeSessionsCount ?? null) : null,
        redis_used: blockedStore.useRedis(),
        redis_bookings_count: redisCount,
        storage: storageHealth
      };
    }
    res.json(out);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

app.delete('/api/admin/bookings/:id', requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const stripeSessionIdRaw =
    (req.query && req.query.stripe_session_id) ||
    (req.body && req.body.stripe_session_id) ||
    '';
  const stripeSessionId = String(stripeSessionIdRaw || '').trim();
  const hasValidId = Number.isFinite(id) && id > 0;
  if (!hasValidId && !stripeSessionId) {
    return res.status(400).json({ error: 'ID ou stripe_session_id invalide' });
  }
  try {
    // Avec Redis : on marque la réservation comme « annulée » pour libérer les dates.
    if (blockedStore.useRedis()) {
      const redisList = await blockedStore.getBookingsFromStore();
      const booking = (redisList || []).find((b) => {
        if (hasValidId && Number(b.id) === id) return true;
        return stripeSessionId && String(b.stripe_session_id || '') === stripeSessionId;
      });
      if (hasValidId) {
        await blockedStore.addCancelledBookingToStore('id:' + String(id));
      }
      const sidToCancel = stripeSessionId || (booking && booking.stripe_session_id) || '';
      if (sidToCancel) {
        await blockedStore.addCancelledBookingToStore('sess:' + String(sidToCancel));
      }
      return res.json({ ok: true });
    }

    if (!hasValidId) return res.status(400).json({ error: 'ID invalide' });
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
// Diagnostic Stripe : vérifier que la clé pointe vers le bon compte
app.get('/api/stripe-check', async (req, res) => {
  if (!stripe) {
    return res.json({ stripe_ok: false, error: 'STRIPE_SECRET_KEY non configurée' });
  }
  try {
    const sessions = await stripe.checkout.sessions.list({ limit: 10 });
    const key = process.env.STRIPE_SECRET_KEY || '';
    const keyMode = key.startsWith('sk_live_') ? 'live' : key.startsWith('sk_test_') ? 'test' : 'inconnu';
    return res.json({
      stripe_ok: true,
      key_mode: keyMode,
      recent_sessions_count: (sessions.data || []).length,
      message: 'Compare avec ton dashboard Stripe (Paiements / Checkout). Si 0 ici mais des paiements chez toi, vérifie que le mode (test/live) du dashboard correspond à key_mode ci-dessus et que STRIPE_SECRET_KEY sur Vercel est la bonne clé.'
    });
  } catch (err) {
    return res.json({
      stripe_ok: false,
      error: err.message || 'Erreur Stripe',
      message: 'Clé invalide ou révoquée. Vérifie STRIPE_SECRET_KEY sur Vercel = Stripe > Développeurs > Clés API.'
    });
  }
});

// Diagnostic stockage (Redis REST) — sans secrets ; à comparer avec les variables Vercel
app.get('/api/health-storage', async (req, res) => {
  try {
    const health = await blockedStore.getStorageHealth();
    res.json(health);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

app.get('/api/validate-promo', (req, res) => {
  const code = req.query.code;
  const result = validatePromoCode(code);
  if (result && result.valid) {
    return res.json({ valid: true, discount_percent: result.discount_percent });
  }
  res.json({ valid: false });
});

app.post('/api/create-reservation', async (req, res) => {
  const { date_arrivee, date_depart, options, nom, email, telephone, message, promo_code } = req.body || {};
  if (!date_arrivee || !date_depart || !nom || !email) {
    return res.status(400).json({ error: 'Champs obligatoires manquants' });
  }

  // Mode "en attente de paiement" : on désactive volontairement le paiement en ligne
  if (process.env.PAYMENT_DISABLED === 'true') {
    return res.status(503).json({
      error: 'Paiement temporairement indisponible',
      message: 'Le site est actuellement en mode "en attente de paiement". Merci de nous contacter directement pour réserver.'
    });
  }

  const optionKeys = Array.isArray(options) ? options : [];
  const baseInfo = computeBaseAmountEuros(date_arrivee, date_depart);
  const optionsEuros = computeOptionsEuros(optionKeys);
  let amountEuros = baseInfo.base + optionsEuros;
  if (baseInfo.nights >= 2) {
    amountEuros = amountEuros * 0.85; // remise 15 % dès 2 nuits
  }
  const promo = validatePromoCode(promo_code);
  if (promo && promo.valid) {
    amountEuros = amountEuros * (1 - promo.discount_percent / 100);
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

    // Utiliser le domaine de la requête (www ou non) pour que la redirection Stripe ramène au bon site
    const host = req.get('host') || '';
    const protocol = req.get('x-forwarded-proto') || req.protocol || 'https';
    const requestOrigin = host ? `${protocol}://${host}` : BASE_URL;

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
      success_url: `${requestOrigin}/reservation.html?success=1&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${requestOrigin}/reservation.html?cancel=1`,
      customer_email: email,
      metadata: {
        booking_id: String(bookingId),
        email,
        nom,
        date_arrivee,
        date_depart,
        options: optionKeys.join(','),
        amount_cents: String(amountCents),
        ...(promo && promo.valid && { promo_code: String(req.body.promo_code || '').trim().toUpperCase() })
      }
    });

    if (blockedStore.useRedis()) {
      const stored = await blockedStore.addBookingToStore({
        id: bookingId,
        date_arrivee,
        date_depart,
        pack: optionKeys.join(','),
        nom,
        email,
        telephone: telephone || null,
        amount_cents: amountCents,
        created_at: new Date().toISOString()
      });
      if (!stored) {
        console.error('[nuitdor] Échec écriture Redis pour la réservation', bookingId, '(Stripe Checkout créé quand même)');
      }
    } else if (process.env.VERCEL) {
      console.warn('[nuitdor] Redis indisponible : la réservation ne sera pas persistée entre instances Vercel (configure KV_REST_* ou UPSTASH_REDIS_REST_*).');
    }

    res.json({
      url: session.url,
      booking_id: bookingId,
      _debug: { host: req.get('host'), success_url_base: requestOrigin }
    });
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
