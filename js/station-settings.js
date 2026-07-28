/* PumpLog — station-level security settings
 *
 * Every station owns a `stations/{id}/settings/security` document that
 * controls the local App Lock and Cloud PIN policy for accounts assigned
 * to that station.
 *
 * Spark-plan/free mode keeps sign-in simple: email + Cloud PIN through
 * Firebase Authentication, with no Cloud Functions or paid backend API.
 */

import { getDb, doc, getDoc, setDoc, serverTimestamp, onSnapshot } from './firebase.js';
import { getCurrentUserData } from './auth.js';

export const SETTINGS_VERSION = 1;

export const DEFAULT_SECURITY = Object.freeze({
  // Free mode supports one sign-in method: email + Cloud PIN.
  enableEmailLogin: true,
  enableUsernameLogin: false,
  enablePasswordLogin: false,
  enablePinLogin: true,
  // Local App Lock (device-specific, never synced)
  appLockEnabled: false,
  appLockOnRefresh: true,
  appLockOnPwaReopen: true,
  appLockOnInactivity: true,
  appLockTimeoutMinutes: 3,
  // Credential policies
  minPasswordLength: 8,
  minPinLength: 4,
  passwordComplexity: 'lettersNumbers', // 'none' | 'lettersNumbers' | 'strong'
  pinComplexity: 'standard',            // 'digits' | 'standard' (no repeats/sequences)
  pinRotationDays: 0,                   // 0 = rotation never forced
});

export const PASSWORD_COMPLEXITY_OPTIONS = [
  ['none', 'Any characters'],
  ['lettersNumbers', 'Letters + numbers'],
  ['strong', 'Uppercase, lowercase, number + symbol'],
];

export const PIN_COMPLEXITY_OPTIONS = [
  ['digits', 'Digits only (any combination)'],
  ['standard', 'No repeated or sequential digits'],
];

const clampInt = (value, min, max, fallback) => {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
};

/** Fill gaps, clamp ranges — safe against old documents and partial writes. */
export function normalizeSecurity(raw = {}) {
  const merged = { ...DEFAULT_SECURITY, ...(raw || {}) };
  merged.enableEmailLogin = merged.enableEmailLogin !== false;
  merged.enableUsernameLogin = merged.enableUsernameLogin === true;
  merged.enablePasswordLogin = merged.enablePasswordLogin === true;
  merged.enablePinLogin = merged.enablePinLogin !== false;
  merged.appLockEnabled = merged.appLockEnabled === true;
  merged.appLockOnRefresh = merged.appLockOnRefresh !== false;
  merged.appLockOnPwaReopen = merged.appLockOnPwaReopen !== false;
  merged.appLockOnInactivity = merged.appLockOnInactivity !== false;
  merged.appLockTimeoutMinutes = clampInt(merged.appLockTimeoutMinutes, 1, 120, DEFAULT_SECURITY.appLockTimeoutMinutes);
  merged.minPasswordLength = clampInt(merged.minPasswordLength, 6, 64, DEFAULT_SECURITY.minPasswordLength);
  merged.minPinLength = clampInt(merged.minPinLength, 4, 8, DEFAULT_SECURITY.minPinLength);
  if (!PASSWORD_COMPLEXITY_OPTIONS.some(([v]) => v === merged.passwordComplexity)) {
    merged.passwordComplexity = DEFAULT_SECURITY.passwordComplexity;
  }
  if (!PIN_COMPLEXITY_OPTIONS.some(([v]) => v === merged.pinComplexity)) {
    merged.pinComplexity = DEFAULT_SECURITY.pinComplexity;
  }
  merged.pinRotationDays = clampInt(merged.pinRotationDays, 0, 365, 0);
  return merged;
}

// ── Loading & caching ───────────────────────────────────────────────────
// Short TTL: station settings pages and the login screen always feel live,
// while repeated renders within a session avoid duplicate reads.
const TTL = 30_000;
const cache = new Map();

export function invalidateSecuritySettings(stationId = null) {
  if (!stationId) cache.clear();
  else cache.delete(`sec:${stationId}`);
}

