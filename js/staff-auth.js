/* PumpLog — trusted identity service client bridge
 *
 * This module only sends validated input to callable Cloud Functions. Cloud
 * PINs, salts, hashes, joining-code records, lockout counters, and
 * custom-token creation stay inside functions/. The browser receives a
 * Firebase Auth session — never a credential secret.
 */

import {
  getAuthInstance, getFunctionsInstance, httpsCallable, signInWithCustomToken,
  setAuthPersistence,
} from './firebase.js';

async function callIdentity(name, data = {}) {
  const callable = httpsCallable(getFunctionsInstance(), name);
  const result = await callable(data);
  return result.data;
}

export const normalizeUsername = value => String(value || '').trim().toLowerCase();

// ── Login screen ────────────────────────────────────────────────────────
export function listPublicStations() {
  return callIdentity('listPublicStations');
}

export async function resolveLoginIdentifier(username) {
  return callIdentity('resolveLoginIdentifier', { username: normalizeUsername(username) });
}

async function signInWithFunctionToken(result) {
  if (!result?.token) throw new Error('The identity service did not return a sign-in token.');
  await setAuthPersistence(true);
  await signInWithCustomToken(getAuthInstance(), result.token);
  return result;
}

export async function signInWithUsernamePin({ username, pin, remember = true }) {
  await setAuthPersistence(remember);
  const result = await callIdentity('loginWithUsernamePin', {
    username: normalizeUsername(username),
    pin,
  });
  await signInWithFunctionToken(result);
  return result;
}

export async function signInWithEmailPin({ email, pin, remember = true }) {
  await setAuthPersistence(remember);
  const result = await callIdentity('loginWithEmailPin', {
    email: String(email || '').trim().toLowerCase(),
    pin,
  });
  await signInWithFunctionToken(result);
  return result;
}

// ── PIN & password lifecycle ────────────────────────────────────────────
export function getMyPinStatus() {
  return callIdentity('getMyPinStatus');
}

export function changeCloudPin({ currentPin, newPin }) {
  return callIdentity('changePin', { currentPin, newPin });
}

export function finishPasswordSetup() {
  return callIdentity('finishPasswordSetup');
}

/** Stamp lastLogin + audit after a successful password-based sign-in. */
export function recordLogin() {
  return callIdentity('recordLogin');
}

export function recordLogout() {
  return callIdentity('recordLogout');
}

// ── Account administration ──────────────────────────────────────────────
export function createUserAccount(payload) {
  return callIdentity('createUserAccount', {
    ...payload,
    username: normalizeUsername(payload?.username),
    email: String(payload?.email || '').trim().toLowerCase(),
  });
}

export function updateUserAccount(staffId, patch) {
  return callIdentity('updateUserAccount', { staffId, ...patch });
}

export function adminSetPassword(staffId, newPassword, mustChange = true) {
  return callIdentity('adminSetPassword', { staffId, newPassword, mustChange });
}

export function adminSetPin(staffId, newPin, mustChange = true) {
  return callIdentity('adminSetPin', { staffId, newPin, mustChange });
}

export function deactivateUserAccount(staffId) {
  return callIdentity('deleteUserAccount', { staffId, mode: 'deactivate' });
}

export function removeUserAccount(staffId) {
  return callIdentity('deleteUserAccount', { staffId, mode: 'remove' });
}

// ── Legacy onboarding (accounts invited before v1.0) ────────────────────
export function checkUsername(username) {
  return callIdentity('checkUsername', { username: normalizeUsername(username) });
}

export function createAdminInvite(expiresInDays = 30) {
  return callIdentity('createAdminInvite', { expiresInDays });
}

export function previewAdminInvite(joiningCode) {
  return callIdentity('previewAdminInvite', { joiningCode: String(joiningCode || '').trim() });
}

export async function activateAdminInvite({ joiningCode, fullName, username, phoneNumber = '', pin }) {
  const result = await callIdentity('activateAdminInvite', { joiningCode: String(joiningCode || '').trim(), fullName, username: normalizeUsername(username), phoneNumber, pin });
  await signInWithFunctionToken(result);
  return result.profile || null;
}

export function previewJoiningCode(joiningCode) {
  return callIdentity('previewJoiningCode', { joiningCode: String(joiningCode || '').trim() });
}

export async function activateStaff({ joiningCode, pin }) {
  const result = await callIdentity('activateStaff', { joiningCode: String(joiningCode || '').trim(), pin });
  await signInWithFunctionToken(result);
  return result.profile || null;
}
