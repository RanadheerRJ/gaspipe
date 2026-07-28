/* PumpLog — client-only Firebase Auth helpers
 *
 * Free Spark-plan mode: there are no callable Cloud Functions and no paid
 * backend API. The user's Cloud PIN is used as their Firebase Authentication
 * password through a deterministic app prefix, so the browser only talks to
 * Firebase Auth and Firestore.
 */

import {
  getDb,
  getAuthInstance,
  setAuthPersistence,
  getAdminApp,
  destroyAdminApp,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signOut,
  updatePassword,
  reauthenticateWithCredential,
  EmailAuthProvider,
  doc,
  getDoc,
  getDocs,
  setDoc,
  updateDoc,
  query,
  where,
  limit,
  collection,
  serverTimestamp,
} from './firebase.js';
import { DEFAULT_SECURITY } from './station-settings.js';

export const normalizeUsername = value => String(value || '').trim().toLowerCase();
const normalizeEmail = value => String(value || '').trim().toLowerCase();

function pinAuthPassword(pin) {
  const value = String(pin || '').trim();
  if (!/^\d{4,8}$/.test(value)) {
    const err = new Error('Cloud PIN must be 4–8 digits.');
    err.code = 'auth/invalid-credential';
    throw err;
  }
  // Firebase Auth requires passwords to be at least 6 characters. Prefixing
  // lets testers keep a short numeric PIN without storing a PIN in Firestore.
  return `pumplog-pin:${value}`;
}

function compact(value) {
  if (Array.isArray(value)) return value.filter(Boolean);
  return value == null ? '' : String(value).trim();
}

// ── Login screen ────────────────────────────────────────────────────────
export async function listPublicStations() {
  // The free client-only mode does not read station data before sign-in.
  return { stations: [] };
}

export async function resolveLoginIdentifier() {
  const err = new Error('Username sign-in is disabled in free mode. Use email + Cloud PIN.');
  err.code = 'auth/operation-not-allowed';
  throw err;
}

export async function signInWithEmailPin({ email, pin, remember = true }) {
  await setAuthPersistence(remember);
  const auth = getAuthInstance();
  const normalizedEmail = normalizeEmail(email);
  const password = pinAuthPassword(pin);
  let result;
  try {
    result = await signInWithEmailAndPassword(auth, normalizedEmail, password);
  } catch (err) {
    // First bootstrap users may have been created manually in Firebase Console
    // with the PIN itself as the password. Support that during testing; new
    // app-created users use the prefixed password above.
    if (!['auth/invalid-credential', 'auth/wrong-password'].includes(err?.code)) throw err;
    result = await signInWithEmailAndPassword(auth, normalizedEmail, String(pin || '').trim());
  }
  await recordLogin().catch(() => {});
  return result;
}

export async function signInWithUsernamePin() {
  const err = new Error('Username sign-in is disabled in free mode. Use email + Cloud PIN.');
  err.code = 'auth/operation-not-allowed';
  throw err;
}

// ── PIN lifecycle ───────────────────────────────────────────────────────
export async function getMyPinStatus() {
  const user = getAuthInstance().currentUser;
  if (!user) return null;
  const snap = await getDoc(doc(getDb(), 'users', user.uid));
  const profile = snap.exists() ? snap.data() : {};
  return {
    passwordResetRequired: false,
    pinResetRequired: profile.pin_reset_required === true,
    pinRotationRequired: false,
    policies: { ...DEFAULT_SECURITY },
  };
}

export async function changeCloudPin({ currentPin, newPin }) {
  const auth = getAuthInstance();
  const user = auth.currentUser;
  if (!user?.email) {
    const err = new Error('Sign in again before changing your Cloud PIN.');
    err.code = 'auth/requires-recent-login';
    throw err;
  }
  const credential = EmailAuthProvider.credential(user.email, pinAuthPassword(currentPin));
  try {
    await reauthenticateWithCredential(user, credential);
  } catch (err) {
    if (!['auth/invalid-credential', 'auth/wrong-password'].includes(err?.code)) throw err;
    await reauthenticateWithCredential(user, EmailAuthProvider.credential(user.email, String(currentPin || '').trim()));
  }
  await updatePassword(user, pinAuthPassword(newPin));
  await updateDoc(doc(getDb(), 'users', user.uid), {
    pin_reset_required: false,
    pinUpdatedAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
    updatedBy: user.uid,
  }).catch(() => {});
  return { ok: true };
}

export async function finishPasswordSetup() {
  const user = getAuthInstance().currentUser;
  if (!user) return { ok: false };
  await updateDoc(doc(getDb(), 'users', user.uid), {
    password_reset_required: false,
    updatedAt: serverTimestamp(),
    updatedBy: user.uid,
  }).catch(() => {});
  return { ok: true };
}

/** Stamp lastLogin after a successful sign-in. */
export async function recordLogin() {
  const user = getAuthInstance().currentUser;
  if (!user) return { ok: false };
  await updateDoc(doc(getDb(), 'users', user.uid), {
    lastLogin: serverTimestamp(),
  }).catch(() => {});
  return { ok: true };
}

export async function recordLogout() {
  const user = getAuthInstance().currentUser;
  if (!user) return { ok: false };
  await updateDoc(doc(getDb(), 'users', user.uid), {
    lastLogout: serverTimestamp(),
  }).catch(() => {});
  return { ok: true };
}

