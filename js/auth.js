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

function notify() {
  authListeners.forEach(fn => fn(currentUser, currentUserData, currentAuthError));
}

// ── Init ────────────────────────────────────────────────────────────────
export function initAuth() {
  const { auth, db } = initMainApp(FIREBASE_CONFIG);

  onAuthStateChanged(auth, async (user) => {
    currentUser = user;
    currentAuthError = null;

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
  return isSuperAdmin() || isStationAdmin() || (isManager() && myStationIds().includes(stationId));
}

// ── Pump assignments (staff only) ─────────────────────────────────────
// Admins/Managers see and manage every pump. Staff may be restricted to an
// explicit list of pump ids on their profile; an EMPTY list means
// "unrestricted" (every pump at their assigned stations), which keeps
// existing staff accounts working until an admin assigns specific pumps.
export function myPumpIds() {
  return currentUserData?.pumpIds || [];
}

export function hasPumpRestriction() {
  return isStaff() && myPumpIds().length > 0;
}

export function canUsePump(pumpId) {
  if (!pumpId) return false;
  if (!isStaff()) return true;
  const assigned = myPumpIds();
  return assigned.includes(pumpId);
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
      return stationOk && (superAdmin || stationAdmin || manager || canUsePump(ctx.pumpId));
    case 'pumpSession.end':
      // An active owner may finish a session even if an admin removed the
      // assignment while it was in progress. Firestore still verifies the
      // activeUid on the atomic clock-out transaction.
      return stationOk && (superAdmin || stationAdmin || manager || canUsePump(ctx.pumpId) || ctx.activeUid === me.uid);
    case 'pumpSession.forceRelease':
      return (superAdmin || stationAdmin || manager) && stationOk;

    // Reports deliberately allow Staff to access their own data. The page
    // never offers them an employee picker, and Firestore scopes their reads.
    case 'report.view':
      return stationOk && (superAdmin || stationAdmin || manager || isStaff());
    case 'report.viewOthers':
      return (superAdmin || stationAdmin || manager) && stationOk;
    case 'station.reset':
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

  if (action === 'user.update' || action === 'user.delete') {
    if (target?.id === me.uid) return 'You cannot modify your own account here.';
    if (action === 'user.delete' && target?.role === 'superadmin') return 'Super Admin accounts are protected.';
    if (me.role === 'stationadmin') return 'Station Admins can only manage staff they created.';
    if (me.role === 'manager') return 'Managers can only manage staff they created.';
  }
  if (action.startsWith('rate.')) return 'Rates are controlled by Managers and Admins only.';
  if (action.startsWith('pump.')) return 'Only Managers and Admins can configure pumps.';
  if (action === 'station.reset') return 'Only station managers can reset station data.';
  if (action === 'report.viewOthers') return 'Staff can only view their own report card.';
  if (action.startsWith('station.')) return 'Only a Super Admin can manage stations.';
  if (action.startsWith('pumpSession.')) return 'Only the active staff member or a station manager can do this.';
  return 'Your role does not allow this action.';
}
