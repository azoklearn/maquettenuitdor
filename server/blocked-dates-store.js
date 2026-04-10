/**
 * Stockage :
 * - dates bloquées (indisponibles au calendrier)
 * - réservations « supprimées » côté admin (à ignorer pour les indispos)
 *
 * Sur Vercel, utilise Upstash Redis (REST) via les variables injectées par le Marketplace
 * ou définies à la main (KV_REST_* ou UPSTASH_REDIS_REST_*).
 */

const BLOCKED_DATES_KEY = 'nuitdor_blocked_dates';
const CANCELLED_BOOKINGS_KEY = 'nuitdor_cancelled_bookings';
const BOOKINGS_KEY = 'nuitdor_bookings';

function trimEnv(v) {
  if (v == null || v === '') return '';
  return String(v).trim();
}

/** Résout URL + token REST (plusieurs noms selon Upstash / ancien KV Vercel / copier-coller). */
function resolveRedisEnv() {
  const url = trimEnv(process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL);
  const token = trimEnv(process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN);
  return { url, token };
}

let _redis = null;
let _redisInitDone = false;

/**
 * Client Redis lazy : les variables d’env sont relues au premier usage
 * (évite les échecs silencieux si le module était chargé trop tôt).
 */
function getRedisClient() {
  if (_redisInitDone) return _redis;
  _redisInitDone = true;
  const { url, token } = resolveRedisEnv();
  if (!url || !token) {
    if (process.env.VERCEL) {
      console.warn(
        "[nuitdor] Redis non configuré : ajoutez KV_REST_API_URL + KV_REST_API_TOKEN " +
          '(ou UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN) dans Vercel → Settings → Environment Variables, puis redéployez.'
      );
    }
    _redis = null;
    return null;
  }
  try {
    const { Redis } = require('@upstash/redis');
    _redis = new Redis({ url, token });
    return _redis;
  } catch (e) {
    console.warn('[nuitdor] Redis init impossible:', e.message || e);
    _redis = null;
    return null;
  }
}

function useRedis() {
  return !!getRedisClient();
}

async function getBlockedDatesFromStore() {
  const redis = getRedisClient();
  if (!redis) return [];
  try {
    const raw = await redis.get(BLOCKED_DATES_KEY);
    if (Array.isArray(raw)) return raw;
    if (typeof raw === 'string') {
      try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
      } catch (_) {
        return [];
      }
    }
    return [];
  } catch (e) {
    console.error('Redis get blocked_dates:', e);
    return [];
  }
}

async function getCancelledBookingsFromStore() {
  const redis = getRedisClient();
  if (!redis) return [];
  try {
    const raw = await redis.get(CANCELLED_BOOKINGS_KEY);
    if (Array.isArray(raw)) return raw.map((x) => String(x));
    if (typeof raw === 'string') {
      try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed.map((x) => String(x)) : [];
      } catch (_) {
        return [];
      }
    }
    return [];
  } catch (e) {
    console.error('Redis get cancelled_bookings:', e);
    return [];
  }
}

async function addBlockedDateToStore(date) {
  const d = String(date).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return false;
  const redis = getRedisClient();
  if (!redis) return false;
  try {
    const list = await getBlockedDatesFromStore();
    if (list.includes(d)) return false;
    list.push(d);
    list.sort();
    await redis.set(BLOCKED_DATES_KEY, JSON.stringify(list));
    return true;
  } catch (e) {
    console.error('Redis set blocked_dates:', e);
    return false;
  }
}

async function removeBlockedDateFromStore(date) {
  const d = String(date).slice(0, 10);
  const redis = getRedisClient();
  if (!redis) return false;
  try {
    const list = await getBlockedDatesFromStore();
    const idx = list.indexOf(d);
    if (idx === -1) return false;
    list.splice(idx, 1);
    await redis.set(BLOCKED_DATES_KEY, JSON.stringify(list));
    return true;
  } catch (e) {
    console.error('Redis remove blocked_date:', e);
    return false;
  }
}

async function addCancelledBookingToStore(id) {
  const key = String(id);
  if (!key) return false;
  const redis = getRedisClient();
  if (!redis) return false;
  try {
    const list = await getCancelledBookingsFromStore();
    if (list.includes(key)) return false;
    list.push(key);
    await redis.set(CANCELLED_BOOKINGS_KEY, JSON.stringify(list));
    return true;
  } catch (e) {
    console.error('Redis set cancelled_bookings:', e);
    return false;
  }
}

async function removeCancelledBookingFromStore(id) {
  const key = String(id);
  if (!key) return false;
  const redis = getRedisClient();
  if (!redis) return false;
  try {
    const list = await getCancelledBookingsFromStore();
    const idx = list.indexOf(key);
    if (idx === -1) return false;
    list.splice(idx, 1);
    await redis.set(CANCELLED_BOOKINGS_KEY, JSON.stringify(list));
    return true;
  } catch (e) {
    console.error('Redis remove cancelled_booking:', e);
    return false;
  }
}

