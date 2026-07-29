/* PumpLog — Authentication + RBAC
 *
 * Roles (hierarchy, highest → lowest)
 *   superadmin    — full control over stations, rates, pumps, shifts, users
 *   stationadmin  — manages rates/pumps/shifts and staff for assigned stations;
 *                   can also create managers for their stations
 *   manager       — Station Manager: same operational powers as stationadmin
 *                   (pumps, rates, shifts, shift approvals, staff they create)
 *                   EXCEPT cannot create/edit/delete stations, cannot create
 *                   other managers or station admins, and only manages staff
 *                   they personally created
 *   staff         — reads assigned stations, logs shift readings on assigned
 *                   pumps, and reads only their own shift records
 *
 * `can(action, ctx)` is the single source of truth for the UI. The identical
 * logic is mirrored in firestore.rules, which is the source of truth on the
 * server — the UI checks only decide what to render.
 */

import {
  FIREBASE_CONFIG,
  initMainApp,
  getAuthInstance,
  onAuthStateChanged,
  signOut,
  doc,
  getDoc,
  setDoc,
  serverTimestamp,
  writeBatch,
  onSnapshot,
} from './firebase.js';

export const ROLES = {
  superadmin: 'Super Admin',
  stationadmin: 'Station Admin',
  manager: 'Station Manager',
  staff: 'Staff',
};

export const ROLE_BADGE = {
  superadmin: '🔶',
  stationadmin: '🔷',
  manager: '🟢',
  staff: '⚪',
};

let currentUser = null;
let currentUserData = null;
let currentAuthError = null;
let authListeners = [];
let authReady = false;
let profileUnsub = null;

function notify() {
  authListeners.forEach(fn => fn(currentUser, currentUserData, currentAuthError));
}

/**
 * Keep the in-memory profile in sync with Firestore.
 *
 * Role, station, and pump assignments used to be read once at sign-in, so a
 * manager assigning a pump meant the staff member had to sign out and back in
 * before the app would let them start a shift. Watching the document makes
 * assignment changes land within a second on every open device.
 */
function watchMyProfile(uid, db) {
  profileUnsub?.();
  profileUnsub = onSnapshot(doc(db, 'users', uid), (snap) => {
    if (!snap.exists() || currentUser?.uid !== uid) return;
    const next = { uid, ...snap.data() };
    const changed = JSON.stringify(next) !== JSON.stringify(currentUserData);
    currentUserData = next;
    if (changed) {
      notify();
      window.dispatchEvent(new CustomEvent('pumplog:profileChanged'));
    }
  }, () => { /* transient listen failure — the cached profile stays usable */ });
}

function stopProfileWatch() {
  profileUnsub?.();
  profileUnsub = null;
}

// ── Init ────────────────────────────────────────────────────────────────
export function initAuth() {
  const { auth, db } = initMainApp(FIREBASE_CONFIG);

  onAuthStateChanged(auth, async (user) => {
    currentUser = user;
    currentAuthError = null;
    stopProfileWatch();
    clearMyDailyPumps();

    try {
      currentUserData = user ? await loadOrCreateUserProfile(user, db) : null;
    } catch (err) {
      currentUserData = null;
      currentAuthError = err;
      authReady = true;
      notify();
      // Auth succeeded but the profile could not be read/created. Sign out so
      // the next attempt starts from a clean auth-state cycle.
      if (user && auth.currentUser?.uid === user.uid) {
        await signOut(auth).catch(() => {});
      }
      return;
    }

    if (user && currentUserData) watchMyProfile(user.uid, db);

    authReady = true;
    notify();
  });

  return { auth, db };
}

// ── Profile bootstrap ───────────────────────────────────────────────────
async function loadOrCreateUserProfile(user, db) {
  const userRef = doc(db, 'users', user.uid);
  const snap = await getDoc(userRef);
  if (snap.exists()) {
    const profile = { uid: user.uid, ...snap.data() };
    if (profile.status === 'disabled') {
      const disabled = new Error('This account has been disabled. Contact your admin.');
      disabled.code = 'auth/user-disabled';
      throw disabled;
    }
    return profile;
  }
  return createBootstrapProfile(user, db, userRef);
}

