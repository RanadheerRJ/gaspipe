/* PumpLog trusted identity and account service.
 *
 * The static web app never receives PIN hashes, salts, joining-code records,
 * or rate-limit counters. These callable functions run with the Firebase
 * Admin SDK, use scrypt for Cloud PIN hashing, issue Firebase custom tokens,
 * and enforce station-level security policies on the server. Firestore rules
 * remain the authorization source of truth for application data once a token
 * is issued.
 *
 * Production surface
 *   Sign-in        loginWithUsernamePin · loginWithEmailPin (policy-enforced)
 *                  resolveLoginIdentifier (username → email for password sign-in)
 *                  listPublicStations (login-screen station picker)
 *   PIN lifecycle  changePin · getMyPinStatus · finishPasswordSetup
 *   Onboarding     createUserAccount (+ temporary password & Cloud PIN)
 *   Admin CRUD     updateUserAccount · adminSetPassword · adminSetPin
 *                  deleteUserAccount (deactivate / remove)
 *   Legacy flows   createStaff · previewJoiningCode · activateStaff
 *                  resetStaffPin · disableStaff · checkUsername
 *   Station Admin  createAdminInvite · previewAdminInvite · activateAdminInvite
 *   Audit          recordLogout + automatic audit logs for sensitive actions
 */

const crypto = require('node:crypto');
const { initializeApp } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');
const { FieldValue, Timestamp, getFirestore } = require('firebase-admin/firestore');
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { setGlobalOptions } = require('firebase-functions/v2/options');

initializeApp();
setGlobalOptions({ region: 'us-central1', maxInstances: 20, memory: '256MiB' });

const db = getFirestore();
const auth = getAuth();

const MAX_LOGIN_FAILURES = 5;
const LOCKOUT_MS = 15 * 60 * 1000;
const JOINING_CODE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const ADMIN_INVITE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const USERNAME_RE = /^[a-z0-9_.]{4,16}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const PHONE_RE = /^\+?[0-9 ()-]{7,20}$/;
const EMPLOYEE_ID_RE = /^[a-zA-Z0-9-]{1,40}$/;
const PIN_SEQUENCE = '0123456789';
const PIN_SEQUENCE_REVERSED = '9876543210';
const PIN_MIN = 4;
const PIN_MAX = 8;
const ROLES = ['superadmin', 'stationadmin', 'staff'];

const DEFAULT_SECURITY = {
  enableEmailLogin: true,
  enableUsernameLogin: true,
  enablePasswordLogin: true,
  enablePinLogin: true,
  appLockEnabled: false,
  minPasswordLength: 8,
  minPinLength: 4,
  passwordComplexity: 'lettersNumbers',
  pinComplexity: 'standard',
  pinRotationDays: 0,
};

class IdentityCollision extends Error {
  constructor() {
    super('Identity already exists.');
    this.code = 'identity-collision';
  }
}

function fail(code, message, details) {
  throw new HttpsError(code, message, details);
}

function requireAuth(request) {
  if (!request.auth?.uid) fail('unauthenticated', 'Sign in is required.');
  return request.auth.uid;
}

async function profileFor(uid) {
  const snap = await db.doc(`users/${uid}`).get();
  if (!snap.exists) fail('permission-denied', 'Your PumpLog profile is not available.');
  return { uid, ...snap.data() };
}

function isManager(profile) {
  return profile.role === 'superadmin' || profile.role === 'stationadmin';
}

// ── Station security policy (server copy of js/station-settings.js) ─────
function normalizeSecurity(raw = {}) {
  const merged = { ...DEFAULT_SECURITY, ...(raw || {}) };
  merged.enableEmailLogin = merged.enableEmailLogin !== false;
  merged.enableUsernameLogin = merged.enableUsernameLogin !== false;
  merged.enablePasswordLogin = merged.enablePasswordLogin !== false;
  merged.enablePinLogin = merged.enablePinLogin !== false;
  merged.appLockEnabled = merged.appLockEnabled === true;
  merged.minPasswordLength = Math.min(64, Math.max(6, Number.parseInt(merged.minPasswordLength, 10) || DEFAULT_SECURITY.minPasswordLength));
  merged.minPinLength = Math.min(PIN_MAX, Math.max(PIN_MIN, Number.parseInt(merged.minPinLength, 10) || DEFAULT_SECURITY.minPinLength));
  if (!['none', 'lettersNumbers', 'strong'].includes(merged.passwordComplexity)) merged.passwordComplexity = DEFAULT_SECURITY.passwordComplexity;
  if (!['digits', 'standard'].includes(merged.pinComplexity)) merged.pinComplexity = DEFAULT_SECURITY.pinComplexity;
  merged.pinRotationDays = Math.min(365, Math.max(0, Number.parseInt(merged.pinRotationDays, 10) || 0));
  return merged;
}

async function securityForStation(stationId) {
  try {
    const snap = await db.doc(`stations/${stationId}/settings/security`).get();
    return normalizeSecurity(snap.exists ? snap.data() : {});
  } catch (error) {
    console.error('Station security read failed', { stationId, error });
    return normalizeSecurity();
  }
}

/** Strictest-wins merge, mirroring the client. */
async function mergedSecurityForStations(stationIds = []) {
  const ids = [...new Set((stationIds || []).filter(Boolean))];
  if (!ids.length) return normalizeSecurity();
  const settings = await Promise.all(ids.map(securityForStation));
  const strongest = (values, order) => values.reduce((best, v) => (order.indexOf(v) > order.indexOf(best) ? v : best), order[0]);
  return {
    enableEmailLogin: settings.some(s => s.enableEmailLogin),
    enableUsernameLogin: settings.some(s => s.enableUsernameLogin),
    enablePasswordLogin: settings.some(s => s.enablePasswordLogin),
    enablePinLogin: settings.some(s => s.enablePinLogin),
    appLockEnabled: settings.some(s => s.appLockEnabled),
    minPasswordLength: Math.max(...settings.map(s => s.minPasswordLength)),
    minPinLength: Math.max(...settings.map(s => s.minPinLength)),
    passwordComplexity: strongest(settings.map(s => s.passwordComplexity), ['none', 'lettersNumbers', 'strong']),
    pinComplexity: strongest(settings.map(s => s.pinComplexity), ['digits', 'standard']),
    pinRotationDays: (() => { const days = settings.map(s => s.pinRotationDays).filter(d => d > 0); return days.length ? Math.min(...days) : 0; })(),
  };
}

/** The sign-in policy applied to a user: any one of their stations may allow. */
async function loginPolicyForUser(profile) {
  return mergedSecurityForStations(profile.stationIds || []);
}

function pinRotationRequired(policy, secret) {
  if (!policy?.pinRotationDays) return false;
  const changedAt = secret?.pinLastChangedAt?.toMillis?.() || 0;
  if (!changedAt) return false;
  return Date.now() - changedAt > policy.pinRotationDays * 24 * 60 * 60 * 1000;
}

