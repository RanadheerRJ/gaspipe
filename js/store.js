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
  onSnapshot,
} from './firebase.js';
import { getCurrentUserData, can } from './auth.js';

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

// ── Live pump session locks ─────────────────────────────────────────────
// A missing session document is intentionally returned as idle by callers.
// Keeping this separate from shifts prevents a stale history row from
// pretending that a pump is currently occupied.
export function getPumpSessions(stationId) {
  if (!stationId) return Promise.resolve([]);
  return cached(`station:${stationId}:pumpSessions`, async () => {
    const snap = await getDocs(collection(getDb(), 'stations', stationId, 'pumpSessions'));
    return snapToArray(snap);
  });
}

export function watchPumpSessions(stationId, { onUpdate, onError } = {}) {
  if (!stationId || !getCurrentUserData()) return () => {};
  const q = collection(getDb(), 'stations', stationId, 'pumpSessions');
  return onSnapshot(q, snap => {
    onUpdate?.(snapToArray(snap), { fromCache: snap.metadata.fromCache, at: Date.now() });
  }, err => {
    onError?.(err);
  });
}

// ── Daily pump assignments (the Kanban board) ───────────────────────────
//
// One document per pump per day: stations/{id}/assignments/{date}_{pumpId}
//   { date, pumpId, pumpName, product, staffUids: [...], staffNames: {uid: name} }
//
// Keeping the date in the document id makes a day's board a single range
// query with no composite index, and makes "copy yesterday" a plain read.

export const assignmentId = (date, pumpId) => `${date}_${pumpId}`;

export function getAssignments(stationId, date) {
  if (!stationId || !date) return Promise.resolve([]);
  return cached(`station:${stationId}:assignments:${date}`, async () => {
    const snap = await getDocs(query(
      collection(getDb(), 'stations', stationId, 'assignments'),
      where('date', '==', date),
    ));
    return snapToArray(snap);
  });
}

export function watchAssignments(stationId, date, { onUpdate, onError } = {}) {
  if (!stationId || !date || !getCurrentUserData()) return () => {};
  const q = query(
    collection(getDb(), 'stations', stationId, 'assignments'),
    where('date', '==', date),
  );
  return onSnapshot(q, snap => {
    onUpdate?.(snapToArray(snap), { fromCache: snap.metadata.fromCache, at: Date.now() });
  }, err => {
    onError?.(err);
  });
}

