/* PumpLog trusted authentication helpers.
 *
 * The GitHub Pages app never receives PIN hashes, salts, or joining-code
 * records. These callable functions run with the Firebase Admin SDK, use
 * scrypt for PIN hashing, issue Firebase custom tokens, and enforce lockouts
 * in a transaction. Firestore rules remain the authorization source of truth
 * for the application data after a token is issued.
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
const PIN_LENGTH = 4;
const MAX_LOGIN_FAILURES = 5;
const LOCKOUT_MS = 15 * 60 * 1000;
const JOINING_CODE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const USERNAME_RE = /^[a-z0-9_.]{4,25}$/;
const PHONE_RE = /^\+?[0-9 ()-]{7,20}$/;
const PIN_SEQUENCE = '0123456789';

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

function normalizeUsername(value) {
  return String(value || '').trim().toLowerCase();
}

function validateUsername(value) {
  const username = normalizeUsername(value);
  if (!USERNAME_RE.test(username)) {
    fail('invalid-argument', 'Username must be 4–25 characters using only lowercase letters, numbers, underscores, or dots.');
  }
  return username;
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

function validatePin(value) {
  const pin = String(value || '');
  if (!/^\d{4}$/.test(pin)) fail('invalid-argument', 'PIN must contain exactly 4 digits.');
  if (/^(\d)\1{3}$/.test(pin) || PIN_SEQUENCE.includes(pin) || PIN_SEQUENCE.split('').reverse().join('').includes(pin)) {
    fail('invalid-argument', 'Choose a less predictable 4-digit PIN.');
  }
  return pin;
}

function validateStations(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 50 || value.some(id => typeof id !== 'string' || !id)) {
    fail('invalid-argument', 'Assign at least one valid station.');
  }
  return [...new Set(value)];
}

function randomJoiningCode() {
  return String(crypto.randomInt(10000, 100000));
}

function generatedUsername(profile, uid) {
  const source = normalizeUsername(profile.fullName || profile.email?.split('@')[0] || `staff${uid.slice(0, 8)}`)
    .replace(/[^a-z0-9_.]/g, '');
  const base = (source.length >= 4 ? source : `staff${source}`).slice(0, 20);
  return `${base}${uid.slice(0, Math.max(0, 25 - base.length))}`.slice(0, 25);
}

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

function assertCanManageStations(manager, stationIds) {
  const ids = validateStations(stationIds);
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

async function createStaffIdentity({ uid, manager, fullName, username, phoneNumber, stationIds }) {
  const userRef = db.doc(`users/${uid}`);
  const secretRef = db.doc(`staffSecrets/${uid}`);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const joiningCode = randomJoiningCode();
    const usernameRef = db.doc(`usernames/${username}`);
    const joiningRef = db.doc(`joiningCodes/${joiningCode}`);
    try {
      await db.runTransaction(async transaction => {
        const [usernameSnap, joiningSnap] = await Promise.all([
          transaction.get(usernameRef),
          transaction.get(joiningRef),
        ]);
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
          username,
          phoneNumber,
          role: 'staff',
          stationIds,
          status: 'invited',
          createdBy: manager.uid,
          createdByAdmin: manager.uid,
          isAdmin: false,
          pin_reset_required: true,
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

async function prepareLegacyIdentity(profile, managerUid) {
  const base = generatedUsername(profile, profile.uid);
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const suffix = attempt ? String(attempt) : '';
    const username = `${base.slice(0, 25 - suffix.length)}${suffix}`.slice(0, 25);
    const joiningCode = randomJoiningCode();
    const usernameRef = db.doc(`usernames/${username}`);
    const joiningRef = db.doc(`joiningCodes/${joiningCode}`);
    const userRef = db.doc(`users/${profile.uid}`);
    const secretRef = db.doc(`staffSecrets/${profile.uid}`);
    try {
      await db.runTransaction(async transaction => {
        const [usernameSnap, joiningSnap, userSnap, secretSnap] = await Promise.all([
          transaction.get(usernameRef), transaction.get(joiningRef), transaction.get(userRef), transaction.get(secretRef),
        ]);
        if ((usernameSnap.exists && usernameSnap.data().uid !== profile.uid) || joiningSnap.exists) throw new IdentityCollision();
        const oldCode = secretSnap.data()?.joiningCode;
        const now = FieldValue.serverTimestamp();
        if (oldCode && oldCode !== joiningCode) transaction.delete(db.doc(`joiningCodes/${oldCode}`));
        transaction.set(usernameRef, { uid: profile.uid, username, createdAt: profile.createdAt || now, updatedAt: now }, { merge: true });
        transaction.set(joiningRef, { uid: profile.uid, purpose: 'legacy-migration', expiresAt: Timestamp.fromMillis(Date.now() + JOINING_CODE_TTL_MS), createdAt: now });
        transaction.set(userRef, {
          fullName: profile.fullName || profile.email?.split('@')[0] || 'PumpLog user',
          username,
          phoneNumber: profile.phoneNumber || '',
          status: profile.status || 'active',
          pin_reset_required: true,
          updatedAt: now,
        }, { merge: true });
        transaction.set(secretRef, {
          joiningCode,
          joiningCodeExpiresAt: Timestamp.fromMillis(Date.now() + JOINING_CODE_TTL_MS),
          failedAttempts: 0,
          lockedUntil: null,
          updatedAt: now,
        }, { merge: true });
      });
      return { uid: profile.uid, fullName: profile.fullName || profile.email || 'PumpLog user', username, joiningCode };
    } catch (error) {
      if (error?.code === 'identity-collision') continue;
      throw error;
    }
  }
  fail('aborted', 'Could not prepare this legacy account. Try again.');
}

exports.prepareLegacyUsers = onCall(async request => {
  const managerUid = requireAuth(request);
  const manager = await profileFor(managerUid);
  if (!isManager(manager)) fail('permission-denied', 'Only managers can prepare legacy accounts.');
  const snap = await db.collection('users').get();
  const migrated = [];
  for (const docSnap of snap.docs) {
    const profile = { uid: docSnap.id, ...docSnap.data() };
    if (manager.role === 'stationadmin' && (profile.createdBy !== managerUid || profile.role !== 'staff')) continue;
    if (profile.username && profile.pin_reset_required === false) {
      const secretSnap = await db.doc(`staffSecrets/${profile.uid}`).get();
      if (secretSnap.exists && secretSnap.data().pinHash) continue;
    }
    migrated.push(await prepareLegacyIdentity(profile, managerUid));
  }
  await writeAudit({ actorUid: managerUid, action: 'staff.legacy_migration_prepared', metadata: { count: migrated.length } });
  return { migrated };
});

exports.checkUsername = onCall(async request => {
  const username = validateUsername(request.data?.username);
  const snap = await db.doc(`usernames/${username}`).get();
  return { username, available: !snap.exists };
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

exports.activateStaff = onCall(async request => {
  const code = String(request.data?.joiningCode || '').trim();
  if (!/^\d{5}$/.test(code)) fail('invalid-argument', 'Enter the 5-digit joining code.');
  const pin = validatePin(request.data?.pin);
  const codeRef = db.doc(`joiningCodes/${code}`);
  const codeSnap = await codeRef.get();
  if (!codeSnap.exists) fail('not-found', 'That joining code is invalid or has expired.');
  const invite = codeSnap.data();
  if (!invite.expiresAt || invite.expiresAt.toMillis() <= Date.now()) fail('deadline-exceeded', 'That joining code has expired. Ask an admin for a new one.');
  const profile = await profileFor(invite.uid);
  if (profile.status === 'disabled') fail('permission-denied', 'This staff account is disabled.');
  if (profile.status !== 'invited' && !profile.pin_reset_required) fail('already-exists', 'This joining code has already been used.');
  const secret = await hashPin(pin);
  const userRef = db.doc(`users/${invite.uid}`);
  const secretRef = db.doc(`staffSecrets/${invite.uid}`);
  await db.runTransaction(async transaction => {
    const [freshCode, freshSecret, freshUser] = await Promise.all([
      transaction.get(codeRef), transaction.get(secretRef), transaction.get(userRef),
    ]);
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
    transaction.update(secretRef, { ...secret, failedAttempts: 0, lockedUntil: null, joiningCode: FieldValue.delete(), joiningCodeExpiresAt: FieldValue.delete(), updatedAt: now });
    transaction.delete(codeRef);
  });
  await writeAudit({ actorUid: invite.uid, action: 'staff.activated', targetUid: invite.uid });
  const token = await auth.createCustomToken(invite.uid);
  return { token, profile: safeProfile({ ...profile, status: 'active', pin_reset_required: false }) };
});

exports.loginWithUsernamePin = onCall(async request => {
  const username = validateUsername(request.data?.username);
  const pin = String(request.data?.pin || '');
  if (!/^\d{4}$/.test(pin)) fail('invalid-argument', 'Enter your 4-digit PIN.');
  const usernameSnap = await db.doc(`usernames/${username}`).get();
  if (!usernameSnap.exists) fail('unauthenticated', 'Username or PIN is incorrect.');
  const uid = usernameSnap.data().uid;
  const userRef = db.doc(`users/${uid}`);
  const secretRef = db.doc(`staffSecrets/${uid}`);
  const outcome = await db.runTransaction(async transaction => {
    const [userSnap, secretSnap] = await Promise.all([transaction.get(userRef), transaction.get(secretRef)]);
    if (!userSnap.exists || !secretSnap.exists) return { ok: false };
    const user = userSnap.data();
    const secret = secretSnap.data();
    if (user.status !== 'active' || user.pin_reset_required || !secret.pinHash) return { ok: false, setupRequired: true };
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
    return { ok: true, profile: user };
  });
  if (!outcome.ok) {
    if (outcome.setupRequired) fail('failed-precondition', 'PIN setup is required before you can sign in.');
    if (outcome.lockedUntil) fail('resource-exhausted', 'Too many attempts. Try again later.', { lockedUntil: outcome.lockedUntil });
    fail('unauthenticated', 'Username or PIN is incorrect.');
  }
  const token = await auth.createCustomToken(uid);
  return { token, profile: safeProfile({ uid, ...outcome.profile }) };
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
    const secret = secretSnap.data() || {};
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
        const [secretSnap, codeSnap] = await Promise.all([transaction.get(secretRef), transaction.get(codeRef)]);
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

exports.changePin = onCall(async request => {
  const uid = requireAuth(request);
  const currentPin = validatePin(request.data?.currentPin);
  const newPin = validatePin(request.data?.newPin);
  if (currentPin === newPin) fail('invalid-argument', 'New PIN must be different from the current PIN.');
  const secretRef = db.doc(`staffSecrets/${uid}`);
  const secretSnap = await secretRef.get();
  if (!secretSnap.exists || !(await verifyPin(currentPin, secretSnap.data()))) fail('unauthenticated', 'Current PIN is incorrect.');
  const next = await hashPin(newPin);
  await db.runTransaction(async transaction => {
    const fresh = await transaction.get(secretRef);
    if (!fresh.exists || !(await verifyPin(currentPin, fresh.data()))) fail('unauthenticated', 'Current PIN is incorrect.');
    const now = FieldValue.serverTimestamp();
    transaction.update(secretRef, { ...next, failedAttempts: 0, lockedUntil: null, updatedAt: now });
    const auditRef = db.collection('auditLogs').doc();
    transaction.set(auditRef, { actorUid: uid, action: 'staff.pin_changed', targetUid: uid, createdAt: now });
  });
  await db.doc(`users/${uid}`).update({ pin_reset_required: false, updatedAt: FieldValue.serverTimestamp() });
  return { success: true };
});

exports.recordLogout = onCall(async request => {
  const uid = requireAuth(request);
  await writeAudit({ actorUid: uid, action: 'auth.logout', targetUid: uid });
  return { success: true };
});