async function getBookingsFromStore() {
  const redis = getRedisClient();
  if (!redis) return [];
  try {
    const raw = await redis.get(BOOKINGS_KEY);
    if (Array.isArray(raw)) return raw;
    if (typeof raw === 'string') {
      try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
      } catch (_) {
        return [];
      }
    }
    return [];
  } catch (e) {
    console.error('Redis get bookings:', e);
    return [];
  }
}

async function addBookingToStore(booking) {
  const redis = getRedisClient();
  if (!redis || !booking) return false;
  try {
    const list = await getBookingsFromStore();
    const existing = list.find((x) => Number(x.id) === Number(booking.id));
    if (existing && existing.status === 'paid') return true;
    const b = {
      id: booking.id,
      date_arrivee: booking.date_arrivee,
      date_depart: booking.date_depart,
      pack: booking.pack || '',
      nom: booking.nom,
      email: booking.email,
      telephone: booking.telephone || null,
      amount_cents: booking.amount_cents,
      status: 'pending',
      stripe_session_id: existing ? existing.stripe_session_id : null,
      created_at: booking.created_at || new Date().toISOString()
    };
    if (existing) {
      const idx = list.indexOf(existing);
      list[idx] = b;
    } else {
      list.push(b);
    }
    await redis.set(BOOKINGS_KEY, JSON.stringify(list));
    // Sur Vercel (db mémoire), des IDs peuvent être réutilisés : on enlève une annulation
    // obsolète portant le même id pour éviter de masquer la nouvelle réservation.
    await removeCancelledBookingFromStore(booking.id);
    return true;
  } catch (e) {
    console.error('Redis add booking:', e);
    return false;
  }
}

async function setBookingPaidInStore(bookingId, stripeSessionId) {
  const redis = getRedisClient();
  if (!redis) return false;
  try {
    const list = await getBookingsFromStore();
    const b = list.find((x) => Number(x.id) === Number(bookingId));
    if (!b) return false;
    b.status = 'paid';
    b.stripe_session_id = stripeSessionId;
    await redis.set(BOOKINGS_KEY, JSON.stringify(list));
    await removeCancelledBookingFromStore(bookingId);
    return true;
  } catch (e) {
    console.error('Redis set booking paid:', e);
    return false;
  }
}

async function ensurePaidBookingInStore(bookingId, stripeSessionId, metadata) {
  const redis = getRedisClient();
  if (!redis || !metadata) return false;
  try {
    const list = await getBookingsFromStore();
    const existing = list.find((x) => Number(x.id) === Number(bookingId) || x.stripe_session_id === stripeSessionId);
    if (existing) {
      existing.status = 'paid';
      existing.stripe_session_id = stripeSessionId;
      if (!existing.date_arrivee && metadata.date_arrivee) existing.date_arrivee = metadata.date_arrivee;
      if (!existing.date_depart && metadata.date_depart) existing.date_depart = metadata.date_depart;
      if (!existing.nom && metadata.nom) existing.nom = metadata.nom;
      if (!existing.email && metadata.email) existing.email = metadata.email;
      await redis.set(BOOKINGS_KEY, JSON.stringify(list));
      await removeCancelledBookingFromStore(bookingId);
      return true;
    }
    const created = metadata.created ? metadata.created : new Date().toISOString();
    list.push({
      id: Number(bookingId),
      date_arrivee: metadata.date_arrivee || '',
      date_depart: metadata.date_depart || '',
      pack: metadata.options || '',
      nom: metadata.nom || '',
      email: metadata.email || '',
      telephone: null,
      amount_cents: Number(metadata.amount_cents) || 0,
      status: 'paid',
      stripe_session_id: stripeSessionId,
      created_at: created
    });
    await redis.set(BOOKINGS_KEY, JSON.stringify(list));
    await removeCancelledBookingFromStore(bookingId);
    return true;
  } catch (e) {
    console.error('Redis ensure paid booking:', e);
    return false;
  }
}

/**
 * Diagnostic sans secrets : utile pour vérifier Vercel / Upstash après déploiement.
 */
async function getStorageHealth() {
  const { url, token } = resolveRedisEnv();
  const out = {
    env_url_set: !!url,
    env_token_set: !!token,
    redis_client_ok: false,
    bookings_count: null,
    read_error: null
  };
  const redis = getRedisClient();
  if (!redis) {
    out.hint =
      'Variables REST attendues : KV_REST_API_URL + KV_REST_API_TOKEN (ou UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN). ' +
      'Vérifie qu’elles sont bien pour Production (pas seulement Preview), sans espace en trop, puis redéploie.';
    return out;
  }
  out.redis_client_ok = true;
  try {
    const list = await getBookingsFromStore();
    out.bookings_count = Array.isArray(list) ? list.length : null;
  } catch (e) {
    out.read_error = e.message || String(e);
  }
  return out;
}

module.exports = {
  getBlockedDatesFromStore,
  addBlockedDateToStore,
  removeBlockedDateFromStore,
  getCancelledBookingsFromStore,
  addCancelledBookingToStore,
  removeCancelledBookingFromStore,
  getBookingsFromStore,
  addBookingToStore,
  setBookingPaidInStore,
  ensurePaidBookingInStore,
  useRedis,
  getStorageHealth
};