async function createBootstrapProfile(user, db, userRef) {
  // Static hosting has no server, so the first signup claims Super Admin by
  // creating app/bootstrap in the same batch. Later signups default to Staff
  // with no station access until an admin assigns them.
  const bootstrapRef = doc(db, 'app', 'bootstrap');
  const bootstrapSnap = await getDoc(bootstrapRef);
  const isFirst = !bootstrapSnap.exists();

  // Note: `pumpIds` is intentionally omitted here so sign-up keeps working
  // even before the updated firestore.rules (which allow the new field) are
  // published. A missing pumpIds means "unrestricted — all pumps".
  const data = {
    email: user.email,
    role: isFirst ? 'superadmin' : 'staff',
    stationIds: [],
    status: 'active',
    pwaLoginAllowed: true,
    createdBy: isFirst ? user.uid : 'system',
    createdAt: serverTimestamp(),
  };

  if (isFirst) {
    const batch = writeBatch(db);
    batch.set(userRef, data);
    batch.set(bootstrapRef, { uid: user.uid, email: user.email, createdAt: serverTimestamp() });
    await batch.commit();
  } else {
    await setDoc(userRef, data);
  }

  return { ...data, uid: user.uid };
}

// ── Friendly errors ─────────────────────────────────────────────────────
// Production rule: never show a raw stack or SDK message to end users. Map
// Firebase Auth/Firestore errors to safe text.
export function formatFirebaseError(err) {
  const code = err?.code || '';
  const raw = String(err?.message || '');

  const map = {
    'auth/email-already-in-use': 'Email already registered.',
    'auth/invalid-email': 'Please enter a valid email address.',
    'auth/missing-password': 'Please enter your Cloud PIN.',
    'auth/weak-password': 'Cloud PIN does not meet the policy requirements.',
    'auth/invalid-credential': 'Email or Cloud PIN is incorrect.',
    'auth/wrong-password': 'Email or Cloud PIN is incorrect.',
    'auth/user-not-found': 'That account is not registered.',
    'auth/user-disabled': 'This account has been disabled. Contact your admin.',
    'auth/too-many-requests': 'Too many attempts. Wait a few minutes and try again.',
    'auth/requires-recent-login': 'For your security, sign in again and retry.',
    'auth/network-request-failed': 'Network error. Check your connection and try again.',
    'auth/operation-not-allowed': 'This sign-in method is not available. Contact your admin.',
    'permission-denied': 'You do not have permission to do that.',
    'unavailable': 'The service is unreachable right now. Check your connection and retry.',
    'failed-precondition': 'This action is not available in the current state.',
    'not-found': 'That record no longer exists — it may have been deleted already.',
    'already-exists': 'That record already exists.',
  };

  if (map[code]) return map[code];
  if (raw.includes('Missing or insufficient permissions')) return map['permission-denied'];
  if (raw.includes('requires an index')) return 'This view needs a Firestore index. Ask your Firebase admin to create it from the console link.';
  return 'Something went wrong. Please try again.';
}

// ── Session ─────────────────────────────────────────────────────────────
export const doSignOut = () => signOut(initMainApp().auth);

// ── State accessors ─────────────────────────────────────────────────────
export const getCurrentUser = () => currentUser;
export const getCurrentUserData = () => currentUserData;
export const getCurrentAuthError = () => currentAuthError;
export const isAuthReady = () => authReady;

export function onAuthChange(fn) {
  authListeners.push(fn);
  if (authReady) fn(currentUser, currentUserData, currentAuthError);
  return () => { authListeners = authListeners.filter(f => f !== fn); };
}

export const hasRole = (...roles) => !!currentUserData && roles.includes(currentUserData.role);
export const isSuperAdmin = () => currentUserData?.role === 'superadmin';
export const isStationAdmin = () => currentUserData?.role === 'stationadmin';
export const isManager = () => currentUserData?.role === 'manager';
export const isStaff = () => currentUserData?.role === 'staff';

/** True for any role that can manage station operations (not owner-gated). */
export const isStationOverseer = () => currentUserData && (isSuperAdmin() || isStationAdmin() || isManager());

/** Best available display name for a user record. Falls back: fullName → firstName+lastName → email */
export function userDisplayName(userData) {
  if (!userData) return 'Staff';
  if (userData.fullName) return userData.fullName;
  if (userData.firstName || userData.lastName) return [userData.firstName, userData.lastName].filter(Boolean).join(' ');
  if (userData.email) return userData.email.split('@')[0];
  return 'Staff';
}

export function myStationIds() {
  return currentUserData?.stationIds || [];
}

export function canAccessStation(stationId) {
  if (!currentUserData || !stationId) return false;
  return isSuperAdmin() || myStationIds().includes(stationId);
}

/** True when the signed-in user has operational management power over a
 *  station (pumps, rates, shifts, approvals, force-release, reset). */
export function canManageStation(stationId) {
  if (!currentUserData || !stationId) return false;
  return isSuperAdmin()
    || ((isStationAdmin() || isManager()) && myStationIds().includes(stationId));
}

