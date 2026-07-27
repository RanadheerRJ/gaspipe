/* PumpLog — trusted staff identity client bridge
 *
 * This module only sends validated input to callable Cloud Functions. PINs,
 * salts, hashes, joining-code records, lockout counters, and custom-token
 * creation stay inside functions/. The browser receives a Firebase Auth
 * session, never a credential secret.
 */

import {
  getAuthInstance, getFunctionsInstance, httpsCallable, signInWithCustomToken,
  setAuthPersistence,
} from './firebase.js';

async function callStaffFunction(name, data = {}) {
  const callable = httpsCallable(getFunctionsInstance(), name);
  const result = await callable(data);
  return result.data;
}

export const normalizeUsername = value => String(value || '').trim().toLowerCase();

export async function checkUsername(username) {
  return callStaffFunction('checkUsername', { username: normalizeUsername(username) });
}

export function previewJoiningCode(joiningCode) {
  return callStaffFunction('previewJoiningCode', { joiningCode: String(joiningCode || '').trim() });
}

export async function createStaff({ fullName, username, phoneNumber = '', stationIds }) {
  return callStaffFunction('createStaff', { fullName, username: normalizeUsername(username), phoneNumber, stationIds });
}

async function signInWithFunctionToken(result) {
  if (!result?.token) throw new Error('The identity service did not return a sign-in token.');
  await setAuthPersistence(true);
  await signInWithCustomToken(getAuthInstance(), result.token);
  return result.profile || null;
}

export async function activateStaff({ joiningCode, pin }) {
  const result = await callStaffFunction('activateStaff', { joiningCode: String(joiningCode || '').trim(), pin });
  await signInWithFunctionToken(result);
  return result.profile || null;
}

export async function signInWithUsernamePin({ username, pin, remember = true }) {
  await setAuthPersistence(remember);
  const result = await callStaffFunction('loginWithUsernamePin', {
    username: normalizeUsername(username),
    pin,
  });
  await signInWithFunctionToken(result);
  return result.profile || null;
}

export function resetStaffPin(staffId) {
  return callStaffFunction('resetStaffPin', { staffId });
}

export function disableStaff(staffId) {
  return callStaffFunction('disableStaff', { staffId });
}

export function prepareLegacyUsers() {
  return callStaffFunction('prepareLegacyUsers');
}

export function changeStaffPin({ currentPin, newPin }) {
  return callStaffFunction('changePin', { currentPin, newPin });
}

export function recordLogout() {
  return callStaffFunction('recordLogout');
}