export async function getSecuritySettings(stationId) {
  if (!stationId) return { ...DEFAULT_SECURITY };
  const key = `sec:${stationId}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL) return hit.value;
  try {
    const snap = await getDoc(doc(getDb(), 'stations', stationId, 'settings', 'security'));
    const value = normalizeSecurity(snap.exists() ? snap.data() : {});
    cache.set(key, { value, at: Date.now() });
    return value;
  } catch {
    // Offline or rules not yet published — fall back to permissive defaults
    // so existing behaviour never regresses.
    return { ...DEFAULT_SECURITY };
  }
}

/**
 * Merge the settings of several stations into one effective policy.
 * Login methods and App Lock use "any station allows/requires"; credential
 * policies use the strictest value across the list.
 */
export function mergeSecurity(list) {
  const items = (list || []).filter(Boolean).map(normalizeSecurity);
  if (!items.length) return { ...DEFAULT_SECURITY };
  const strongestComplexity = (values, order) =>
    values.reduce((best, v) => (order.indexOf(v) > order.indexOf(best) ? v : best), order[0]);
  const merged = {
    enableEmailLogin: items.some(s => s.enableEmailLogin),
    enableUsernameLogin: items.some(s => s.enableUsernameLogin),
    enablePasswordLogin: items.some(s => s.enablePasswordLogin),
    enablePinLogin: items.some(s => s.enablePinLogin),
    appLockEnabled: items.some(s => s.appLockEnabled),
    appLockOnRefresh: items.some(s => s.appLockEnabled && s.appLockOnRefresh),
    appLockOnPwaReopen: items.some(s => s.appLockEnabled && s.appLockOnPwaReopen),
    appLockOnInactivity: items.some(s => s.appLockEnabled && s.appLockOnInactivity),
    appLockTimeoutMinutes: Math.min(...items.filter(s => s.appLockEnabled).map(s => s.appLockTimeoutMinutes), Infinity),
    minPasswordLength: Math.max(...items.map(s => s.minPasswordLength)),
    minPinLength: Math.max(...items.map(s => s.minPinLength)),
    passwordComplexity: strongestComplexity(items.map(s => s.passwordComplexity), ['none', 'lettersNumbers', 'strong']),
    pinComplexity: strongestComplexity(items.map(s => s.pinComplexity), ['digits', 'standard']),
    pinRotationDays: Math.min(...items.map(s => s.pinRotationDays).filter(d => d > 0), Infinity),
  };
  if (!Number.isFinite(merged.appLockTimeoutMinutes)) merged.appLockTimeoutMinutes = DEFAULT_SECURITY.appLockTimeoutMinutes;
  if (!Number.isFinite(merged.pinRotationDays)) merged.pinRotationDays = 0;
  return merged;
}

/** The effective policy for a signed-in user across all their stations. */
export async function getEffectiveSecurity(userData = getCurrentUserData()) {
  if (!userData) return { ...DEFAULT_SECURITY };
  // Super Admins (no station list) follow the per-station settings of the
  // stations they sign in to; with none selected, defaults apply.
  const ids = userData.stationIds || [];
  if (!ids.length) return { ...DEFAULT_SECURITY };
  const settings = await Promise.all(ids.map(getSecuritySettings));
  return mergeSecurity(settings);
}

// ── Persistence (managers only, enforced by firestore.rules) ────────────
export async function saveSecuritySettings(stationId, patch) {
  const me = getCurrentUserData();
  if (!stationId || !me) throw new Error('❌ Select a station before saving security settings.');
  const payload = {
    ...normalizeSecurity(patch),
    updatedAt: serverTimestamp(),
    updatedBy: me.uid,
    settingsVersion: SETTINGS_VERSION,
  };
  await setDoc(doc(getDb(), 'stations', stationId, 'settings', 'security'), payload, { merge: true });
  invalidateSecuritySettings(stationId);
  window.dispatchEvent(new CustomEvent('pumplog:securityChanged', { detail: { stationId, settings: payload } }));
  return normalizeSecurity(payload);
}

/** Live subscription — login screen and Config reflect edits immediately. */
export function watchSecuritySettings(stationId, onUpdate) {
  if (!stationId) return () => {};
  return onSnapshot(
    doc(getDb(), 'stations', stationId, 'settings', 'security'),
    snap => {
      const value = normalizeSecurity(snap.exists() ? snap.data() : {});
      cache.set(`sec:${stationId}`, { value, at: Date.now() });
      onUpdate?.(value);
    },
    () => onUpdate?.(null),
  );
}

// ── Login method matrix ─────────────────────────────────────────────────
export const LOGIN_METHODS = Object.freeze([
  { id: 'email-pin', identifier: 'email', secret: 'pin', label: 'Email + Cloud PIN', icon: '📧' },
]);

export function enabledLoginMethods(settings) {
  const s = normalizeSecurity(settings);
  return LOGIN_METHODS.filter(m =>
    (m.identifier === 'email' ? s.enableEmailLogin : s.enableUsernameLogin) &&
    (m.secret === 'password' ? s.enablePasswordLogin : s.enablePinLogin));
}

// ── Policy validators (return a friendly error string or null) ──────────
export function validatePasswordPolicy(password, settings) {
  const s = normalizeSecurity(settings);
  const value = String(password || '');
  if (value.length < s.minPasswordLength) {
    return `❌ Password must be at least ${s.minPasswordLength} characters.`;
  }
  if (s.passwordComplexity === 'lettersNumbers' && !( /[a-zA-Z]/.test(value) && /\d/.test(value))) {
    return '❌ Password must contain both letters and numbers.';
  }
  if (s.passwordComplexity === 'strong'
    && !( /[a-z]/.test(value) && /[A-Z]/.test(value) && /\d/.test(value) && /[^a-zA-Z0-9]/.test(value))) {
    return '❌ Password must include uppercase, lowercase, a number, and a symbol.';
  }
  return null;
}

export function validateCloudPinPolicy(pin, settings) {
  const s = normalizeSecurity(settings);
  const value = String(pin || '');
  if (!new RegExp(`^\\d{${s.minPinLength},8}$`).test(value)) {
    return `❌ Cloud PIN must be ${s.minPinLength}–8 digits.`;
  }
  if (s.pinComplexity === 'standard') {
    if (/^(\d)\1+$/.test(value)) return '❌ Cloud PIN cannot be the same digit repeated.';
    const forward = '0123456789';
    const backward = '9876543210';
    if (forward.includes(value) || backward.includes(value)) {
      return '❌ Cloud PIN cannot be a simple sequence like 1234.';
    }
  }
  return null;
}

/** Local App Lock PINs are always 4–8 digits and live only on the device. */
export function validateAppLockPin(pin) {
  const value = String(pin || '');
  if (!/^\d{4,8}$/.test(value)) return '❌ App Lock PIN must be 4–8 digits.';
  if (/^(\d)\1+$/.test(value)) return '❌ App Lock PIN cannot be the same digit repeated.';
  const forward = '0123456789';
  const backward = '9876543210';
  if (value.length >= 4 && (forward.includes(value) || backward.includes(value))) {
    return '❌ App Lock PIN cannot be a simple sequence like 1234.';
  }
  return null;
}

export const isValidEmail = value => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(value || '').trim());
export const isValidUsername = value => /^[a-z0-9_.]{4,16}$/.test(String(value || '').trim().toLowerCase());
