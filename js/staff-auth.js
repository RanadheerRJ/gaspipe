/* PumpLog — client-only Firebase Auth helpers
 *
 * Free Spark-plan mode: there are no callable Cloud Functions and no paid
 * backend API. The user's Cloud PIN is used as their Firebase Authentication
 * password through a deterministic app prefix, so the browser only talks to
 * Firebase Auth and Firestore.
 *
 * Account identity model (Spark plan):
 *   • Email accounts — email address is the Firebase Auth email; signs in
 *     with email + Cloud PIN. Admins can reset the PIN by sending a Firebase
 *     password-reset email; the user opens the link and chooses a new 4–8
 *     digit PIN themselves.
 *   • Phone-only accounts — created with just a phone number; the Firebase
 *     Auth email is the synthetic `phone:<digits>@pumplog.local`. Phone
 *     sign-in goes straight to this synthetic email — there is NO pre-auth
 *     Firestore lookup (which would be denied for signed-out readers).
 *     Because the synthetic address is not a real mailbox, password-reset
 *     email cannot reach it; to reset a phone-only PIN the admin adds an
 *     email address to the account (deactivates + recreates) or deactivates
 *     and creates a fresh account.
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
  sendPasswordResetEmail,
  confirmPasswordReset,
  verifyPasswordResetCode,
  EmailAuthProvider,
  doc,
  getDoc,
  setDoc,
  updateDoc,
  collection,
  serverTimestamp,
} from './firebase.js';
import { DEFAULT_SECURITY, normalizePhone, isValidPhone } from './station-settings.js';

export const normalizeUsername = value => String(value || '').trim().toLowerCase();
const normalizeEmail = value => String(value || '').trim().toLowerCase();
export const phoneAuthEmail = phone => `phone:${normalizePhone(phone)}@pumplog.local`;

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

async function signInWithAuthEmail(authEmail, pin, remember = true) {
  await setAuthPersistence(remember);
  const auth = getAuthInstance();

  // Try the prefixed PIN password, then the raw PIN (legacy testers who
  // created accounts before the prefix was introduced).
  const pwCandidates = [pinAuthPassword(pin), String(pin || '').trim()];

  let lastErr = null;
  for (const pw of pwCandidates) {
    try {
      const result = await signInWithEmailAndPassword(auth, authEmail, pw);
      await recordLogin().catch(() => {});
      return result;
    } catch (err) {
      lastErr = err;
      if (!['auth/invalid-credential', 'auth/wrong-password'].includes(err?.code)) throw err;
    }
  }
  throw lastErr || new Error('Sign-in failed.');
}

export async function signInWithEmailPin({ email, pin, remember = true }) {
  const normalized = normalizeEmail(email);
  if (!normalized) {
    const err = new Error('Enter your email address.');
    err.code = 'auth/invalid-email';
    throw err;
  }
  return signInWithAuthEmail(normalized, pin, remember);
}

export async function signInWithPhonePin({ phone, pin, remember = true }) {
  const normalized = normalizePhone(phone);
  if (!isValidPhone(normalized)) {
    const err = new Error('Enter a valid phone number including the country code (e.g. +919876543210).');
    err.code = 'auth/invalid-credential';
    throw err;
  }
  // Phone accounts authenticate against the synthetic phone:...@pumplog.local
  // Firebase Auth email. There is no pre-auth Firestore lookup because
  // signed-out readers cannot query the users collection.
  return signInWithAuthEmail(phoneAuthEmail(normalized), pin, remember);
}

export async function signInWithUsernamePin() {
  const err = new Error('Username sign-in is disabled in free mode. Use email or phone + Cloud PIN.');
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
  // Accept either the real prefixed password or the raw PIN.
  const credentialCandidates = [
    pinAuthPassword(currentPin),
    String(currentPin || '').trim(),
  ];
  let lastErr = null;
  for (const pw of credentialCandidates) {
    try {
      await reauthenticateWithCredential(user, EmailAuthProvider.credential(user.email, pw));
      lastErr = null;
      break;
    } catch (err) {
      lastErr = err;
    }
  }
  if (lastErr) throw lastErr;
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

// ── Admin PIN reset (Spark plan) ───────────────────────────────────────
//
// Firebase client SDK cannot rotate another user's Auth password. The
// server-side Admin SDK and Cloud Functions are unavailable on Spark plan.
// The workable, fully client-side reset mechanism is Firebase Auth's built-in
// password-reset email: the admin triggers `sendPasswordResetEmail` for the
// staff member's real email; Firebase emails a one-time link; the staff
// member opens the link which lands on `set-pin.html` (a custom reset page)
// where they pick a new 4–8 digit Cloud PIN directly. No temporary PIN is
// stored in Firestore and no force-change flag is required because the
// user chooses the new PIN themselves during the reset flow.

/** Send a password-reset email that links to our custom set-pin page. */
export async function sendPinResetEmail(email) {
  const normalized = normalizeEmail(email);
  if (!normalized) {
    const err = new Error('This account has no email address to send a reset link to.');
    err.code = 'invalid-argument';
    throw err;
  }
  const actionCodeSettings = {
    url: `${window.location.origin}${window.location.pathname.replace(/\/[^/]*$/, '')}/set-pin.html`,
    handleCodeInApp: false,
  };
  await sendPasswordResetEmail(getAuthInstance(), normalized, actionCodeSettings);
  return { ok: true, email: normalized };
}