// ── Rate limiting (Firestore-backed, per identifier) ────────────────────
async function checkRateLimit(bucket, key, maxAttempts, windowMs) {
  const safeKey = `${bucket}_${String(key || 'anon').replace(/[^a-zA-Z0-9@._-]/g, '_').slice(0, 120)}`;
  const ref = db.doc(`rateLimits/${safeKey}`);
  const result = await db.runTransaction(async transaction => {
    const snap = await transaction.get(ref);
    const now = Date.now();
    const data = snap.exists ? snap.data() : null;
    const windowStart = data?.windowStart?.toMillis?.() || 0;
    const attempts = Number(data?.attempts || 0);
    if (!windowStart || now - windowStart > windowMs) {
      transaction.set(ref, { attempts: 1, windowStart: Timestamp.fromMillis(now), updatedAt: Timestamp.fromMillis(now) });
      return { allowed: true, remaining: maxAttempts - 1 };
    }
    if (attempts >= maxAttempts) {
      transaction.update(ref, { updatedAt: Timestamp.fromMillis(now) });
      return { allowed: false, retryAfterMs: windowStart + windowMs - now };
    }
    transaction.update(ref, { attempts: attempts + 1, updatedAt: Timestamp.fromMillis(now) });
    return { allowed: true, remaining: maxAttempts - attempts - 1 };
  });
  if (!result.allowed) {
    fail('resource-exhausted', `Too many attempts. Try again in ${Math.ceil(result.retryAfterMs / 1000)} seconds.`);
  }
}

const callerKey = request => request.rawRequest?.ip || request.auth?.uid || 'anon';

// ── Validation helpers ──────────────────────────────────────────────────
function normalizeUsername(value) {
  return String(value || '').trim().toLowerCase();
}

function validateUsername(value) {
  const username = normalizeUsername(value);
  if (!USERNAME_RE.test(username)) {
    fail('invalid-argument', 'Usernames must be 4–16 characters using lowercase letters, numbers, underscores, or dots.');
  }
  return username;
}

function validateEmail(value) {
  const email = String(value || '').trim().toLowerCase();
  if (!EMAIL_RE.test(email) || email.length > 254) fail('invalid-argument', 'Enter a valid email address.');
  return email;
}

function validateNamePart(value, label) {
  const name = String(value || '').trim().replace(/\s+/g, ' ');
  if (!name || name.length > 50) fail('invalid-argument', `${label} is required (up to 50 characters).`);
  return name;
}

function validateFullName(value) {
  const fullName = String(value || '').trim().replace(/\s+/g, ' ');
  if (fullName.length < 1 || fullName.length > 80) fail('invalid-argument', 'Enter a full name up to 80 characters.');
  return fullName;
}

function validatePhone(value) {
  const phone = String(value || '').trim();
  if (!phone) return '';
  if (!PHONE_RE.test(phone) || phone.replace(/\D/g, '').length < 7 || phone.replace(/\D/g, '').length > 15) {
    fail('invalid-argument', 'Enter a valid phone number or leave it blank.');
  }
  return phone;
}

function validateEmployeeId(value) {
  const id = String(value || '').trim();
  if (!id) return '';
  if (!EMPLOYEE_ID_RE.test(id)) fail('invalid-argument', 'Employee ID may use letters, numbers, and dashes only.');
  return id;
}