// ── Account administration ──────────────────────────────────────────────
export async function checkUsername(username) {
  const value = normalizeUsername(username);
  if (!value) return { available: true };
  const snap = await getDocs(query(collection(getDb(), 'users'), where('username', '==', value), limit(1)));
  return { available: snap.empty };
}

export async function createUserAccount(payload = {}) {
  const email = normalizeEmail(payload.email);
  const cloudPin = payload.temporaryCloudPin || payload.pin;
  const currentAdmin = getAuthInstance().currentUser;
  if (!currentAdmin) {
    const err = new Error('Sign in as an admin before creating users.');
    err.code = 'permission-denied';
    throw err;
  }

  const secondary = getAdminApp();
  let created;
  try {
    created = await createUserWithEmailAndPassword(secondary.auth, email, pinAuthPassword(cloudPin));
  } finally {
    await signOut(secondary.auth).catch(() => {});
    await destroyAdminApp().catch(() => {});
  }

  const uid = created.user.uid;
  const firstName = compact(payload.firstName);
  const lastName = compact(payload.lastName);
  const fullName = compact(payload.fullName) || [firstName, lastName].filter(Boolean).join(' ') || email;
  const username = normalizeUsername(payload.username) || email.split('@')[0].replace(/[^a-z0-9_.]/g, '.').slice(0, 16);
  const active = payload.active !== false && payload.status !== 'disabled';

  const profile = {
    email,
    username,
    firstName,
    lastName,
    fullName,
    role: payload.role || 'staff',
    stationIds: Array.isArray(payload.stationIds) ? payload.stationIds : [],
    pumpIds: Array.isArray(payload.pumpIds) ? payload.pumpIds : [],
    phoneNumber: compact(payload.phoneNumber),
    employeeId: compact(payload.employeeId),
    avatarUrl: compact(payload.avatarUrl),
    status: active ? 'active' : 'disabled',
    createdBy: currentAdmin.uid,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
    updatedBy: currentAdmin.uid,
    pin_reset_required: payload.mustChangePin === true,
    password_reset_required: false,
    pwaLoginAllowed: payload.allowPwaLogin !== false,
  };

  await setDoc(doc(getDb(), 'users', uid), profile);
  return {
    uid,
    id: uid,
    ...profile,
    fullName,
    mustChangePin: profile.pin_reset_required,
    mustChangePassword: false,
  };
}

export async function updateUserAccount(staffId, patch = {}) {
  const currentAdmin = getAuthInstance().currentUser;
  const next = {
    updatedAt: serverTimestamp(),
    updatedBy: currentAdmin?.uid || 'unknown',
  };
  for (const key of ['firstName', 'lastName', 'fullName', 'phoneNumber', 'employeeId', 'avatarUrl', 'role']) {
    if (key in patch) next[key] = compact(patch[key]);
  }
  if ('firstName' in patch || 'lastName' in patch) {
    next.fullName = [compact(patch.firstName), compact(patch.lastName)].filter(Boolean).join(' ');
  }
  if ('stationIds' in patch) next.stationIds = Array.isArray(patch.stationIds) ? patch.stationIds : [];
  if ('pumpIds' in patch) next.pumpIds = Array.isArray(patch.pumpIds) ? patch.pumpIds : [];
  if ('active' in patch) next.status = patch.active === false ? 'disabled' : 'active';
  if ('allowPwaLogin' in patch) next.pwaLoginAllowed = patch.allowPwaLogin !== false;
  await updateDoc(doc(getDb(), 'users', staffId), next);
  return { ok: true };
}

export async function adminSetPassword() {
  const err = new Error('Password resets are disabled in free mode. Users sign in with email + Cloud PIN only.');
  err.code = 'auth/operation-not-allowed';
  throw err;
}

export async function adminSetPin() {
  const err = new Error('Admin Cloud PIN resets are disabled in free mode. Ask the user to change their own Cloud PIN from Profile, or create a new account.');
  err.code = 'auth/operation-not-allowed';
  throw err;
}

export async function deactivateUserAccount(staffId) {
  await updateDoc(doc(getDb(), 'users', staffId), {
    status: 'disabled',
    updatedAt: serverTimestamp(),
    updatedBy: getAuthInstance().currentUser?.uid || 'unknown',
  });
  return { ok: true };
}

export async function removeUserAccount(staffId) {
  // Client SDK cannot delete another Firebase Auth credential. Keep the
  // profile disabled so Firestore rules deny app data and the user cannot
  // self-bootstrap a fresh profile with the same Auth account.
  return deactivateUserAccount(staffId);
}

// ── Legacy onboarding removed in free mode ──────────────────────────────
function unsupportedInvite() {
  const err = new Error('Invite/join-code onboarding is disabled in free mode. Create users from Config → Team with email + Cloud PIN.');
  err.code = 'auth/operation-not-allowed';
  throw err;
}

export const createAdminInvite = unsupportedInvite;
export const previewAdminInvite = unsupportedInvite;
export const activateAdminInvite = unsupportedInvite;
export const previewJoiningCode = unsupportedInvite;
export const activateStaff = unsupportedInvite;
