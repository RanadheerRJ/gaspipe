/* PumpLog — local App Lock
 *
 * App Lock is a DEVICE-level screen lock. It is not account authentication:
 * the PIN and the security-question answers are PBKDF2-hashed and stored in
 * this browser's localStorage only. They are never uploaded to Firebase,
 * never synced between devices, and disappear if site data is cleared.
 *
 * Station policy (stations/{id}/settings/security) decides whether the lock
 * is required, whether it engages on refresh / PWA reopen, and the inactivity
 * timeout. Everything enforcement-worthy stays in this module.
 */

import { validateAppLockPin, getEffectiveSecurity } from './station-settings.js';
import { h, toast } from './components.js';
import { doSignOut } from './auth.js';

const STORE_PREFIX = 'pumplog.applock.v1.';
const ATTEMPTS_PREFIX = 'pumplog.applock.attempts.';
const PBKDF2_ITERATIONS = 150_000;
const MAX_ATTEMPTS = 5;
const COOLDOWN_MS = 30_000;

export const SECURITY_QUESTIONS = Object.freeze([
  { id: 'favoriteColor', label: 'What is your favorite color?' },
  { id: 'favoriteFood', label: 'What is your favorite food?' },
  { id: 'firstSchool', label: 'What was the name of your first school?' },
  { id: 'birthMonth', label: 'What is your birth month?' },
  { id: 'favoriteMovie', label: 'What is your favorite movie?' },
  { id: 'childhoodNickname', label: 'What was your childhood nickname?' },
]);

// ── Crypto helpers ──────────────────────────────────────────────────────
const toHex = buf => Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');

async function pbkdf2(value, saltHex, iterations = PBKDF2_ITERATIONS) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(value), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: hexToBytes(saltHex), iterations },
    key, 256,
  );
  return toHex(bits);
}

function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function randomSaltHex() {
  return toHex(crypto.getRandomValues(new Uint8Array(16)).buffer);
}

const normalizeAnswer = value => String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');

async function hashRecord(value, existingSalt = null) {
  const salt = existingSalt || randomSaltHex();
  return { salt, iterations: PBKDF2_ITERATIONS, hash: await pbkdf2(value, salt) };
}

async function recordMatches(value, record) {
  if (!record?.salt || !record?.hash) return false;
  const hash = await pbkdf2(value, record.salt, record.iterations || PBKDF2_ITERATIONS);
  // Constant-time-ish compare for browser context.
  if (hash.length !== record.hash.length) return false;
  let diff = 0;
  for (let i = 0; i < hash.length; i += 1) diff |= hash.charCodeAt(i) ^ record.hash.charCodeAt(i);
  return diff === 0;
}