function validateAvatarUrl(value) {
  const url = String(value || '').trim();
  if (!url) return '';
  if (url.length > 500 || !/^https:\/\//i.test(url)) fail('invalid-argument', 'Avatar must be an https:// image URL.');
  return url;
}

function validateRole(value, manager) {
  const role = String(value || '');
  if (!ROLES.includes(role)) fail('invalid-argument', 'Choose a valid role.');
  if (role !== 'staff' && manager.role !== 'superadmin') {
    fail('permission-denied', 'Only a Super Admin can create or assign manager roles.');
  }
  return role;
}

function validateStations(value, { allowEmpty = false } = {}) {
  if (!Array.isArray(value) || value.length > 50 || value.some(id => typeof id !== 'string' || !id)) {
    fail('invalid-argument', 'Station assignments are invalid.');
  }
  const ids = [...new Set(value)];
  if (!allowEmpty && ids.length < 1) fail('invalid-argument', 'Assign at least one valid station.');
  return ids;
}

function pinFormatError(pin, policy) {
  const value = String(pin || '');
  const min = policy?.minPinLength || PIN_MIN;
  if (!new RegExp(`^\\d{${min},${PIN_MAX}}$`).test(value)) {
    return `Cloud PIN must be ${min}–${PIN_MAX} digits.`;
  }
  if ((policy?.pinComplexity || 'standard') === 'standard') {
    if (/^(\d)\1+$/.test(value)) return 'Cloud PIN cannot be the same digit repeated.';
    if (value.length >= 4 && (PIN_SEQUENCE.includes(value) || PIN_SEQUENCE_REVERSED.includes(value))) {
      return 'Cloud PIN cannot be a simple sequence like 1234.';
    }
  }
  return null;
}

function validatePin(value, policy = DEFAULT_SECURITY) {
  const problem = pinFormatError(value, policy);
  if (problem) fail('invalid-argument', problem);
  return String(value);
}

function validatePassword(value, policy) {
  const password = String(value || '');
  const min = policy?.minPasswordLength || DEFAULT_SECURITY.minPasswordLength;
  if (password.length < min) fail('invalid-argument', `Password must be at least ${min} characters.`);
  if (policy?.passwordComplexity === 'lettersNumbers' && !(/[a-zA-Z]/.test(password) && /\d/.test(password))) {
    fail('invalid-argument', 'Password must contain both letters and numbers.');
  }
  if (policy?.passwordComplexity === 'strong'
    && !(/[a-z]/.test(password) && /[A-Z]/.test(password) && /\d/.test(password) && /[^a-zA-Z0-9]/.test(password))) {
    fail('invalid-argument', 'Password must include uppercase, lowercase, a number, and a symbol.');
  }
  return password;
}

function randomJoiningCode() {
  return String(crypto.randomInt(10000, 100000));
}

function randomAdminInviteCode() {
  return String(crypto.randomInt(1000000000, 10000000000));
}

// ── Cloud PIN hashing (scrypt, per-PIN salt) ────────────────────────────
function hashPin(pin) {
  const salt = crypto.randomBytes(16);
  return new Promise((resolve, reject) => {
    crypto.scrypt(pin, salt, 32, {
      cost: 16384,
      blockSize: 8,
      parallelization: 1,
      maxmem: 32 * 1024 * 1024,
    }, (error, derivedKey) => {
      if (error) return reject(error);
      resolve({
        pinHash: derivedKey.toString('hex'),
        pinSalt: salt.toString('hex'),
        pinAlgorithm: 'scrypt-N16384-r8-p1',
      });
    });
  });
}

async function verifyPin(pin, secret) {
  if (!secret?.pinHash || !secret?.pinSalt) return false;
  const salt = Buffer.from(secret.pinSalt, 'hex');
  const expected = Buffer.from(secret.pinHash, 'hex');
  const actual = await new Promise((resolve, reject) => {
    crypto.scrypt(pin, salt, expected.length, {
      cost: 16384,
      blockSize: 8,
      parallelization: 1,
      maxmem: 32 * 1024 * 1024,
    }, (error, derivedKey) => error ? reject(error) : resolve(derivedKey));
  });
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function safeProfile(profile) {
  const output = { ...profile };
  delete output.pinHash;
  delete output.pinSalt;
  delete output.pinAlgorithm;
  delete output.joiningCode;
  delete output.joiningCodeExpiresAt;
  return output;
}

function assertCanManageStations(manager, stationIds, { allowEmpty = false } = {}) {
  const ids = validateStations(stationIds, { allowEmpty });
  if (manager.role === 'stationadmin' && ids.some(id => !(manager.stationIds || []).includes(id))) {
    fail('permission-denied', 'You can only assign staff to your own stations.');
  }
  return ids;
}

async function assertCanManageTarget(manager, targetUid) {
  const target = await profileFor(targetUid);
  if (target.role !== 'staff' || !isManager(manager)) fail('permission-denied', 'Only staff accounts can be managed here.');
  if (manager.role === 'stationadmin') {
    if (target.createdBy !== manager.uid || !(target.stationIds || []).every(id => (manager.stationIds || []).includes(id))) {
      fail('permission-denied', 'You can only manage staff you created for your stations.');
    }
  }
  if (target.status === 'disabled') fail('failed-precondition', 'This staff account is disabled.');
  return target;
}

/** Target rules shared by account CRUD (staff and managers). */
function assertAccountTarget(manager, target) {
  if (target.uid === manager.uid) fail('permission-denied', 'You cannot manage your own account here.');
  if (manager.role === 'superadmin') return;
  if (manager.role === 'stationadmin'
    && target.role === 'staff'
    && target.createdBy === manager.uid
    && (target.stationIds || []).every(id => (manager.stationIds || []).includes(id))) return;
  fail('permission-denied', 'You do not have permission to manage this account.');
}

async function writeAudit({ actorUid = null, action, targetUid = null, metadata = {} }) {
  try {
    await db.collection('auditLogs').add({
      actorUid,
      action,
      targetUid,
      metadata,
      createdAt: FieldValue.serverTimestamp(),
    });
  } catch (error) {
    // A failed audit write must not turn a successful authentication action
    // into a duplicate retry. The operation is still visible in Functions logs.
    console.error('PumpLog audit write failed', { action, actorUid, targetUid, error });
  }
}

// ── Shared PIN sign-in core (username and email variants) ───────────────
async function pinSignIn(uid, pin, request) {
  const userRef = db.doc(`users/${uid}`);
  const secretRef = db.doc(`staffSecrets/${uid}`);
  const policy = await loginPolicyForUser(await profileFor(uid));
  if (!policy.enablePinLogin) {
    fail('failed-precondition', 'Cloud PIN sign-in is disabled for your station. Use another sign-in method or contact your admin.');
  }
  const outcome = await db.runTransaction(async transaction => {
    const [userSnap, secretSnap] = await transaction.getAll(userRef, secretRef);
    if (!userSnap.exists || !secretSnap.exists) return { ok: false };
    const user = userSnap.data();
    const secret = secretSnap.data();
    if (user.pwaLoginAllowed === false) return { ok: false, pwaBlocked: true };
    if (user.status !== 'active' || !secret.pinHash) return { ok: false, setupRequired: true };
    if (secret.lockedUntil?.toMillis?.() > Date.now()) return { ok: false, lockedUntil: secret.lockedUntil.toMillis() };
    const valid = await verifyPin(pin, secret);
    const now = FieldValue.serverTimestamp();
    const auditRef = db.collection('auditLogs').doc();
    if (!valid) {
      const failedAttempts = Number(secret.failedAttempts || 0) + 1;
      const lock = failedAttempts >= MAX_LOGIN_FAILURES ? Timestamp.fromMillis(Date.now() + LOCKOUT_MS) : null;
      transaction.update(secretRef, { failedAttempts, lockedUntil: lock, updatedAt: now });
      transaction.set(auditRef, { actorUid: uid, action: 'auth.login_failed', targetUid: uid, metadata: { failedAttempts }, createdAt: now });
      return { ok: false, lockedUntil: lock?.toMillis?.() || null };
    }
    transaction.update(secretRef, { failedAttempts: 0, lockedUntil: null, updatedAt: now });
    transaction.update(userRef, { lastLogin: now, updatedAt: now });
    transaction.set(auditRef, { actorUid: uid, action: 'auth.login', targetUid: uid, createdAt: now });
    return { ok: true, profile: user, secret };
  });
  if (!outcome.ok) {
    if (outcome.pwaBlocked) fail('permission-denied', 'PWA sign-in is disabled for this account. Contact your admin.');
    if (outcome.setupRequired) fail('failed-precondition', 'PIN setup is required before you can sign in. Ask your admin for your temporary credentials.');
    if (outcome.lockedUntil) fail('resource-exhausted', 'Too many attempts. Try again later.', { lockedUntil: outcome.lockedUntil });
    fail('unauthenticated', 'Username or Cloud PIN is incorrect.');
  }
  const token = await auth.createCustomToken(uid);
  return {
    token,
    profile: safeProfile({ uid, ...outcome.profile }),
    pinRotationRequired: pinRotationRequired(policy, outcome.secret),
    pinLastChangedAt: outcome.secret?.pinLastChangedAt?.toMillis?.() || null,
    policies: { minPinLength: policy.minPinLength, pinComplexity: policy.pinComplexity },
  };
}

// ═══════════════════════════════════════════════════════════════════════
//  Sign-in endpoints
// ═══════════════════════════════════════════════════════════════════════

/** Station picker on the login screen — public, flag data only. */
exports.listPublicStations = onCall(async request => {
  await checkRateLimit('stations', callerKey(request), 60, 5 * 60 * 1000);
  const snap = await db.collection('stations').orderBy('name').limit(100).get();
  return {
    stations: snap.docs.map(docSnap => ({
      id: docSnap.id,
      name: String(docSnap.data().name || 'Station'),
    })),
  };
});

/** Username + Cloud PIN. Enforces the station Cloud PIN login toggle. */
exports.loginWithUsernamePin = onCall(async request => {
  const username = validateUsername(request.data?.username);
  await checkRateLimit('pinuser', username, 10, 5 * 60 * 1000);
  const pin = String(request.data?.pin || '');
  if (!new RegExp(`^\\d{${PIN_MIN},${PIN_MAX}}$`).test(pin)) {
    fail('invalid-argument', `Enter your ${PIN_MIN}–${PIN_MAX} digit Cloud PIN.`);
  }
  const usernameSnap = await db.doc(`usernames/${username}`).get();
  if (!usernameSnap.exists) fail('unauthenticated', 'Username or Cloud PIN is incorrect.');
  return pinSignIn(usernameSnap.data().uid, pin, request);
});

/** Email + Cloud PIN. Same verification core, resolved via Firebase Auth. */
exports.loginWithEmailPin = onCall(async request => {
  const email = validateEmail(request.data?.email);
  await checkRateLimit('pinemail', email, 10, 5 * 60 * 1000);
  const pin = String(request.data?.pin || '');
  if (!new RegExp(`^\\d{${PIN_MIN},${PIN_MAX}}$`).test(pin)) {
    fail('invalid-argument', `Enter your ${PIN_MIN}–${PIN_MAX} digit Cloud PIN.`);
  }
  let authUser;
  try {
    authUser = await auth.getUserByEmail(email);
  } catch (error) {
    if (error?.code === 'auth/user-not-found') fail('unauthenticated', 'Email or Cloud PIN is incorrect.');
    throw error;
  }
  const result = await pinSignIn(authUser.uid, pin, request);
  return result;
});

/**
 * Username + Password sign-in: the client needs the account email because
 * Firebase password auth is email-based. The password itself is verified by
 * Firebase Authentication on the client — this endpoint only maps the
 * identifier, and it refuses when the station disabled username/password
 * sign-in.
 */
exports.resolveLoginIdentifier = onCall(async request => {
  const username = validateUsername(request.data?.username);
  await checkRateLimit('resolve', username, 10, 5 * 60 * 1000);
  const usernameSnap = await db.doc(`usernames/${username}`).get();
  if (!usernameSnap.exists) fail('unauthenticated', 'That username is not registered.');
  const uid = usernameSnap.data().uid;
  const profile = await profileFor(uid);
  const policy = await loginPolicyForUser(profile);
  if (!policy.enableUsernameLogin || !policy.enablePasswordLogin) {
    fail('failed-precondition', 'Username + password sign-in is disabled for your station. Use another method or contact your admin.');
  }
  if (profile.pwaLoginAllowed === false) fail('permission-denied', 'PWA sign-in is disabled for this account.');
  if (profile.status === 'disabled') fail('permission-denied', 'This account has been disabled. Contact your admin.');
  const authUser = await auth.getUser(uid).catch(() => null);
  const email = authUser?.email || profile.email;
  if (!email) fail('failed-precondition', 'This account has no email credential. Sign in with your Cloud PIN.');
  // Note: lastLogin is only stamped by recordLogin AFTER the client verifies
  // the password with Firebase Authentication — never at identifier lookup.
  return { email, uid };
});

// ═══════════════════════════════════════════════════════════════════════
//  PIN & password lifecycle
// ═══════════════════════════════════════════════════════════════════════

/** Everything the client needs after ANY sign-in to enforce PIN policy. */
exports.getMyPinStatus = onCall(async request => {
  const uid = requireAuth(request);
  const profile = await profileFor(uid);
  const secretSnap = await db.doc(`staffSecrets/${uid}`).get();
  const secret = secretSnap.exists ? secretSnap.data() : {};
  const policy = await loginPolicyForUser(profile);
  return {
    pinSet: !!secret.pinHash,
    pinResetRequired: profile.pin_reset_required === true,
    pinRotationRequired: pinRotationRequired(policy, secret),
    passwordResetRequired: profile.password_reset_required === true,
    pinLastChangedAt: secret?.pinLastChangedAt?.toMillis?.() || null,
    hasPassword: !!profile.email,
    policies: {
      minPinLength: policy.minPinLength,
      pinComplexity: policy.pinComplexity,
      minPasswordLength: policy.minPasswordLength,
      passwordComplexity: policy.passwordComplexity,
      pinRotationDays: policy.pinRotationDays,
      enableEmailLogin: policy.enableEmailLogin,
      enableUsernameLogin: policy.enableUsernameLogin,
      enablePasswordLogin: policy.enablePasswordLogin,
      enablePinLogin: policy.enablePinLogin,
    },
  };
});

/** Change your own Cloud PIN — verified against the current PIN. */
exports.changePin = onCall(async request => {
  const uid = requireAuth(request);
  const profile = await profileFor(uid);
  const policy = await loginPolicyForUser(profile);
  const currentPin = validatePin(request.data?.currentPin, { ...policy, pinComplexity: 'digits' });
  const newPin = validatePin(request.data?.newPin, policy);
  if (currentPin === newPin) fail('invalid-argument', 'New Cloud PIN must be different from the current PIN.');
  const secretRef = db.doc(`staffSecrets/${uid}`);
  const secretSnap = await secretRef.get();
  if (!secretSnap.exists || !(await verifyPin(currentPin, secretSnap.data()))) {
    fail('unauthenticated', 'Current Cloud PIN is incorrect.');
  }
  const next = await hashPin(newPin);
  const now = FieldValue.serverTimestamp();
  await db.runTransaction(async transaction => {
    const fresh = await transaction.get(secretRef);
    if (!fresh.exists || !(await verifyPin(currentPin, fresh.data()))) {
      fail('unauthenticated', 'Current Cloud PIN is incorrect.');
    }
    transaction.update(secretRef, {
      ...next,
      failedAttempts: 0,
      lockedUntil: null,
      pinLastChangedAt: Timestamp.now(),
      updatedAt: now,
    });
    const auditRef = db.collection('auditLogs').doc();
    transaction.set(auditRef, { actorUid: uid, action: 'user.pin_changed', targetUid: uid, createdAt: now });
  });
  await db.doc(`users/${uid}`).update({ pin_reset_required: false, updatedAt: now });
  return { success: true };
});

/**
 * Called after the client changes its Firebase Auth password: clears the
 * "must change password" flag. The password itself never passes through
 * this service — Firebase Authentication handles it on the client with
 * reauthentication.
 */
exports.finishPasswordSetup = onCall(async request => {
  const uid = requireAuth(request);
  const profile = await profileFor(uid);
  if (profile.password_reset_required !== true) return { success: true, alreadyCleared: true };
  const authUser = await auth.getUser(uid).catch(() => null);
  if (!authUser?.email) fail('failed-precondition', 'This account has no password credential.');
  await db.doc(`users/${uid}`).update({ password_reset_required: false, updatedAt: FieldValue.serverTimestamp() });
  await writeAudit({ actorUid: uid, action: 'user.password_changed', targetUid: uid });
  return { success: true };
});

// ═══════════════════════════════════════════════════════════════════════
//  Account administration (create / update / credentials / delete)
// ═══════════════════════════════════════════════════════════════════════

exports.createUserAccount = onCall(async request => {
  const managerUid = requireAuth(request);
  const manager = await profileFor(managerUid);
  if (!isManager(manager)) fail('permission-denied', 'Only Station Admins and Super Admins can create users.');

  const data = request.data || {};
  const firstName = validateNamePart(data.firstName, 'First name');
  const lastName = validateNamePart(data.lastName, 'Last name');
  const fullName = `${firstName} ${lastName}`;
  const username = validateUsername(data.username);
  const email = validateEmail(data.email);
  const role = validateRole(data.role, manager);
  const stationIds = role === 'superadmin'
    ? []
    : assertCanManageStations(manager, data.stationIds);
  const pumpIds = role === 'staff' && Array.isArray(data.pumpIds)
    ? [...new Set(data.pumpIds.filter(id => typeof id === 'string' && id))].slice(0, 200)
    : [];
  const phoneNumber = validatePhone(data.phoneNumber);
  const employeeId = validateEmployeeId(data.employeeId);
  const avatarUrl = validateAvatarUrl(data.avatarUrl);
  const active = data.active !== false;
  const allowPwaLogin = data.allowPwaLogin !== false;
  const mustChangePassword = data.mustChangePassword !== false;
  const mustChangePin = data.mustChangePin !== false;

  const policy = await mergedSecurityForStations(stationIds);
  const temporaryPassword = validatePassword(data.temporaryPassword, policy);
  const temporaryPin = validatePin(data.temporaryCloudPin, policy);
  const secret = await hashPin(temporaryPin);

  let authUser;
  try {
    authUser = await auth.createUser({ email, password: temporaryPassword, displayName: fullName, disabled: !active });
  } catch (error) {
    if (error?.code === 'auth/email-already-exists') fail('already-exists', 'Email already registered.');
    if (error?.code === 'auth/invalid-password') fail('invalid-argument', 'Password must be at least 6 characters for Firebase Authentication.');
    throw error;
  }

  const userRef = db.doc(`users/${authUser.uid}`);
  const secretRef = db.doc(`staffSecrets/${authUser.uid}`);
  const usernameRef = db.doc(`usernames/${username}`);
  try {
    await db.runTransaction(async transaction => {
      const usernameSnap = await transaction.get(usernameRef);
      if (usernameSnap.exists) throw new IdentityCollision();
      const now = FieldValue.serverTimestamp();
      transaction.set(usernameRef, { uid: authUser.uid, username, createdAt: now, updatedAt: now });
      transaction.set(userRef, {
        firstName,
        lastName,
        fullName,
        username,
        email,
        phoneNumber,
        employeeId,
        avatarUrl,
        role,
        stationIds,
        status: active ? 'active' : 'disabled',
        createdBy: manager.uid,
        createdByAdmin: manager.uid,
        isAdmin: role !== 'staff',
        pin_reset_required: mustChangePin,
        password_reset_required: mustChangePassword,
        pwaLoginAllowed: allowPwaLogin,
        createdAt: now,
        updatedAt: now,
        lastLogin: null,
        ...(pumpIds.length ? { pumpIds } : {}),
      });
      transaction.set(secretRef, {
        ...secret,
        failedAttempts: 0,
        lockedUntil: null,
        pinLastChangedAt: Timestamp.now(),
        createdAt: now,
        updatedAt: now,
      });
    });
  } catch (error) {
    await auth.deleteUser(authUser.uid).catch(cleanupError => console.error('Account Auth cleanup failed', cleanupError));
    if (error?.code === 'identity-collision') fail('already-exists', 'Username already exists.');
    throw error;
  }

  await writeAudit({
    actorUid: managerUid,
    action: 'user.created',
    targetUid: authUser.uid,
    metadata: { username, role, stationIds },
  });

  return {
    staffId: authUser.uid,
    fullName,
    username,
    email,
    role,
    stationIds,
    active,
    mustChangePassword,
    mustChangePin,
  };
});

exports.updateUserAccount = onCall(async request => {
  const managerUid = requireAuth(request);
  const manager = await profileFor(managerUid);
  if (!isManager(manager)) fail('permission-denied', 'Only managers can update users.');

  const data = request.data || {};
  const targetUid = String(data.staffId || '');
  if (!targetUid) fail('invalid-argument', 'Missing account id.');
  const target = await profileFor(targetUid);
  assertAccountTarget(manager, target);

  const patch = { updatedAt: FieldValue.serverTimestamp(), updatedBy: managerUid };

  if (data.firstName !== undefined || data.lastName !== undefined) {
    const firstName = data.firstName !== undefined ? validateNamePart(data.firstName, 'First name') : target.firstName || target.fullName || '';
    const lastName = data.lastName !== undefined ? validateNamePart(data.lastName, 'Last name') : target.lastName || '';
    patch.firstName = firstName;
    patch.lastName = lastName;
    patch.fullName = `${firstName} ${lastName}`.trim();
  }
  if (data.phoneNumber !== undefined) patch.phoneNumber = validatePhone(data.phoneNumber);
  if (data.employeeId !== undefined) patch.employeeId = validateEmployeeId(data.employeeId);
  if (data.avatarUrl !== undefined) patch.avatarUrl = validateAvatarUrl(data.avatarUrl);
  if (data.allowPwaLogin !== undefined) patch.pwaLoginAllowed = data.allowPwaLogin !== false;

  if (data.role !== undefined && data.role !== target.role) {
    const role = validateRole(data.role, manager);
    if (target.role === 'superadmin') fail('permission-denied', 'Super Admin roles cannot be changed here.');
    if (target.role === 'stationadmin' && role === 'staff') fail('permission-denied', 'Manager roles cannot be downgraded here.');
    patch.role = role;
    patch.isAdmin = role !== 'staff';
  }
  if (data.stationIds !== undefined) {
    patch.stationIds = patch.role === 'superadmin' || (patch.role === undefined && target.role === 'superadmin')
      ? []
      : assertCanManageStations(manager, data.stationIds);
  }
  if (data.pumpIds !== undefined) {
    const ids = Array.isArray(data.pumpIds) ? [...new Set(data.pumpIds.filter(id => typeof id === 'string' && id))].slice(0, 200) : [];
    if (ids.length) patch.pumpIds = ids;
    else patch.pumpIds = FieldValue.delete();
  }
  if (data.active !== undefined) {
    if (target.role === 'superadmin') fail('permission-denied', 'Super Admin accounts cannot be deactivated.');
    const active = data.active !== false;
    patch.status = active ? 'active' : 'disabled';
    await auth.updateUser(targetUid, { disabled: !active });
  }

  await db.doc(`users/${targetUid}`).update(patch);
  if (patch.fullName) await auth.updateUser(targetUid, { displayName: patch.fullName }).catch(() => {});
  await writeAudit({
    actorUid: managerUid,
    action: 'user.updated',
    targetUid,
    metadata: { fields: Object.keys(patch).filter(k => !['updatedAt', 'updatedBy'].includes(k)) },
  });
  return { success: true };
});

/** Issue a new temporary password for an existing account. */
exports.adminSetPassword = onCall(async request => {
  const managerUid = requireAuth(request);
  const manager = await profileFor(managerUid);
  const data = request.data || {};
  const target = await profileFor(String(data.staffId || ''));
  assertAccountTarget(manager, target);
  const authUser = await auth.getUser(target.uid).catch(() => null);
  if (!authUser?.email && !target.email) fail('failed-precondition', 'This account has no email credential to reset.');
  const policy = await mergedSecurityForStations(target.stationIds || []);
  const newPassword = validatePassword(data.newPassword, policy);
  await auth.updateUser(target.uid, { password: newPassword });
  await db.doc(`users/${target.uid}`).update({
    password_reset_required: data.mustChange !== false,
    updatedAt: FieldValue.serverTimestamp(),
    updatedBy: managerUid,
  });
  await writeAudit({ actorUid: managerUid, action: 'user.password_reset', targetUid: target.uid });
  return { success: true };
});

/** Issue a new temporary Cloud PIN for an existing account. */
exports.adminSetPin = onCall(async request => {
  const managerUid = requireAuth(request);
  const manager = await profileFor(managerUid);
  const data = request.data || {};
  const target = await profileFor(String(data.staffId || ''));
  assertAccountTarget(manager, target);
  const policy = await mergedSecurityForStations(target.stationIds || []);
  const newPin = validatePin(data.newPin, policy);
  const secret = await hashPin(newPin);
  await db.doc(`staffSecrets/${target.uid}`).set({
    ...secret,
    failedAttempts: 0,
    lockedUntil: null,
    pinLastChangedAt: Timestamp.now(),
    joiningCode: FieldValue.delete(),
    joiningCodeExpiresAt: FieldValue.delete(),
    updatedAt: FieldValue.serverTimestamp(),
  }, { merge: true });
  await db.doc(`users/${target.uid}`).update({
    pin_reset_required: data.mustChange !== false,
    status: 'active',
    updatedAt: FieldValue.serverTimestamp(),
    updatedBy: managerUid,
  });
  await writeAudit({ actorUid: managerUid, action: 'user.pin_reset', targetUid: target.uid });
  return { success: true };
});

/** Deactivate (reversible) or permanently remove an account. */
exports.deleteUserAccount = onCall(async request => {
  const managerUid = requireAuth(request);
  const manager = await profileFor(managerUid);
  const data = request.data || {};
  const target = await profileFor(String(data.staffId || ''));
  assertAccountTarget(manager, target);
  if (target.role === 'superadmin') fail('permission-denied', 'Super Admin accounts are protected.');
  const mode = data.mode === 'remove' ? 'remove' : 'deactivate';

  if (mode === 'deactivate') {
    await auth.updateUser(target.uid, { disabled: true });
    const secretRef = db.doc(`staffSecrets/${target.uid}`);
    await db.runTransaction(async transaction => {
      const secretSnap = await transaction.get(secretRef);
      const secret = secretSnap.exists ? secretSnap.data() : {};
      const now = FieldValue.serverTimestamp();
      if (secret.joiningCode) transaction.delete(db.doc(`joiningCodes/${secret.joiningCode}`));
      transaction.set(secretRef, {
        pinHash: FieldValue.delete(),
        pinSalt: FieldValue.delete(),
        pinAlgorithm: FieldValue.delete(),
        joiningCode: FieldValue.delete(),
        joiningCodeExpiresAt: FieldValue.delete(),
        lockedUntil: Timestamp.fromMillis(Date.now() + 100 * 365 * 24 * 60 * 60 * 1000),
        updatedAt: now,
      }, { merge: true });
      transaction.update(db.doc(`users/${target.uid}`), { status: 'disabled', updatedAt: now, updatedBy: managerUid });
    });
    await writeAudit({ actorUid: managerUid, action: 'user.deactivated', targetUid: target.uid });
    return { success: true, mode };
  }

  // Permanent removal: profile + identity records + Auth credential.
  const username = target.username ? normalizeUsername(target.username) : null;
  const secretSnap = await db.doc(`staffSecrets/${target.uid}`).get();
  const batch = db.batch();
  batch.delete(db.doc(`users/${target.uid}`));
  batch.delete(db.doc(`staffSecrets/${target.uid}`));
  if (username) batch.delete(db.doc(`usernames/${username}`));
  const staleCode = secretSnap.exists ? secretSnap.data().joiningCode : null;
  if (staleCode) batch.delete(db.doc(`joiningCodes/${staleCode}`));
  await batch.commit();
  await auth.deleteUser(target.uid).catch(error => console.error('Auth user removal failed', { error, uid: target.uid }));
  await writeAudit({ actorUid: managerUid, action: 'user.removed', targetUid: target.uid, metadata: { username } });
  return { success: true, mode };
});

// ═══════════════════════════════════════════════════════════════════════
//  Legacy onboarding flows (kept for accounts invited before v1.0)
// ═══════════════════════════════════════════════════════════════════════

async function createStaffIdentity({ uid, manager, fullName, username, phoneNumber, stationIds }) {
  const userRef = db.doc(`users/${uid}`);
  const secretRef = db.doc(`staffSecrets/${uid}`);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const joiningCode = randomJoiningCode();
    const usernameRef = db.doc(`usernames/${username}`);
    const joiningRef = db.doc(`joiningCodes/${joiningCode}`);
    try {
      await db.runTransaction(async transaction => {
        const [usernameSnap, joiningSnap] = await transaction.getAll(usernameRef, joiningRef);
        if (usernameSnap.exists || joiningSnap.exists) throw new IdentityCollision();
        const now = FieldValue.serverTimestamp();
        transaction.set(usernameRef, {
          uid,
          username,
          createdAt: now,
          updatedAt: now,
        });
        transaction.set(joiningRef, {
          uid,
          purpose: 'activation',
          expiresAt: Timestamp.fromMillis(Date.now() + JOINING_CODE_TTL_MS),
          createdAt: now,
        });
        transaction.set(userRef, {
          fullName,
          firstName: fullName.split(' ')[0] || fullName,
          lastName: fullName.split(' ').slice(1).join(' ') || '',
          username,
          phoneNumber,
          employeeId: '',
          avatarUrl: '',
          role: 'staff',
          stationIds,
          status: 'invited',
          createdBy: manager.uid,
          createdByAdmin: manager.uid,
          isAdmin: false,
          pin_reset_required: true,
          password_reset_required: false,
          pwaLoginAllowed: true,
          createdAt: now,
          updatedAt: now,
        });
        transaction.set(secretRef, {
          joiningCode,
          joiningCodeExpiresAt: Timestamp.fromMillis(Date.now() + JOINING_CODE_TTL_MS),
          failedAttempts: 0,
          lockedUntil: null,
          createdAt: now,
          updatedAt: now,
        });
      });
      return joiningCode;
    } catch (error) {
      if (error?.code === 'identity-collision') continue;
      throw error;
    }
  }
  fail('aborted', 'Could not allocate a unique username and joining code. Try again.');
}

exports.createStaff = onCall(async request => {
  const managerUid = requireAuth(request);
  const manager = await profileFor(managerUid);
  if (!isManager(manager)) fail('permission-denied', 'Only Station Admins and Super Admins can create staff.');
  const fullName = validateFullName(request.data?.fullName);
  const username = validateUsername(request.data?.username);
  const phoneNumber = validatePhone(request.data?.phoneNumber);
  const stationIds = assertCanManageStations(manager, request.data?.stationIds);

  let authUser;
  try {
    // Firebase Auth users created without email/password can authenticate only
    // through the custom-token flow below, which keeps email optional.
    authUser = await auth.createUser({ displayName: fullName, disabled: false });
    const joiningCode = await createStaffIdentity({ uid: authUser.uid, manager, fullName, username, phoneNumber, stationIds });
    await writeAudit({ actorUid: managerUid, action: 'staff.created', targetUid: authUser.uid, metadata: { username, stationIds } });
    return { staffId: authUser.uid, fullName, username, joiningCode };
  } catch (error) {
    if (authUser?.uid) await auth.deleteUser(authUser.uid).catch(deleteError => console.error('Staff Auth cleanup failed', deleteError));
    if (error instanceof HttpsError) throw error;
    console.error('Staff creation failed', error);
    fail('internal', 'Staff could not be created. Try again.');
  }
});

exports.previewJoiningCode = onCall(async request => {
  const code = String(request.data?.joiningCode || '').trim();
  if (!/^\d{5}$/.test(code)) fail('invalid-argument', 'Enter the 5-digit joining code.');
  const codeSnap = await db.doc(`joiningCodes/${code}`).get();
  if (!codeSnap.exists) fail('not-found', 'That joining code is invalid or has expired.');
  const invite = codeSnap.data();
  if (!invite.expiresAt || invite.expiresAt.toMillis() <= Date.now()) fail('deadline-exceeded', 'That joining code has expired. Ask an admin for a new one.');
  const profile = await profileFor(invite.uid);
  if (profile.status === 'disabled' || (profile.status !== 'invited' && !profile.pin_reset_required)) {
    fail('failed-precondition', 'That joining code is no longer active.');
  }
  return { staffId: invite.uid, fullName: profile.fullName || 'Staff member', username: profile.username || '' };
});

exports.activateStaff = onCall(async request => {
  const code = String(request.data?.joiningCode || '').trim();
  if (!/^\d{5}$/.test(code)) fail('invalid-argument', 'Enter the 5-digit joining code.');
  const codeRef = db.doc(`joiningCodes/${code}`);
  const codeSnap = await codeRef.get();
  if (!codeSnap.exists) fail('not-found', 'That joining code is invalid or has expired.');
  const invite = codeSnap.data();
  if (!invite.expiresAt || invite.expiresAt.toMillis() <= Date.now()) fail('deadline-exceeded', 'That joining code has expired. Ask an admin for a new one.');
  const profile = await profileFor(invite.uid);
  if (profile.status === 'disabled') fail('permission-denied', 'This staff account is disabled.');
  if (profile.status !== 'invited' && !profile.pin_reset_required) fail('already-exists', 'This joining code has already been used.');
  const policy = await loginPolicyForUser(profile);
  const pin = validatePin(request.data?.pin, policy);
  const secret = await hashPin(pin);
  const userRef = db.doc(`users/${invite.uid}`);
  const secretRef = db.doc(`staffSecrets/${invite.uid}`);
  await db.runTransaction(async transaction => {
    const [freshCode, freshSecret, freshUser] = await transaction.getAll(codeRef, secretRef, userRef);
    const codeData = freshCode.data();
    const userData = freshUser.data();
    if (!freshCode.exists || !freshSecret.exists || !freshUser.exists
      || codeData.uid !== invite.uid
      || freshSecret.data().joiningCode !== code
      || userData.status === 'disabled') {
      fail('failed-precondition', 'That joining code is no longer valid.');
    }
    const now = FieldValue.serverTimestamp();
    transaction.update(userRef, { status: 'active', pin_reset_required: false, updatedAt: now, lastLogin: now });
    transaction.update(secretRef, {
      ...secret,
      failedAttempts: 0,
      lockedUntil: null,
      pinLastChangedAt: Timestamp.now(),
      joiningCode: FieldValue.delete(),
      joiningCodeExpiresAt: FieldValue.delete(),
      updatedAt: now,
    });
    transaction.delete(codeRef);
  });
  await writeAudit({ actorUid: invite.uid, action: 'staff.activated', targetUid: invite.uid });
  const token = await auth.createCustomToken(invite.uid);
  return { token, profile: safeProfile({ ...profile, status: 'active', pin_reset_required: false }) };
});

exports.disableStaff = onCall(async request => {
  const managerUid = requireAuth(request);
  const manager = await profileFor(managerUid);
  if (!isManager(manager)) fail('permission-denied', 'Only managers can disable staff.');
  const target = await assertCanManageTarget(manager, String(request.data?.staffId || ''));
  await auth.updateUser(target.uid, { disabled: true });
  const secretRef = db.doc(`staffSecrets/${target.uid}`);
  await db.runTransaction(async transaction => {
    const secretSnap = await transaction.get(secretRef);
    const secret = secretSnap.exists ? secretSnap.data() : {};
    const now = FieldValue.serverTimestamp();
    if (secret.joiningCode) transaction.delete(db.doc(`joiningCodes/${secret.joiningCode}`));
    transaction.set(secretRef, {
      pinHash: FieldValue.delete(), pinSalt: FieldValue.delete(), pinAlgorithm: FieldValue.delete(),
      joiningCode: FieldValue.delete(), joiningCodeExpiresAt: FieldValue.delete(),
      lockedUntil: Timestamp.fromMillis(Date.now() + 100 * 365 * 24 * 60 * 60 * 1000), updatedAt: now,
    }, { merge: true });
    transaction.update(db.doc(`users/${target.uid}`), { status: 'disabled', updatedAt: now });
  });
  await writeAudit({ actorUid: managerUid, action: 'staff.disabled', targetUid: target.uid });
  return { success: true };
});

exports.resetStaffPin = onCall(async request => {
  const managerUid = requireAuth(request);
  const manager = await profileFor(managerUid);
  if (!isManager(manager)) fail('permission-denied', 'Only managers can reset PINs.');
  const target = await assertCanManageTarget(manager, String(request.data?.staffId || ''));
  const secretRef = db.doc(`staffSecrets/${target.uid}`);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const code = randomJoiningCode();
    const codeRef = db.doc(`joiningCodes/${code}`);
    try {
      await db.runTransaction(async transaction => {
        const [secretSnap, codeSnap] = await transaction.getAll(secretRef, codeRef);
        if (codeSnap.exists) throw new IdentityCollision();
        const oldCode = secretSnap.data()?.joiningCode;
        const now = FieldValue.serverTimestamp();
        if (oldCode) transaction.delete(db.doc(`joiningCodes/${oldCode}`));
        transaction.set(codeRef, { uid: target.uid, purpose: 'pin-reset', expiresAt: Timestamp.fromMillis(Date.now() + JOINING_CODE_TTL_MS), createdAt: now });
        transaction.set(secretRef, {
          joiningCode: code,
          joiningCodeExpiresAt: Timestamp.fromMillis(Date.now() + JOINING_CODE_TTL_MS),
          pinHash: FieldValue.delete(),
          pinSalt: FieldValue.delete(),
          pinAlgorithm: FieldValue.delete(),
          failedAttempts: 0,
          lockedUntil: null,
          updatedAt: now,
        }, { merge: true });
        transaction.update(db.doc(`users/${target.uid}`), { pin_reset_required: true, updatedAt: now });
      });
      await writeAudit({ actorUid: managerUid, action: 'staff.pin_reset', targetUid: target.uid });
      return { staffId: target.uid, fullName: target.fullName || target.email || 'Staff member', username: target.username || '', joiningCode: code };
    } catch (error) {
      if (error?.code === 'identity-collision') continue;
      throw error;
    }
  }
  fail('aborted', 'Could not allocate a unique reset code. Try again.');
});