// ── Pump assignments ──────────────────────────────────────────────────
//
// There are two layers, and a staff member may use a pump through EITHER:
//
//   1. Daily assignment  — the Kanban board writes
//      `stations/{id}/assignments/{date}_{pumpId}.staffUids`. This is the
//      day-to-day roster a manager rebuilds each morning.
//   2. Standing assignment — `users/{uid}.pumpIds`, a long-lived list set
//      from Config → Team. Useful for stations that never change the roster.
//
// If a staff member has NEITHER for the day, they are unrestricted (every
// pump at their assigned stations). That matches firestore.rules and is what
// keeps a freshly created account able to work before anyone touches the
// board — the old behaviour of "empty list = no pumps at all" locked staff
// out of Start/End shift entirely.
//
// The daily set is page-supplied because rendering is synchronous: pages load
// the day's assignments, publish them here, then render.

let dailyPumpIds = [];
let dailyPumpDate = null;

/** Publish the signed-in user's pump ids for `date` (from the board). */
export function setMyDailyPumps(pumpIds, date = null) {
  dailyPumpIds = [...new Set((pumpIds || []).filter(Boolean))];
  dailyPumpDate = date;
}

export function clearMyDailyPumps() {
  dailyPumpIds = [];
  dailyPumpDate = null;
}

export const myDailyPumpIds = () => [...dailyPumpIds];
export const myDailyPumpDate = () => dailyPumpDate;

export function myPumpIds() {
  return currentUserData?.pumpIds || [];
}

/** True when some assignment layer narrows this staff member's pump list. */
export function hasPumpRestriction() {
  return isStaff() && (dailyPumpIds.length > 0 || myPumpIds().length > 0);
}

/** Why a staff member can see the pumps they see — drives the page hint. */
export function pumpAccessMode() {
  if (!isStaff()) return 'all';
  if (dailyPumpIds.length > 0) return 'daily';
  if (myPumpIds().length > 0) return 'standing';
  return 'unrestricted';
}

export function canUsePump(pumpId) {
  if (!pumpId) return false;
  if (!isStaff()) return true;              // overseers work every pump
  if (dailyPumpIds.includes(pumpId)) return true;
  const standing = myPumpIds();
  if (standing.includes(pumpId)) return true;
  // No roster entry for today and no standing list — nothing restricts them.
  return dailyPumpIds.length === 0 && standing.length === 0;
}

/** The subset of `pumps` the signed-in user is allowed to see/use. */
export function filterMyPumps(pumps) {
  return (pumps || []).filter(p => canUsePump(p.id));
}

// ═══════════════════════════════════════════════════════════════════════
//  RBAC — one place that decides who may do what
// ═══════════════════════════════════════════════════════════════════════
//
//  can('rate.update', { stationId })
//  can('user.delete', { target: userRecord })
//
export function can(action, ctx = {}) {
  const me = currentUserData;
  if (!me) return false;

  const { stationId, target } = ctx;
  const superAdmin = me.role === 'superadmin';
  const stationAdmin = me.role === 'stationadmin';
  const manager = me.role === 'manager';
  const stationOk = superAdmin || (!!stationId && myStationIds().includes(stationId));

  switch (action) {
    // ── Stations (Super Admin only) ────────────────────────────────
    case 'station.create':
    case 'station.update':
    case 'station.delete':
      return superAdmin;
    case 'station.read':
      return stationOk;

    // ── Rates & pumps (open to manager) ────────────────────────────
    case 'rate.create':
    case 'rate.update':
    case 'rate.delete':
    case 'pump.create':
    case 'pump.update':
    case 'pump.delete':
      return (superAdmin || stationAdmin || manager) && stationOk;

    // ── Shifts and live pump sessions (open to manager) ────────────
    case 'shift.create':
      return stationOk;
    case 'shift.update':
    case 'shift.delete':
      return (superAdmin || stationAdmin || manager) && stationOk;
    case 'pumpSession.start':
      // Staff need station access plus a pump they may use. `canUsePump`
      // already treats "no assignment anywhere" as unrestricted, so a staff
      // member is never locked out of every pump by default.
      return stationOk && (superAdmin || stationAdmin || manager || canUsePump(ctx.pumpId));
    case 'pumpSession.end':
      // An active owner may finish a session even if an admin removed the
      // assignment while it was in progress. Firestore still verifies the
      // activeUid on the atomic clock-out transaction.
      return stationOk && (superAdmin || stationAdmin || manager || canUsePump(ctx.pumpId) || ctx.activeUid === me.uid);
    // Daily pump roster (the Kanban board) — overseers only.
    case 'assignment.view':
      return stationOk;
    case 'assignment.manage':
      return (superAdmin || stationAdmin || manager) && stationOk;
    case 'pumpSession.forceRelease':
      return (superAdmin || stationAdmin || manager) && stationOk;

    // Reports deliberately allow Staff to access their own data. The page
    // never offers them an employee picker, and Firestore scopes their reads.
    case 'report.view':
      return stationOk && (superAdmin || stationAdmin || manager || isStaff());
    case 'report.viewOthers':
      return (superAdmin || stationAdmin || manager) && stationOk;
    case 'station.reset':
    case 'stationSecurity.update':
      return (superAdmin || stationAdmin || manager) && stationOk;

    // ── Config page access (open to manager) ───────────────────────
    case 'config.view':
      return superAdmin || stationAdmin || manager;
    case 'team.view':
      return superAdmin || stationAdmin || manager;

    // ── Users ──────────────────────────────────────────────────────
    case 'user.create':
      return superAdmin || stationAdmin || manager;

    case 'user.update':
      if (!target) return false;
      // Nobody edits their own role/stations from the team list —
      // prevents an admin locking themselves out by accident.
      if (target.id === me.uid) return false;
      if (superAdmin) return true;
      // Station Admin manages only the staff accounts they created.
      if (stationAdmin && target.role === 'staff' && target.createdBy === me.uid) return true;
      // Manager manages only the staff accounts they created.
      if (manager && target.role === 'staff' && target.createdBy === me.uid) return true;
      return false;

    case 'user.delete':
      if (!target) return false;
      if (target.id === me.uid) return false;                 // never delete yourself
      if (target.role === 'superadmin') return false;          // super admins are protected
      if (target.role === 'stationadmin') return manager ? false : false; // only superadmin (checked below)
      if (target.role === 'manager') return manager ? false : false;        // only superadmin/stationadmin
      if (superAdmin) return true;
      if (stationAdmin && target.role === 'staff' && target.createdBy === me.uid) return true;
      if (manager && target.role === 'staff' && target.createdBy === me.uid) return true;
      return false;

    // Which roles the current user may assign
    case 'user.assignRole.superadmin':
      return superAdmin;
    case 'user.assignRole.stationadmin':
      return superAdmin;
    case 'user.assignRole.manager':
      return superAdmin || stationAdmin;
    case 'user.assignRole.staff':
      return superAdmin || stationAdmin || manager;

    default:
      return false;
  }
}

