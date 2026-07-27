/* PumpLog — cached data layer
 *
 * Every page used to re-query Firestore on each tab switch, which made
 * navigation feel slow. This module keeps a short-lived in-memory cache
 * keyed by query, coalesces concurrent identical requests, and exposes an
 * explicit invalidate() used by the refresh control and all writes.
 */

import {
  getDb,
  collection, doc, getDoc, getDocs, query, where, orderBy, limit, documentId,
} from './firebase.js';

const TTL = 60_000; // 1 minute — station data changes rarely
const cache = new Map();   // key -> { value, at }
const inflight = new Map(); // key -> Promise

function fresh(entry) {
  return entry && (Date.now() - entry.at) < TTL;
}

async function cached(key, loader) {
  const hit = cache.get(key);
  if (fresh(hit)) return hit.value;
  if (inflight.has(key)) return inflight.get(key);

  const p = (async () => {
    try {
      const value = await loader();
      cache.set(key, { value, at: Date.now() });
      return value;
    } finally {
      inflight.delete(key);
    }
  })();

  inflight.set(key, p);
  return p;
}

/** Drop cache entries. invalidate() clears everything; a prefix clears a subtree. */
export function invalidate(prefix) {
  if (!prefix) {
    cache.clear();
    return;
  }
  for (const key of cache.keys()) {
    if (key.startsWith(prefix)) cache.delete(key);
  }
}

export const invalidateStation = (stationId) => invalidate(`station:${stationId}`);
export const invalidateUsers = () => invalidate('users');
export const invalidateStations = () => { invalidate('stations'); invalidate('station:'); };

const snapToArray = (snap) => snap.docs.map(d => ({ id: d.id, ...d.data() }));

// ── Stations ────────────────────────────────────────────────────────────
export function getAllStations() {
  return cached('stations:all', async () => {
    const snap = await getDocs(query(collection(getDb(), 'stations'), orderBy('name')));
    return snapToArray(snap);
  });
}

/** Batched lookup — one `in` query per 30 ids instead of one read per id. */
export function getStationsByIds(ids) {
  const unique = [...new Set(ids || [])].filter(Boolean).sort();
  if (unique.length === 0) return Promise.resolve([]);

  return cached(`stations:ids:${unique.join(',')}`, async () => {
    const db = getDb();
    const chunks = [];
    for (let i = 0; i < unique.length; i += 30) chunks.push(unique.slice(i, i + 30));

    const results = await Promise.all(chunks.map(chunk =>
      getDocs(query(collection(db, 'stations'), where(documentId(), 'in', chunk)))
    ));

    const stations = results.flatMap(snapToArray);
    stations.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    return stations;
  });
}

export function getStation(stationId) {
  if (!stationId) return Promise.resolve(null);
  return cached(`station:${stationId}:doc`, async () => {
    const snap = await getDoc(doc(getDb(), 'stations', stationId));
    return snap.exists() ? { id: snap.id, ...snap.data() } : null;
  });
}

// ── Pumps ───────────────────────────────────────────────────────────────
export function getPumps(stationId) {
  if (!stationId) return Promise.resolve([]);
  return cached(`station:${stationId}:pumps`, async () => {
    const snap = await getDocs(
      query(collection(getDb(), 'stations', stationId, 'pumps'), orderBy('name'))
    );
    return snapToArray(snap);
  });
}

// ── Rates ───────────────────────────────────────────────────────────────
export function getRates(stationId) {
  if (!stationId) return Promise.resolve([]);
  return cached(`station:${stationId}:rates`, async () => {
    const snap = await getDocs(
      query(collection(getDb(), 'stations', stationId, 'rates'), orderBy('effectiveDate', 'desc'))
    );
    return snapToArray(snap);
  });
}

/** Latest rate per product, as of today. */
export async function getCurrentRateMap(stationId) {
  const rates = await getRates(stationId);
  const map = {};
  for (const r of rates) {
    const seen = map[r.product];
    if (!seen || (r.effectiveDate || '') > (seen.effectiveDate || '')) map[r.product] = r;
  }
  return map;
}

// ── Shifts ──────────────────────────────────────────────────────────────
/**
 * Single-order query (date desc) keeps this on Firestore's built-in index —
 * the old two-field orderBy needed a composite index and silently failed.
 */
export function getShifts(stationId, { from = null, max = 300 } = {}) {
  if (!stationId) return Promise.resolve([]);

  return cached(`station:${stationId}:shifts:${from || 'all'}:${max}`, async () => {
    const constraints = [];
    if (from) constraints.push(where('date', '>=', from));
    constraints.push(orderBy('date', 'desc'), limit(max));

    const snap = await getDocs(
      query(collection(getDb(), 'stations', stationId, 'shifts'), ...constraints)
    );
    const rows = snapToArray(snap);

    // Stable secondary sort by creation time, done client-side so no composite
    // index is required.
    rows.sort((a, b) => {
      const d = (b.date || '').localeCompare(a.date || '');
      if (d !== 0) return d;
      return (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0);
    });
    return rows;
  });
}

// ── Users ───────────────────────────────────────────────────────────────
export function getAllUsers() {
  return cached('users:all', async () => {
    const snap = await getDocs(query(collection(getDb(), 'users'), orderBy('email')));
    return snapToArray(snap);
  });
}

export function getUsersCreatedBy(uid) {
  if (!uid) return Promise.resolve([]);
  return cached(`users:createdBy:${uid}`, async () => {
    const snap = await getDocs(
      query(collection(getDb(), 'users'), where('createdBy', '==', uid))
    );
    return snapToArray(snap).sort((a, b) => (a.email || '').localeCompare(b.email || ''));
  });
}