exports.checkUsername = onCall(async request => {
  const username = validateUsername(request.data?.username);
  await checkRateLimit('check', callerKey(request), 60, 5 * 60 * 1000);
  const snap = await db.doc(`usernames/${username}`).get();
  return { username, available: !snap.exists };
});

/**
 * Password-based methods (email/username + password) authenticate entirely
 * inside Firebase Authentication on the client, so the client calls this
 * once after a successful sign-in to stamp lastLogin and the audit trail.
 * PIN methods are already stamped inside the sign-in transaction, and
 * restored sessions never call this — only fresh form sign-ins do.
 */
exports.recordLogin = onCall(async request => {
  const uid = requireAuth(request);
  await checkRateLimit('recordlogin', uid, 30, 5 * 60 * 1000);
  const now = FieldValue.serverTimestamp();
  await db.doc(`users/${uid}`).update({ lastLogin: now, updatedAt: now });
  await writeAudit({ actorUid: uid, action: 'auth.login', targetUid: uid, metadata: { method: 'password' } });
  return { success: true };
});

exports.recordLogout = onCall(async request => {
  const uid = requireAuth(request);
  await writeAudit({ actorUid: uid, action: 'auth.logout', targetUid: uid });
  return { success: true };
});

// ── Station Admin invites ───────────────────────────────────────────────
exports.createAdminInvite = onCall(async request => {
  const creatorUid = requireAuth(request);
  const creator = await profileFor(creatorUid);
  if (creator.role !== 'superadmin') fail('permission-denied', 'Only a Super Admin can invite Station Admins.');
  const expiresInDays = Math.min(30, Math.max(1, Number(request.data?.expiresInDays) || 30));
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const code = randomAdminInviteCode();
    const inviteRef = db.doc(`adminInvites/${code}`);
    try {
      await db.runTransaction(async transaction => {
        const existing = await transaction.get(inviteRef);
        if (existing.exists) throw new IdentityCollision();
        transaction.set(inviteRef, {
          purpose: 'stationadmin', createdBy: creatorUid, used: false,
          expiresAt: Timestamp.fromMillis(Date.now() + expiresInDays * 24 * 60 * 60 * 1000),
          createdAt: FieldValue.serverTimestamp(),
        });
      });
      await writeAudit({ actorUid: creatorUid, action: 'stationadmin.invite_created', metadata: { expiresInDays } });
      return { joiningCode: code, expiresInDays };
    } catch (error) {
      if (error?.code === 'identity-collision') continue;
      throw error;
    }
  }
  fail('aborted', 'Could not generate a unique Station Admin invite. Try again.');
});