/** Pump ids the given user is rostered on for `date`. */
export function pumpIdsForUser(assignments, uid) {
  if (!uid) return [];
  return (assignments || [])
    .filter(row => (row.staffUids || []).includes(uid))
    .map(row => row.pumpId)
    .filter(Boolean);
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
// Stable secondary sort by creation time, done client-side so no composite
// index is required.
function sortShiftRows(rows) {
  rows.sort((a, b) => {
    const d = (b.date || '').localeCompare(a.date || '');
    if (d !== 0) return d;
    return (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0);
  });
  return rows;
}

/**
 * True when the signed-in user manages this station and may therefore read
 * every shift record. Staff read only their own records (enforced by
 * firestore.rules), and their queries must be scoped to createdBy == uid.
 */
const managesStationData = (stationId) => can('shift.update', { stationId });

/**
 * Single-order query (date desc) keeps this on Firestore's built-in index —
 * the old two-field orderBy needed a composite index and silently failed.
 *
 * Staff get an equality-only query (staffUid == uid) with the date range
 * applied in memory, so manager-assisted clock-outs remain visible without a
 * composite index and the query passes the rules.
 */
export function getShifts(stationId, { from = null, max = 300 } = {}) {
  if (!stationId) return Promise.resolve([]);

  const me = getCurrentUserData();
  const ownOnly = !!me && !managesStationData(stationId);

  return cached(`station:${stationId}:shifts:${ownOnly ? `own:${me.uid}` : 'all'}:${from || 'all'}:${max}`, async () => {
    const db = getDb();

    if (ownOnly) {
      // staffUid is the person whose shift this is. createdBy can be a Manager
      // who ended it on their behalf, so querying createdBy hid valid records.
      const snap = await getDocs(query(
        collection(db, 'stations', stationId, 'shifts'),
        where('staffUid', '==', me.uid),
      ));
      let rows = snapToArray(snap);
      if (from) rows = rows.filter(r => (r.date || '') >= from);
      return sortShiftRows(rows).slice(0, max);
    }

    const constraints = [];
    if (from) constraints.push(where('date', '>=', from));
    constraints.push(orderBy('date', 'desc'), limit(max));

    const snap = await getDocs(
      query(collection(db, 'stations', stationId, 'shifts'), ...constraints)
    );
    return sortShiftRows(snapToArray(snap));
  });
}

/**
 * Live subscription to a station's shift records — the dashboard "live feed".
 * Managers receive the newest records station-wide; staff receive their own
 * (matching the security rules). Works offline: snapshots fire from the
 * persistent cache first, then refresh when the server responds.
 *
 * @returns {() => void} unsubscribe function
 */
export function watchShifts(stationId, { onUpdate, onError, max = 200 } = {}) {
  const me = getCurrentUserData();
  if (!stationId || !me) return () => {};

  const base = collection(getDb(), 'stations', stationId, 'shifts');
  const q = managesStationData(stationId)
    ? query(base, orderBy('date', 'desc'), limit(60))
    : query(base, where('staffUid', '==', me.uid));

  return onSnapshot(q, (snap) => {
    const rows = sortShiftRows(snapToArray(snap)).slice(0, max);
    onUpdate?.(rows, { fromCache: snap.metadata.fromCache, at: Date.now() });
  }, (err) => {
    onError?.(err);
  });
}

// ── Users ───────────────────────────────────────────────────────────────
export function getAllUsers() {
  return cached('users:all', async () => {
    // Username/PIN staff profiles intentionally have no email field. Sort
    // client-side so legacy email users and new identities both appear.
    const snap = await getDocs(collection(getDb(), 'users'));
    return snapToArray(snap).sort((a, b) =>
      (a.fullName || a.email || a.username || '').localeCompare(b.fullName || b.email || b.username || '')
    );
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

const byDisplayName = (a, b) =>
  (a.fullName || a.email || a.username || '').localeCompare(b.fullName || b.email || b.username || '');

/**
 * Every account the signed-in user may administer.
 *
 * Super Admin sees everyone. A Station Admin or Manager sees the accounts
 * they created PLUS everyone attached to one of their stations — otherwise a
 * Station Admin cannot see (or roster) staff that their own Manager created,
 * which made half the team invisible on the board.
 */
export async function getManageableUsers(stationIds = []) {
  const me = getCurrentUserData();
  if (!me) return [];
  if (me.role === 'superadmin') return getAllUsers();

  const mine = await getUsersCreatedBy(me.uid).catch(() => []);
  const perStation = await Promise.all(
    (stationIds || []).map(id => getUsersAtStation(id).catch(() => []))
  );

  const merged = new Map();
  for (const user of [...mine, ...perStation.flat()]) merged.set(user.id, user);
  return [...merged.values()].sort(byDisplayName);
}

/** Every active user profile attached to a station (any role). Disabled and
 *  invited profiles are excluded so roster tallies and staff pickers never
 *  surface accounts that cannot sign in. */
export function getUsersAtStation(stationId) {
  if (!stationId) return Promise.resolve([]);
  return cached(`users:station:${stationId}`, async () => {
    const snap = await getDocs(query(
      collection(getDb(), 'users'),
      where('stationIds', 'array-contains', stationId),
    ));
    return snapToArray(snap).filter(u => u.status !== 'disabled' && u.status !== 'invited');
  });
}

/**
 * Staff a manager/admin may roster onto pumps at this station.
 *
 * Queried by station rather than by creator: a Station Admin must be able to
 * roster staff that one of their Managers created, and vice versa. Falls back
 * to the creator-scoped query if the station query is denied by rules that
 * have not been re-published yet.
 */
export async function getStaffForStation(stationId) {
  const me = getCurrentUserData();
  if (!stationId || !me || !can('config.view')) return [];

  const onlyStaffHere = users => users
    .filter(user => user.role === 'staff' && (user.stationIds || []).includes(stationId))
    .sort(byDisplayName);

  try {
    return onlyStaffHere(await getUsersAtStation(stationId));
  } catch {
    const fallback = me.role === 'superadmin'
      ? await getAllUsers().catch(() => [])
      : await getUsersCreatedBy(me.uid).catch(() => []);
    return onlyStaffHere(fallback);
  }
}