// ── Local storage ───────────────────────────────────────────────────────
function readState(uid) {
  try {
    const raw = localStorage.getItem(STORE_PREFIX + uid);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function writeState(uid, state) {
  localStorage.setItem(STORE_PREFIX + uid, JSON.stringify({ ...state, updatedAt: Date.now() }));
}

export function getAppLockStatus(uid) {
  const state = uid ? readState(uid) : null;
  return {
    configured: !!state?.pin?.hash,
    questionCount: (state?.questions || []).length,
    questions: (state?.questions || []).map(q => q.id),
  };
}

export async function setAppLockPin(uid, pin, { keepQuestions = true } = {}) {
  const existing = readState(uid) || {};
  const record = await hashRecord(String(pin));
  writeState(uid, {
    pin: record,
    questions: keepQuestions ? (existing.questions || []) : [],
    createdAt: existing.createdAt || Date.now(),
  });
}

export async function verifyAppLockPin(uid, pin) {
  const state = readState(uid);
  if (!state?.pin?.hash) return false;
  return recordMatches(String(pin), state.pin);
}

export async function saveSecurityAnswers(uid, pairs) {
  const state = readState(uid);
  if (!state?.pin?.hash) throw new Error('Set an App Lock PIN first.');
  const questions = [];
  for (const { id, answer } of pairs) {
    questions.push({ id, ...(await hashRecord(normalizeAnswer(answer))) });
  }
  writeState(uid, { ...state, questions });
}

export async function verifySecurityAnswers(uid, answers) {
  const state = readState(uid);
  const stored = state?.questions || [];
  if (!stored.length) return false;
  for (const record of stored) {
    const given = answers.find(a => a.id === record.id);
    if (!given || !(await recordMatches(normalizeAnswer(given.answer), record))) return false;
  }
  return true;
}

export function clearAppLock(uid) {
  localStorage.removeItem(STORE_PREFIX + uid);
  localStorage.removeItem(ATTEMPTS_PREFIX + uid);
}

// ── Attempt throttling ──────────────────────────────────────────────────
function attemptsRecord(uid) {
  try { return JSON.parse(localStorage.getItem(ATTEMPTS_PREFIX + uid) || '{}'); } catch { return {}; }
}

export function lockCooldownRemaining(uid) {
  const rec = attemptsRecord(uid);
  if (rec.cooldownUntil && rec.cooldownUntil > Date.now()) return rec.cooldownUntil - Date.now();
  return 0;
}

function noteFailedAttempt(uid) {
  const rec = attemptsRecord(uid);
  const fails = (rec.fails || 0) + 1;
  const updated = { fails };
  if (fails >= MAX_ATTEMPTS) {
    updated.fails = 0;
    updated.cooldownUntil = Date.now() + COOLDOWN_MS;
  }
  localStorage.setItem(ATTEMPTS_PREFIX + uid, JSON.stringify(updated));
  return { fails, cooldown: updated.cooldownUntil ? COOLDOWN_MS : 0 };
}

function clearFailedAttempts(uid) {
  localStorage.removeItem(ATTEMPTS_PREFIX + uid);
}

// ── Overlay state ───────────────────────────────────────────────────────
let overlayEl = null;
let activeUid = null;
let unlockHandler = null;
let inactivityTimer = null;
let hiddenSince = 0;
let activityBound = false;
let currentPolicy = null;
let pinBuffer = '';

function ensureOverlay() {
  if (overlayEl) return overlayEl;
  overlayEl = document.createElement('div');
  overlayEl.id = 'applock-screen';
  overlayEl.setAttribute('role', 'dialog');
  overlayEl.setAttribute('aria-modal', 'true');
  overlayEl.setAttribute('aria-label', 'App Lock');
  document.body.appendChild(overlayEl);
  return overlayEl;
}

function removeOverlay() {
  overlayEl?.remove();
  overlayEl = null;
  pinBuffer = '';
}

function paintDots(container) {
  const dots = container.querySelector('.applock-dots');
  if (!dots) return;
  dots.innerHTML = pinBuffer
    ? Array.from({ length: pinBuffer.length }, () => '<span class="applock-dot filled"></span>').join('')
    : '<span class="applock-hint-text">Enter your App Lock PIN</span>';
}

function overlayError(message) {
  const el = overlayEl?.querySelector('.applock-error');
  if (!el) return;
  el.textContent = message || '';
  el.classList.toggle('hidden', !message);
  if (message) {
    overlayEl.querySelector('.applock-card')?.classList.remove('applock-shake');
    requestAnimationFrame(() => overlayEl.querySelector('.applock-card')?.classList.add('applock-shake'));
  }
}

async function tryUnlock() {
  const uid = activeUid;
  const cooldown = lockCooldownRemaining(uid);
  if (cooldown) {
    overlayError(`❌ Too many attempts. Try again in ${Math.ceil(cooldown / 1000)}s.`);
    return;
  }
  const candidate = pinBuffer;
  pinBuffer = '';
  paintDots(overlayEl);
  if (!candidate) return;
  const ok = await verifyAppLockPin(uid, candidate);
  if (ok) {
    clearFailedAttempts(uid);
    const handler = unlockHandler;
    removeOverlay();
    toast('✅ App unlocked', 'success', 2000);
    startInactivityWatch();
    handler?.();
    return;
  }
  const { fails, cooldown: newCooldown } = noteFailedAttempt(uid);
  if (newCooldown) overlayError(`❌ Incorrect App Lock PIN. Locked for ${Math.round(newCooldown / 1000)}s.`);
  else overlayError(`❌ Incorrect App Lock PIN. ${MAX_ATTEMPTS - fails} attempt${MAX_ATTEMPTS - fails === 1 ? '' : 's'} left.`);
}

function keypadHTML() {
  const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', '⌫'];
  return `<div class="applock-keypad" role="group" aria-label="PIN keypad">${keys.map(k => k === ''
    ? '<span class="applock-key-empty" aria-hidden="true"></span>'
    : `<button type="button" class="applock-key" data-key="${k}" aria-label="${k === '⌫' ? 'Delete digit' : `Digit ${k}`}">${k}</button>`).join('')}</div>`;
}

function paintUnlockView(userLabel) {
  const cooldown = lockCooldownRemaining(activeUid);
  const status = getAppLockStatus(activeUid);
  overlayEl.innerHTML = `
    <div class="applock-card">
      <div class="applock-brand" aria-hidden="true">🔒</div>
      <h2 class="applock-title">App locked</h2>
      <p class="applock-subtitle">${userLabel ? `${h(userLabel)} · ` : ''}Enter your App Lock PIN to continue on this device.</p>
      <p class="applock-error ${cooldown ? '' : 'hidden'}" role="alert">${cooldown ? `❌ Too many attempts. Try again in ${Math.ceil(cooldown / 1000)}s.` : ''}</p>
      <div class="applock-dots" aria-live="polite"></div>
      ${keypadHTML()}
      <button type="button" class="btn btn-primary btn-full applock-unlock-btn" disabled>Unlock ✅</button>
      <div class="applock-links">
        ${status.questionCount >= 2 ? '<button type="button" class="link-btn" data-applock-mode="forgot">Forgot App Lock PIN?</button>' : ''}
        <button type="button" class="link-btn applock-signout">Sign out instead</button>
      </div>
    </div>`;
  paintDots(overlayEl);
  wireUnlockView();
}

function wireUnlockView() {
  const unlockBtn = overlayEl.querySelector('.applock-unlock-btn');
  overlayEl.querySelectorAll('.applock-key').forEach(btn => btn.addEventListener('click', () => {
    if (lockCooldownRemaining(activeUid)) return;
    const key = btn.dataset.key;
    if (key === '⌫') pinBuffer = pinBuffer.slice(0, -1);
    else if (pinBuffer.length < 8) pinBuffer += key;
    overlayError('');
    paintDots(overlayEl);
    unlockBtn.disabled = pinBuffer.length < 4;
  }));
  unlockBtn.addEventListener('click', tryUnlock);
  overlayEl.querySelector('[data-applock-mode="forgot"]')?.addEventListener('click', paintForgotView);
  overlayEl.querySelector('.applock-signout')?.addEventListener('click', async () => {
    removeOverlay();
    await doSignOut().catch(() => {});
  });
  overlayEl.onkeydown = e => { if (e.key === 'Enter' && pinBuffer.length >= 4) tryUnlock(); };
}

function paintForgotView() {
  const status = getAppLockStatus(activeUid);
  const rows = status.questions
    .map(id => SECURITY_QUESTIONS.find(q => q.id === id))
    .filter(Boolean)
    .map((q, i) => `
      <div class="field">
        <label for="applock-answer-${i}">${h(q.label)}</label>
        <input type="text" id="applock-answer-${i}" data-question-id="${h(q.id)}" autocomplete="off" required />
      </div>`).join('');
  overlayEl.innerHTML = `
    <div class="applock-card">
      <div class="applock-brand" aria-hidden="true">🛟</div>
      <h2 class="applock-title">Reset App Lock PIN</h2>
      <p class="applock-subtitle">Answer your security questions to create a new App Lock PIN for this device.</p>
      <p class="applock-error hidden" role="alert"></p>
      <form id="applock-forgot-form" novalidate>
        ${rows}
        <button type="submit" class="btn btn-primary btn-full">Verify answers ✅</button>
      </form>
      <div class="applock-links"><button type="button" class="link-btn" data-applock-mode="unlock">Back to unlock</button></div>
    </div>`;
  overlayEl.querySelector('[data-applock-mode="unlock"]').addEventListener('click', () => engageAppLock(unlockHandler));
  overlayEl.querySelector('#applock-forgot-form').addEventListener('submit', async e => {
    e.preventDefault();
    const inputs = [...overlayEl.querySelectorAll('input[data-question-id]')];
    const answers = inputs.map(input => ({ id: input.dataset.questionId, answer: input.value }));
    if (answers.some(a => !a.answer.trim())) {
      overlayError('❌ Answer every question to continue.');
      return;
    }
    const ok = await verifySecurityAnswers(activeUid, answers);
    if (ok) paintResetPinView();
    else overlayError('❌ Answers do not match the ones saved on this device.');
  });
}

function paintResetPinView() {
  overlayEl.innerHTML = `
    <div class="applock-card">
      <div class="applock-brand" aria-hidden="true">🔑</div>
      <h2 class="applock-title">Create new App Lock PIN</h2>
      <p class="applock-subtitle">Your identity was verified. Choose a new 4–8 digit PIN for this device.</p>
      <p class="applock-error hidden" role="alert"></p>
      <form id="applock-reset-form" novalidate>
        <div class="field"><label for="applock-new-pin">New App Lock PIN</label>
          <input type="password" id="applock-new-pin" inputmode="numeric" autocomplete="new-password" minlength="4" maxlength="8" required /></div>
        <div class="field"><label for="applock-confirm-pin">Confirm new PIN</label>
          <input type="password" id="applock-confirm-pin" inputmode="numeric" autocomplete="new-password" minlength="4" maxlength="8" required /></div>
        <button type="submit" class="btn btn-primary btn-full">Reset App Lock PIN ✅</button>
      </form>
    </div>`;
  overlayEl.querySelector('#applock-reset-form').addEventListener('submit', async e => {
    e.preventDefault();
    const pin = overlayEl.querySelector('#applock-new-pin').value;
    const confirm = overlayEl.querySelector('#applock-confirm-pin').value;
    const invalid = validateAppLockPin(pin);
    if (invalid) return overlayError(invalid);
    if (pin !== confirm) return overlayError('❌ PINs do not match.');
    await setAppLockPin(activeUid, pin);
    clearFailedAttempts(activeUid);
    removeOverlay();
    toast('✅ App Lock PIN Reset', 'success');
    startInactivityWatch();
    unlockHandler?.();
  });
}

/**
 * Show the lock over the running app. The app must call this before painting
 * sensitive screens; `onUnlock` resumes normal rendering.
 */
export function engageAppLock(onUnlock, userLabel = '') {
  unlockHandler = onUnlock || unlockHandler;
  stopInactivityWatch();
  const el = ensureOverlay();
  pinBuffer = '';
  el.classList.remove('hidden');
  paintUnlockView(userLabel);
  el.querySelector('.applock-key')?.focus?.();
}

/**
 * Lock the app for this user and resolve once they unlock.
 * Used at boot (refresh / PWA reopen) where the station policy requires it.
 */
export async function engageAppLockFor(user, userData, policy = null) {
  currentPolicy = policy || currentPolicy || await getEffectiveSecurity(userData);
  activeUid = user.uid;
  const name = userData.fullName || userData.email || userData.username || '';
  return new Promise(resolve => engageAppLock(resolve, name));
}

/**
 * Arm the session-level triggers (inactivity timer, tab return) without
 * showing the overlay. Called after the app shell becomes visible.
 */
export function armAppLockSession(user, policy) {
  if (!user || !policy?.appLockEnabled) return;
  currentPolicy = policy;
  activeUid = user.uid;
  if (policy.appLockOnInactivity) startInactivityWatch();
}

/** Re-apply an updated station policy to an armed session immediately. */
export function updateAppLockPolicy(policy) {
  if (!activeUid) return;
  currentPolicy = policy;
  if (policy?.appLockEnabled && policy.appLockOnInactivity) startInactivityWatch();
  else stopInactivityWatch();
}

// ── Inactivity & tab-return triggers ────────────────────────────────────
export function startInactivityWatch() {
  const policy = currentPolicy;
  if (!policy?.appLockEnabled || !policy.appLockOnInactivity || !activeUid) return;
  stopInactivityWatch();
  const ms = policy.appLockTimeoutMinutes * 60_000;
  const arm = () => {
    clearTimeout(inactivityTimer);
    inactivityTimer = setTimeout(() => {
      if (overlayEl) return;
      engageAppLock(unlockHandler, '');
    }, ms);
  };
  if (!activityBound) {
    activityBound = true;
    ['pointerdown', 'keydown', 'touchstart', 'wheel'].forEach(evt =>
      document.addEventListener(evt, () => { if (activeUid && inactivityTimer) arm(); }, { passive: true }));
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        hiddenSince = Date.now();
      } else if (activeUid && currentPolicy?.appLockEnabled) {
        const elapsed = Date.now() - (hiddenSince || 0);
        const timeout = (currentPolicy.appLockTimeoutMinutes || 3) * 60_000;
        // Tab reopened after the inactivity timeout → lock before painting.
        if (currentPolicy.appLockOnInactivity && hiddenSince && elapsed >= timeout && !overlayEl) {
          engageAppLock(unlockHandler, '');
        } else {
          arm();
        }
      }
    });
  }
  arm();
}

export function stopInactivityWatch() {
  clearTimeout(inactivityTimer);
  inactivityTimer = null;
}

export function resetAppLockForSignOut() {
  stopInactivityWatch();
  activeUid = null;
  unlockHandler = null;
  currentPolicy = null;
  removeOverlay();
}