exports.previewAdminInvite = onCall(async request => {
  const code = String(request.data?.joiningCode || '').trim();
  if (!/^\d{10}$/.test(code)) fail('invalid-argument', 'Enter the 10-digit Station Admin invite code.');
  const snap = await db.doc(`adminInvites/${code}`).get();
  if (!snap.exists || snap.data().used || snap.data().expiresAt.toMillis() <= Date.now()) fail('not-found', 'That Station Admin invite is invalid or expired.');
  return { joiningCode: code, expiresAt: snap.data().expiresAt.toMillis() };
});

exports.activateAdminInvite = onCall(async request => {
  const code = String(request.data?.joiningCode || '').trim();
  if (!/^\d{10}$/.test(code)) fail('invalid-argument', 'Enter the 10-digit Station Admin invite code.');
  const fullName = validateFullName(request.data?.fullName);
  const username = validateUsername(request.data?.username);
  const phoneNumber = validatePhone(request.data?.phoneNumber);
  const invitedProfilePolicy = normalizeSecurity();
  const pin = validatePin(request.data?.pin, invitedProfilePolicy);
  const secret = await hashPin(pin);
  const inviteRef = db.doc(`adminInvites/${code}`);
  let authUser;
  try {
    authUser = await auth.createUser({ displayName: fullName, disabled: false });
    const userRef = db.doc(`users/${authUser.uid}`);
    const secretRef = db.doc(`staffSecrets/${authUser.uid}`);
    const usernameRef = db.doc(`usernames/${username}`);
    await db.runTransaction(async transaction => {
      const [inviteSnap, usernameSnap] = await transaction.getAll(inviteRef, usernameRef);
      if (!inviteSnap.exists || inviteSnap.data().used || inviteSnap.data().expiresAt.toMillis() <= Date.now()) fail('not-found', 'That Station Admin invite is invalid or expired.');
      if (usernameSnap.exists) throw new IdentityCollision();
      const now = FieldValue.serverTimestamp();
      const [firstName, ...rest] = fullName.split(' ');
      transaction.set(usernameRef, { uid: authUser.uid, username, createdAt: now, updatedAt: now });
      transaction.set(userRef, {
        fullName, firstName, lastName: rest.join(' '), username, phoneNumber,
        email: '', employeeId: '', avatarUrl: '',
        role: 'stationadmin', stationIds: [], status: 'active',
        createdBy: inviteSnap.data().createdBy, createdByAdmin: inviteSnap.data().createdBy,
        isAdmin: true, pin_reset_required: false, password_reset_required: false,
        pwaLoginAllowed: true, createdAt: now, updatedAt: now, lastLogin: now,
      });
      transaction.set(secretRef, {
        ...secret, failedAttempts: 0, lockedUntil: null,
        pinLastChangedAt: Timestamp.now(), createdAt: now, updatedAt: now,
      });
      transaction.update(inviteRef, { used: true, usedBy: authUser.uid, usedAt: now });
    });
    await writeAudit({ actorUid: authUser.uid, action: 'stationadmin.activated', targetUid: authUser.uid });
    const token = await auth.createCustomToken(authUser.uid);
    return { token, profile: safeProfile({ uid: authUser.uid, fullName, username, phoneNumber, role: 'stationadmin', stationIds: [], status: 'active', isAdmin: true, pin_reset_required: false }) };
  } catch (error) {
    if (authUser?.uid) await auth.deleteUser(authUser.uid).catch(cleanupError => console.error('Admin Auth cleanup failed', cleanupError));
    if (error?.code === 'identity-collision') fail('already-exists', 'That username is already in use. Choose another.');
    if (error instanceof HttpsError) throw error;
    console.error('Station Admin activation failed', error);
    fail('internal', 'Station Admin activation failed. Try again.');
  }
});
