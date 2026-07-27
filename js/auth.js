/* PumpLog — Authentication + RBAC
 *
 * Roles
 *   superadmin   — full control over stations, rates, pumps, shifts, users
 *   stationadmin — manages rates/pumps/shifts and staff for assigned stations
 *   staff        — reads assigned stations, logs shift readings
 *
 * `can(action, ctx)` is the single source of truth for the UI. The identical
 * logic is mirrored in firestore.rules, which is the source of truth on the
 * server — the UI checks only decide what to render.
 */

import {
  FIREBASE_CONFIG,
  initMainApp,
  getDb,
  getAdminApp,
  destroyAdminApp,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signOut,
  doc,
  getDoc,
  setDoc,
  updateDoc,
  deleteDoc,
  serverTimestamp,
  writeBatch,
} from './firebase.js';

export const ROLES = {
  superadmin: 'Super Admin',
  stationadmin: 'Station Admin',
  staff: 'Staff',
};

export const ROLE_BADGE = {
  superadmin: '🔶',
  stationadmin: '🔷',
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
      console.error('Auth/profile setup error:', err);
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
  if (snap.exists()) return { uid: user.uid, ...snap.data() };
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
export function formatFirebaseError(err) {
  const code = err?.code || '';
  const raw = err?.message || '';

  const map = {
    'auth/email-already-in-use': 'An account with this email already exists. Use “Sign in” instead.',
    'auth/invalid-email': 'Please enter a valid email address.',
    'auth/missing-password': 'Please enter your password.',
    'auth/weak-password': 'Password is too weak — use at least 6 characters.',
    'auth/invalid-credential': 'Email or password is incorrect.',
    'auth/wrong-password': 'Email or password is incorrect.',
    'auth/user-not-found': 'Email or password is incorrect.',
    'auth/user-disabled': 'This account has been disabled in Firebase Authentication.',
    'auth/too-many-requests': 'Too many attempts. Wait a few minutes and try again.',
    'auth/network-request-failed': 'Network error. Check your connection and try again.',
    'auth/operation-not-allowed': 'Email/password sign-in is disabled. Enable it in Firebase Console → Authentication → Sign-in method.',
    'permission-denied': 'Firestore denied this action. Publish the latest firestore.rules in Firebase Console → Firestore → Rules, then retry.',
    'unavailable': 'Firestore is unreachable right now. Check your connection and retry.',
    'failed-precondition': 'Firestore needs an index for this query. Open the browser console and follow the “create index” link.',
    'not-found': 'That record no longer exists — it may have been deleted already.',
    'already-exists': 'That record already exists.',
  };

  if (map[code]) return map[code];
  if (raw.includes('Missing or insufficient permissions')) return map['permission-denied'];
  if (raw.includes('requires an index')) return map['failed-precondition'];
  return raw || 'Something went wrong. Please try again.';
}

// ── Session ─────────────────────────────────────────────────────────────
export const signIn = (email, password) =>
  signInWithEmailAndPassword(initMainApp().auth, email, password);

export const signUp = (email, password) =>
  createUserWithEmailAndPassword(initMainApp().auth, email, password);

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
export const isStaff = () => currentUserData?.role === 'staff';

export function myStationIds() {
  return currentUserData?.stationIds || [];
}

export function canAccessStation(stationId) {
  if (!currentUserData || !stationId) return false;
  return isSuperAdmin() || myStationIds().includes(stationId);
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
  return assigned.length === 0 || assigned.includes(pumpId);
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
  const stationOk = superAdmin || (!!stationId && myStationIds().includes(stationId));

  switch (action) {
    // ── Stations (Super Admin only) ────────────────────────────────
    case 'station.create':
    case 'station.update':
    case 'station.delete':
      return superAdmin;
    case 'station.read':
      return stationOk;

    // ── Rates & pumps ──────────────────────────────────────────────
    case 'rate.create':
    case 'rate.update':
    case 'rate.delete':
    case 'pump.create':
    case 'pump.update':
    case 'pump.delete':
      return (superAdmin || stationAdmin) && stationOk;

    // ── Shifts and live pump sessions ──────────────────────────────
    case 'shift.create':
      return stationOk;
    case 'shift.update':
    case 'shift.delete':
      return (superAdmin || stationAdmin) && stationOk;
    case 'pumpSession.start':
      return stationOk && (superAdmin || stationAdmin || canUsePump(ctx.pumpId));
    case 'pumpSession.end':
      return stationOk && (superAdmin || stationAdmin || canUsePump(ctx.pumpId));
    case 'pumpSession.forceRelease':
      return (superAdmin || stationAdmin) && stationOk;

    // Reports deliberately allow Staff to access their own data. The page
    // never offers them an employee picker, and Firestore scopes their reads.
    case 'report.view':
      return stationOk && (superAdmin || stationAdmin || isStaff());
    case 'report.viewOthers':
      return (superAdmin || stationAdmin) && stationOk;
    case 'station.reset':
      return (superAdmin || stationAdmin) && stationOk;

    // ── Config page access ─────────────────────────────────────────
    case 'config.view':
      return superAdmin || stationAdmin;
    case 'team.view':
      return superAdmin || stationAdmin;

    // ── Users ──────────────────────────────────────────────────────
    case 'user.create':
      return superAdmin || stationAdmin;

    case 'user.update':
      if (!target) return false;
      // Nobody edits their own role/stations from the team list —
      // prevents an admin locking themselves out by accident.
      if (target.id === me.uid) return false;
      if (superAdmin) return true;
      // Station Admin manages only the staff accounts they created.
      return stationAdmin && target.role === 'staff' && target.createdBy === me.uid;

    case 'user.delete':
      if (!target) return false;
      if (target.id === me.uid) return false;                 // never delete yourself
      if (target.role === 'superadmin') return false;          // super admins are protected
      if (superAdmin) return true;
      return stationAdmin && target.role === 'staff' && target.createdBy === me.uid;

    // Which roles the current user may assign
    case 'user.assignRole.superadmin':
      return superAdmin;
    case 'user.assignRole.stationadmin':
      return superAdmin;
    case 'user.assignRole.staff':
      return superAdmin || stationAdmin;

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
  }
  if (action.startsWith('rate.')) return 'Rates are controlled by Managers and Admins only.';
  if (action.startsWith('pump.')) return 'Only Managers and Admins can configure pumps.';
  if (action === 'station.reset') return 'Only station managers can reset station data.';
  if (action === 'report.viewOthers') return 'Staff can only view their own report card.';
  if (action.startsWith('station.')) return 'Only a Super Admin can manage stations.';
  if (action.startsWith('pumpSession.')) return 'Only the active staff member or a station manager can do this.';
  return 'Your role does not allow this action.';
}

// ── Admin user management ───────────────────────────────────────────────
export async function createUserAsAdmin(email, password, role, stationIds, pumpIds = []) {
  if (!can('user.create')) throw new Error('You do not have permission to create users.');
  if (!can(`user.assignRole.${role}`)) throw new Error(`You cannot assign the ${ROLES[role] || role} role.`);

  const db = getDb();
  const admin = getAdminApp(FIREBASE_CONFIG);

  try {
    const cred = await createUserWithEmailAndPassword(admin.auth, email, password);
    const profile = {
      email,
      role,
      stationIds: stationIds || [],
      createdBy: currentUser?.uid || 'unknown',
      createdAt: serverTimestamp(),
    };
    // Only persist an explicit restriction (see updateUserAsAdmin note).
    if (role === 'staff' && Array.isArray(pumpIds) && pumpIds.length > 0) {
      profile.pumpIds = pumpIds;
    }
    await setDoc(doc(db, 'users', cred.user.uid), profile);
    return cred.user.uid;
  } finally {
    await signOut(admin.auth).catch(() => {});
    await destroyAdminApp();
  }
}

export async function updateUserAsAdmin(target, { role, stationIds, pumpIds }) {
  if (!can('user.update', { target })) {
    throw new Error(denyReason('user.update', { target }));
  }
  if (role && role !== target.role && !can(`user.assignRole.${role}`)) {
    throw new Error(`You cannot assign the ${ROLES[role] || role} role.`);
  }

  const patch = { updatedAt: serverTimestamp(), updatedBy: currentUser?.uid || 'unknown' };
  if (role) patch.role = role;
  if (Array.isArray(stationIds)) patch.stationIds = stationIds;
  // Write pumpIds only when it carries meaning: a non-empty restriction, or
  // clearing one that existed. Skipping the field otherwise keeps plain
  // role/station edits working even before the updated rules are published.
  if (Array.isArray(pumpIds) && (pumpIds.length > 0 || (target.pumpIds || []).length > 0)) {
    patch.pumpIds = pumpIds;
  }

  await updateDoc(doc(getDb(), 'users', target.id), patch);
}

/* Removes the Firestore profile, which revokes all app access immediately
 * (every rule requires a profile document). The Firebase Auth credential
 * itself can only be removed with the Admin SDK or from the Firebase Console,
 * so the UI states this explicitly. */
export async function deleteUserAsAdmin(target) {
  if (!can('user.delete', { target })) {
    throw new Error(denyReason('user.delete', { target }));
  }
  await deleteDoc(doc(getDb(), 'users', target.id));
}
