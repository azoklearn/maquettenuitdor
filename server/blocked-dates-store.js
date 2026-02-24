/**
 * Stockage :
 * - dates bloquées (indisponibles au calendrier)
 * - réservations « supprimées » côté admin (à ignorer pour les indispos)
 *
 * Sur Vercel, utilise Upstash Redis pour que ces infos persistent entre les requêtes.
 */

const BLOCKED_DATES_KEY = 'nuitdor_blocked_dates';
const CANCELLED_BOOKINGS_KEY = 'nuitdor_cancelled_bookings';

let redis = null;
try {
  const redisUrl = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  if (redisUrl && redisToken) {
    const { Redis } = require('@upstash/redis');
    redis = new Redis({ url: redisUrl, token: redisToken });
  }
} catch (e) {
  console.warn('Redis non disponible pour dates bloquées:', e.message);
}

async function getBlockedDatesFromStore() {
  if (redis) {
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
  return [];
}

async function getCancelledBookingsFromStore() {
  if (redis) {
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
  return [];
}

async function addBlockedDateToStore(date) {
  const d = String(date).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return false;
  if (redis) {
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
  return false;
}

async function removeBlockedDateFromStore(date) {
  const d = String(date).slice(0, 10);
  if (redis) {
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
  return false;
}

async function addCancelledBookingToStore(id) {
  const key = String(id);
  if (!key) return false;
  if (redis) {
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
  return false;
}

function useRedis() {
  return !!redis;
}

module.exports = {
  getBlockedDatesFromStore,
  addBlockedDateToStore,
  removeBlockedDateFromStore,
  getCancelledBookingsFromStore,
  addCancelledBookingToStore,
  useRedis
};