/** Verify a reset oobCode and return the account email it belongs to. */
export async function verifyPinResetCode(code) {
  const email = await verifyPasswordResetCode(getAuthInstance(), code);
  return { email };
}

/** Finalize a PIN reset: confirm the oobCode and set the new PIN password. */
export async function completePinReset({ code, newPin }) {
  await confirmPasswordReset(getAuthInstance(), code, pinAuthPassword(newPin));
  return { ok: true };
}

// ── Account administration ──────────────────────────────────────────────
export async function checkUsername(username) {
  const value = normalizeUsername(username);
  if (!value) return { available: true };
  // Username list is admin-only in rules; skip client preflight and let
  // the rules surface any collisions at create time.
  return { available: true };
}

export async function createUserAccount(payload = {}) {
  let email = normalizeEmail(payload.email);
  const phone = normalizePhone(payload.phoneNumber);
  const usePhoneLogin = !email && !!phone;
  if (usePhoneLogin) email = phoneAuthEmail(phone);
  const cloudPin = payload.temporaryCloudPin || payload.pin;
  if (!cloudPin) {
    const err = new Error('A Cloud PIN is required to create an account.');
    err.code = 'invalid-argument';
    throw err;
  }
  const currentAdmin = getAuthInstance().currentUser;
  if (!currentAdmin) {
    const err = new Error('Sign in as an admin before creating users.');
    err.code = 'permission-denied';
    throw err;
  }
  if (!usePhoneLogin && !email) {
    const err = new Error('Provide either an email or a phone number to create an account.');
    err.code = 'invalid-argument';
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
  const fullName = compact(payload.fullName) || [firstName, lastName].filter(Boolean).join(' ') || (usePhoneLogin ? phone : email);
  const username = normalizeUsername(payload.username)
    || (usePhoneLogin ? '' : email.split('@')[0].replace(/[^a-z0-9_.]/g, '.').slice(0, 16));
  const active = payload.active !== false && payload.status !== 'disabled';

  const profile = {
    email: usePhoneLogin ? null : email,
    username: username || null,
    phoneNumber: usePhoneLogin ? phone : (compact(payload.phoneNumber) || null),
    firstName,
    lastName,
    fullName,
    role: payload.role || 'staff',
    stationIds: Array.isArray(payload.stationIds) ? payload.stationIds : [],
    pumpIds: Array.isArray(payload.pumpIds) ? payload.pumpIds : [],
    employeeId: compact(payload.employeeId),
    avatarUrl: compact(payload.avatarUrl),
    status: active ? 'active' : 'disabled',
    createdBy: currentAdmin.uid,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
    updatedBy: currentAdmin.uid,
    pin_reset_required: false,
    password_reset_required: false,
    pwaLoginAllowed: payload.allowPwaLogin !== false,
  };
  // Strip nulls so the field list matches firestore.rules userFieldsOk().
  for (const key of Object.keys(profile)) {
    if (profile[key] == null || profile[key] === '') delete profile[key];
  }

  await setDoc(doc(getDb(), 'users', uid), profile);
  return {
    uid,
    id: uid,
    ...profile,
    email: profile.email || null,
    fullName,
    mustChangePin: false,
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
  // Normalize phone if provided.
  if ('phoneNumber' in patch && next.phoneNumber) {
    const phone = normalizePhone(next.phoneNumber);
    if (!isValidPhone(phone)) {
      const err = new Error('Enter a valid phone number including the country code (e.g. +919876543210).');
      err.code = 'invalid-argument';
      throw err;
    }
    next.phoneNumber = phone;
  }
  if ('firstName' in patch || 'lastName' in patch) {
    next.fullName = [compact(patch.firstName), compact(patch.lastName)].filter(Boolean).join(' ');
  }
  if ('stationIds' in patch) next.stationIds = Array.isArray(patch.stationIds) ? patch.stationIds : [];
  if ('pumpIds' in patch) next.pumpIds = Array.isArray(patch.pumpIds) ? patch.pumpIds : [];
  if ('active' in patch) next.status = patch.active === false ? 'disabled' : 'active';
  if ('allowPwaLogin' in patch) next.pwaLoginAllowed = patch.allowPwaLogin !== false;
  // Drop keys explicitly set to null/empty for optional fields so rules
  // accept the patch. NOTE: `email` and the Firebase Auth identity cannot
  // be changed from the client SDK — add/remove login method requires
  // deactivating and recreating the account (documented in DEPLOYMENT.md).
  for (const key of ['phoneNumber', 'employeeId', 'avatarUrl']) {
    if (next[key] === '' || next[key] == null) delete next[key];
  }
  await updateDoc(doc(getDb(), 'users', staffId), next);
  return { ok: true };
}

export async function adminSetPassword() {
  const err = new Error('Password resets use the reset-email flow. Click “Reset PIN” next to the team member.');
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