// Roles the signed-in user is allowed to grant.
export function assignableRoles() {
  return Object.keys(ROLES).filter(r => can(`user.assignRole.${r}`));
}

// Explains *why* an action is unavailable — surfaced as a tooltip in the UI.
export function denyReason(action, ctx = {}) {
  const me = currentUserData;
  if (!me) return 'You are signed out.';
  const { target } = ctx;

  if (action === 'pumpSession.end') {
    if (ctx.activeUid && ctx.activeUid !== me.uid && !canManageStation(ctx.stationId)) {
      return 'Another person is using this pump. Only they or a station manager can end the shift.';
    }
    return "This shift isn't showing as yours anymore. Refresh the page and try again.";
  }

  if (action === 'user.update' || action === 'user.delete') {
    if (target?.id === me.uid) return 'You cannot modify your own account here.';
    if (action === 'user.delete' && target?.role === 'superadmin') return 'Super Admin accounts are protected.';
    if (me.role === 'stationadmin') return 'Station Admins can only manage staff they created.';
    if (me.role === 'manager') return 'Managers can only manage staff they created.';
  }
  if (action.startsWith('rate.')) return 'Rates are controlled by Managers and Admins only.';
  if (action.startsWith('pump.')) return 'Only Managers and Admins can configure pumps.';
  if (action.startsWith('assignment.')) return 'Only Managers and Admins can change who works on each pump.';
  if (action === 'station.reset') return 'Only station managers can reset station data.';
  if (action === 'stationSecurity.update') return 'Only Managers and Admins can change station security.';
  if (action === 'report.viewOthers') return 'Staff can only view their own report card.';
  if (action.startsWith('station.')) return 'Only a Super Admin can manage stations.';
  if (action.startsWith('pumpSession.')) return 'Only the active staff member or a station manager can do this.';
  return 'Your role does not allow this action.';
}

/**
 * Permission-aware markup helper. Keep visibility decisions beside `can()` so
 * a page cannot accidentally show a control that Firestore will reject.
 */
export function ifCan(action, ctx = {}, html = '') {
  return can(action, ctx) ? html : '';
}

/**
 * Apply the same permission decision to an element that already exists.
 * Hiding is the default: unavailable controls should not become dead ends.
 */
export function applyPermission(el, action, ctx = {}, { hide = true } = {}) {
  if (!el) return false;
  const allowed = can(action, ctx);
  if (hide) {
    el.hidden = !allowed;
  } else {
    el.disabled = !allowed;
    el.setAttribute('aria-disabled', String(!allowed));
  }
  if (!allowed) el.title = denyReason(action, ctx);
  else if (el.title === denyReason(action, ctx)) el.removeAttribute('title');
  return allowed;
}
