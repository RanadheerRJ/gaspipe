/* PumpLog — application shell
 *
 * Sign-in gate order, every sign-in:
 *   1. Forced password change   (temporary password accounts)
 *   2. Forced Cloud PIN change  (temporary PIN or station rotation policy)
 *   3. Local App Lock           (device PIN — refresh / PWA reopen)
 *   4. App shell renders
 */

import { initMainApp, setAuthPersistence } from './firebase.js';
import {
  initAuth, onAuthChange, getCurrentUser, getCurrentUserData,
  isSuperAdmin, isStationAdmin, isStaff, can,
  doSignOut, signIn, formatFirebaseError,
} from './auth.js';
import {
  getAllStations, getStationsByIds, invalidate,
} from './store.js';
import {
  h, openModal, closeModal, closeAllModals, showLoading, toast, toastError,
  toastSuccess, setBusy,
} from './components.js';
import {
  DEFAULT_SECURITY, getSecuritySettings, watchSecuritySettings,
  enabledLoginMethods, getEffectiveSecurity, invalidateSecuritySettings,
  validateCloudPinPolicy,
} from './station-settings.js';
import {
  getAppLockStatus, engageAppLockFor, armAppLockSession,
  resetAppLockForSignOut, updateAppLockPolicy,
} from './app-lock.js';
import { initDashboard, renderDashboard, stopLiveFeed } from './dashboard.js';
import { initPumps, renderPumps, stopPumpsLive } from './pumps.js';
import { initConfig, renderConfig } from './config-page.js';
import { initHistory, renderHistory } from './history.js';
import { initReports, renderReports } from './reports.js';
import {
  listPublicStations, signInWithUsernamePin, signInWithEmailPin,
  resolveLoginIdentifier, previewJoiningCode, activateStaff,
  previewAdminInvite, activateAdminInvite, recordLogin, recordLogout, getMyPinStatus,
} from './staff-auth.js';
import {
  openProfileModal, openForcedPasswordChange, openForcedCloudPinChange,
  openAppLockSetupModal,
} from './profile.js';

const $ = id => document.getElementById(id);
const STORE_KEY = 'pumplog:lastStation';
const LOGIN_STATION_KEY = 'pumplog:lastLoginStation';

let currentStationId = null;
let userStations = [];
let currentPage = 'dashboard';
let currentRange = 'today';
let authMode = 'signin';
let authMethod = 'username-pin';
let authSubmitting = false;
let uiReady = false;
let renderToken = 0;
let pendingJoin = null;

let loginStations = [];
let loginStationId = null;
let loginPolicy = { ...DEFAULT_SECURITY };
let loginSettingsUnsub = null;
let appLockPromptShown = false;

// ── Boot ────────────────────────────────────────────────────────────────
initAuth();
document.addEventListener('DOMContentLoaded', () => {
  setupAuthForm();
  loadLoginStations();
}, { once: true });

window.addEventListener('pumplog:stationsChanged', async (event) => {
  invalidate();
  await loadUserStations();

  const next = event.detail?.stationId;
  if (next && userStations.some(s => s.id === next)) {
    setStation(next);
  } else if (!userStations.some(s => s.id === currentStationId)) {
    setStation(userStations[0]?.id || null);
  }
  renderCurrentPage();
});

// Station security edits apply immediately inside an armed session.
window.addEventListener('pumplog:securityChanged', async () => {
  const userData = getCurrentUserData();
  if (!userData) return;
  const policy = await getEffectiveSecurity(userData);
  updateAppLockPolicy(policy);
});

// ── Auth state ──────────────────────────────────────────────────────────
onAuthChange(async (user, userData, authError) => {
  if (user && userData) {
    await runSignInGate(user, userData);
  } else {
    resetAppLockForSignOut();
    $('auth-screen').classList.remove('hidden');
    $('app-shell').classList.add('hidden');
    closeAllModals();
    showLoading(false);
    resetAuthSubmit();
    stopLiveFeed();
    stopPumpsLive();
    currentStationId = null;
    userStations = [];
    currentPage = 'dashboard';
    appLockPromptShown = false;
    invalidate();
    if (authMode !== 'signin') setAuthMode('signin');
    watchLoginSettings(loginStationId);

    if (authError) {
      showAuthMessage(formatFirebaseError(authError), 'error');
    }
  }
});

/**
 * Block the app shell until mandatory credential and lock steps complete.
 */
async function runSignInGate(user, userData) {
  initMainApp();
  $('auth-screen').classList.add('hidden');
  showLoading(true);
  clearAuthMessage();
  resetAuthSubmit();

  try {
    const status = await getMyPinStatus().catch(() => null);

    if (status?.passwordResetRequired) {
      showLoading(false);
      await openForcedPasswordChange(status); // resolved only on success
      showLoading(true);
      if (!getCurrentUser()) { showLoading(false); return; } // chose "Sign out instead"
    }
    if (status?.pinResetRequired || status?.pinRotationRequired) {
      showLoading(false);
      await openForcedCloudPinChange(status);
      showLoading(true);
      if (!getCurrentUser()) { showLoading(false); return; }
    }

    // Local App Lock — device bound, station policies drive the triggers.
    const policy = await getEffectiveSecurity(userData);
    if (policy.appLockEnabled) {
      const lockStatus = getAppLockStatus(user.uid);
      if (lockStatus.configured && (policy.appLockOnRefresh || policy.appLockOnPwaReopen)) {
        showLoading(false);
        await engageAppLockFor(user, userData, policy); // resolves on unlock
      }
    }

    await enterApp(user, policy);
  } catch (err) {
    showLoading(false);
    $('auth-screen').classList.remove('hidden');
    setAuthMode('signin');
    showAuthMessage(formatFirebaseError(err), 'error');
    await doSignOut().catch(() => {});
  }
}

async function enterApp(user, policy) {
  const userData = getCurrentUserData();
  showLoading(false);
  $('auth-screen').classList.add('hidden');
  $('app-shell').classList.remove('hidden');
  loginSettingsUnsub?.();
  loginSettingsUnsub = null;

  initDashboard();
  initPumps();
  initConfig();
  initHistory();
  initReports();

  setupUI();
  applyRoleVisibility();

  await loadUserStations();
  restoreStation(userData);

  if (!currentStationId && isSuperAdmin()) currentPage = 'config';
  renderCurrentPage();

  // App Lock session triggers — and a one-time setup offer when the station
  // requires a lock but this device has no local PIN yet.
  if (policy?.appLockEnabled) {
    if (getAppLockStatus(user.uid).configured) {
      armAppLockSession(user, policy);
    } else if (!appLockPromptShown) {
      appLockPromptShown = true;
      window.setTimeout(() => openAppLockSetupModal({ dismissible: true }), 900);
    }
  }
}

// ── Stations ────────────────────────────────────────────────────────────
async function loadUserStations() {
  const userData = getCurrentUserData();
  if (!userData) return;
  try {
    userStations = isSuperAdmin()
      ? await getAllStations()
      : await getStationsByIds(userData.stationIds || []);
  } catch (err) {
    toastError(formatFirebaseError(err));
    userStations = [];
  }
}

function restoreStation(userData) {
  const remembered = localStorage.getItem(STORE_KEY);
  if (remembered && userStations.some(s => s.id === remembered)) {
    setStation(remembered);
    return;
  }
  const firstAssigned = (userData.stationIds || []).find(id => userStations.some(s => s.id === id));
  setStation(firstAssigned || userStations[0]?.id || null);
}

function setStation(stationId) {
  currentStationId = stationId || null;
  if (currentStationId) {
    localStorage.setItem(STORE_KEY, currentStationId);
  } else {
    localStorage.removeItem(STORE_KEY);
  }
  const name = userStations.find(s => s.id === currentStationId)?.name;
  $('station-name-display').textContent = name || 'Select station';
}

// ── Routing ─────────────────────────────────────────────────────────────
async function renderCurrentPage() {
  const content = $('page-content');
  if (!content) return;

  // Guard against a slow earlier render overwriting a newer one.
  const token = ++renderToken;
  content.setAttribute('aria-busy', 'true');

  if (currentPage === 'config' && !can('config.view')) currentPage = 'dashboard';
  if (currentPage === 'reports' && !can('report.view', { stationId: currentStationId })) currentPage = 'dashboard';

  // Keep live listeners attached only to the screen currently using them.
  if (currentPage !== 'dashboard') stopLiveFeed();
  if (currentPage !== 'pumps') stopPumpsLive();

  document.querySelectorAll('.tab').forEach(tab => {
    const active = tab.dataset.page === currentPage;
    tab.classList.toggle('tab-active', active);
    if (active) tab.setAttribute('aria-current', 'page');
    else tab.removeAttribute('aria-current');
  });

  // The range chips only affect Dashboard and History.
  $('quick-chips').hidden = !(currentPage === 'dashboard' || currentPage === 'history');

  try {
    switch (currentPage) {
      case 'pumps':   await renderPumps(currentStationId); break;
      case 'config':  await renderConfig(currentStationId); break;
      case 'history': await renderHistory(currentStationId, currentRange); break;
      case 'reports': await renderReports(currentStationId); break;
      default:        await renderDashboard(currentStationId, currentRange);
    }
  } catch (err) {
    toastError(formatFirebaseError(err));
  } finally {
    if (token === renderToken) content.setAttribute('aria-busy', 'false');
  }
}

function applyRoleVisibility() {
  const configTab = document.querySelector('[data-page="config"]');
  if (configTab) configTab.hidden = !can('config.view');
  const reportsTab = document.querySelector('[data-page="reports"]');
  if (reportsTab) reportsTab.hidden = !(isSuperAdmin() || isStationAdmin() || isStaff());
}

// ── Refresh ─────────────────────────────────────────────────────────────
let refreshing = false;

async function refreshData(source) {
  if (refreshing) return;
  refreshing = true;

  const fab = $('fab-refresh');
  const topBtn = $('btn-refresh');
  [fab, topBtn].forEach(b => b?.classList.add('is-spinning'));
  fab?.setAttribute('aria-busy', 'true');

  try {
    invalidate();               // drop every cached query
    invalidateSecuritySettings();
    await loadUserStations();
    if (currentStationId && !userStations.some(s => s.id === currentStationId)) {
      setStation(userStations[0]?.id || null);
    }
    await renderCurrentPage();
    if (source === 'user') toastSuccess('Data refreshed.', 2000);
  } catch (err) {
    toastError(formatFirebaseError(err));
  } finally {
    refreshing = false;
    [fab, topBtn].forEach(b => b?.classList.remove('is-spinning'));
    fab?.removeAttribute('aria-busy');
  }
}

// ═══════════════════════════════════════════════════════════════════════
//  Sign-in screen
// ═══════════════════════════════════════════════════════════════════════

async function loadLoginStations() {
  const select = $('auth-station');
  const hint = $('auth-station-hint');
  if (!select) return;
  select.innerHTML = '<option value="">Loading stations…</option>';
  select.disabled = true;
  try {
    const { stations } = await listPublicStations();
    loginStations = stations || [];
  } catch (err) {
    loginStations = [];
    if (hint) hint.textContent = 'Could not load the station list. Check your connection, then refresh.';
    select.innerHTML = '<option value="">Administrator sign-in</option>';
    select.disabled = false;
    loginStationId = '';
    await applyLoginPolicy('');
    return;
  }

  if (!loginStations.length) {
    // A new deployment with no stations configured yet.
    select.innerHTML = '<option value="">Administrator sign-in</option>';
    select.disabled = false;
    if (hint) hint.textContent = 'No stations configured yet. Sign in as an administrator to create one.';
    loginStationId = '';
    await applyLoginPolicy('');
    return;
  }

  select.disabled = false;
  select.innerHTML = loginStations.map(s => `<option value="${h(s.id)}">${h(s.name)}</option>`).join('');
  const remembered = localStorage.getItem(LOGIN_STATION_KEY);
  loginStationId = loginStations.some(s => s.id === remembered) ? remembered : loginStations[0].id;
  select.value = loginStationId;
  select.addEventListener('change', async () => {
    loginStationId = select.value;
    localStorage.setItem(LOGIN_STATION_KEY, loginStationId);
    await applyLoginPolicy(loginStationId);
  });
  await applyLoginPolicy(loginStationId);
}

/** Refresh the visible sign-in methods for the selected station. */
async function applyLoginPolicy(stationId) {
  loginPolicy = await getSecuritySettings(stationId);
  const methods = enabledLoginMethods(loginPolicy);
  if (!methods.some(m => m.id === authMethod)) {
    authMethod = methods[0]?.id || 'username-pin';
  }
  if (authMode === 'signin' && !authSubmitting) renderAuthFields();
  watchLoginSettings(stationId);
}

function watchLoginSettings(stationId) {
  loginSettingsUnsub?.();
  loginSettingsUnsub = null;
  if (!stationId) return;
  loginSettingsUnsub = watchSecuritySettings(stationId, settings => {
    if (!settings) return;
    loginPolicy = settings;
    if (authMode === 'signin' && !authSubmitting) {
      const methods = enabledLoginMethods(loginPolicy);
      if (!methods.some(m => m.id === authMethod)) {
        authMethod = methods[0]?.id || 'username-pin';
      }
      renderAuthFields();
    }
  });
}

// ── Auth form ───────────────────────────────────────────────────────────
function showAuthMessage(message, type = 'error') {
  const el = $('auth-error');
  if (!el) return;
  el.textContent = message;
  el.className = `auth-msg auth-${type}`;
}

function clearAuthMessage() {
  const el = $('auth-error');
  if (!el) return;
  el.textContent = '';
  el.className = 'auth-msg hidden';
}

const authSubmitLabel = () => ({
  signin: 'Sign in',
  join: 'Continue',
  joinPin: 'Activate account ✅',
  adminJoin: 'Continue',
  adminJoinPin: 'Create Station Admin ✅',
}[authMode] || 'Sign in');

function resetAuthSubmit() {
  authSubmitting = false;
  const btn = $('auth-submit');
  if (!btn) return;
  btn.disabled = false;
  btn.removeAttribute('aria-busy');
  btn.textContent = authSubmitLabel();
}

function setAuthSubmitting(busy) {
  authSubmitting = busy;
  const btn = $('auth-submit');
  if (!btn) return;
  btn.disabled = busy;
  if (busy) {
    btn.setAttribute('aria-busy', 'true');
    btn.textContent = authMode === 'signin' ? 'Signing in…'
      : authMode === 'joinPin' || authMode === 'adminJoinPin' ? 'Activating…' : 'Checking…';
  } else {
    btn.removeAttribute('aria-busy');
    btn.textContent = authSubmitLabel();
  }
}

function pinFieldHTML({ id, label, autocomplete = 'current-password' }) {
  return `<div class="field"><label for="${id}">${label}</label><div class="input-affix">
    <input type="password" id="${id}" inputmode="numeric" autocomplete="${autocomplete}" pattern="[0-9]{4,8}" minlength="4" maxlength="8" required />
    <button type="button" class="affix-btn" data-password-toggle="${id}" aria-label="Show PIN" aria-pressed="false">Show</button></div></div>`;
}

function passwordFieldHTML({ id, label, autocomplete = 'current-password', note = '' }) {
  return `<div class="field"><label for="${id}">${label}</label><div class="input-affix">
    <input type="password" id="${id}" autocomplete="${autocomplete}" required />
    <button type="button" class="affix-btn" data-password-toggle="${id}" aria-label="Show password" aria-pressed="false">Show</button></div>
    ${note ? `<small class="hint">${note}</small>` : ''}</div>`;
}

function wireAuthFields() {
  document.querySelectorAll('#auth-fields input').forEach(input =>
    input.addEventListener('input', () => { if (!authSubmitting) clearAuthMessage(); }));
  document.querySelectorAll('[data-password-toggle]').forEach(toggle => {
    toggle.addEventListener('click', () => {
      const field = document.getElementById(toggle.dataset.passwordToggle);
      if (!field) return;
      const show = field.type === 'password';
      field.type = show ? 'text' : 'password';
      toggle.textContent = show ? 'Hide' : 'Show';
      toggle.setAttribute('aria-pressed', String(show));
      toggle.setAttribute('aria-label', show ? 'Hide secret' : 'Show secret');
    });
  });
}

function renderMethodTabs() {
  const host = $('auth-methods');
  if (!host) return;
  const methods = enabledLoginMethods(loginPolicy);
  if (authMode !== 'signin' || methods.length <= 1) {
    host.classList.add('hidden');
    host.innerHTML = '';
    return;
  }
  host.classList.remove('hidden');
  host.innerHTML = methods.map(m => `
    <button type="button" role="tab" class="auth-method-tab ${m.id === authMethod ? 'is-active' : ''}"
      data-method="${m.id}" aria-selected="${m.id === authMethod}">${m.label}</button>`).join('');
  host.querySelectorAll('[data-method]').forEach(btn => btn.addEventListener('click', () => {
    authMethod = btn.dataset.method;
    renderAuthFields();
  }));
}

function signinFieldsHTML() {
  const remember = '<label class="remember-row"><input type="checkbox" id="auth-remember" checked /> <span>Remember me on this device</span></label>';
  switch (authMethod) {
    case 'email-password':
      return `<div class="field"><label for="auth-email">Email</label>
          <input type="email" id="auth-email" autocomplete="email" autocapitalize="off" spellcheck="false" required /></div>
        ${passwordFieldHTML({ id: 'auth-password', label: 'Password' })}${remember}`;
    case 'username-password':
      return `<div class="field"><label for="auth-username">Username</label>
          <input type="text" id="auth-username" autocomplete="username" autocapitalize="off" spellcheck="false" minlength="4" maxlength="16" required /></div>
        ${passwordFieldHTML({ id: 'auth-password', label: 'Password' })}${remember}`;
    case 'email-pin':
      return `<div class="field"><label for="auth-email">Email</label>
          <input type="email" id="auth-email" autocomplete="email" autocapitalize="off" spellcheck="false" required /></div>
        ${pinFieldHTML({ id: 'auth-pin', label: 'Cloud PIN' })}${remember}`;
    case 'username-pin':
    default:
      return `<div class="field"><label for="auth-username">Username</label>
          <input type="text" id="auth-username" autocomplete="username" autocapitalize="off" spellcheck="false" minlength="4" maxlength="16" required /></div>
        ${pinFieldHTML({ id: 'auth-pin', label: 'Cloud PIN' })}${remember}`;
  }
}

function renderAuthFields() {
  const fields = $('auth-fields');
  const links = $('auth-links');
  if (!fields || !links) return;
  renderMethodTabs();

  const methods = enabledLoginMethods(loginPolicy);
  if (authMode === 'signin') {
    if (methods.length === 0) {
      fields.innerHTML = `<div class="auth-info-card"><span aria-hidden="true">🚫</span>
        <p>All sign-in methods are disabled for this station. Contact your Station Admin to enable one in Config → Station Security.</p></div>`;
    } else {
      fields.innerHTML = signinFieldsHTML();
    }
    links.innerHTML = `<button type="button" class="link-btn" data-auth-mode="forgot">Forgot Cloud PIN?</button>
      <span class="auth-link-separator">·</span><button type="button" class="link-btn" data-auth-mode="join">Join with code</button>
      <span class="auth-link-separator">·</span><button type="button" class="link-btn" data-auth-mode="adminJoin">Join as Station Admin</button>`;
  } else if (authMode === 'join') {
    fields.innerHTML = `<p class="auth-step-note">Enter the 5-digit code your admin shared with you.</p>
      <div class="field"><label for="auth-joining-code">Joining code</label>
        <input type="text" id="auth-joining-code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{5}" maxlength="5" placeholder="00000" required /></div>`;
    links.innerHTML = `<button type="button" class="link-btn" data-auth-mode="signin">Back to sign in</button>`;
  } else if (authMode === 'joinPin') {
    fields.innerHTML = `<div class="join-welcome"><span class="join-welcome-icon" aria-hidden="true">✓</span><p>Welcome, <strong>${h(pendingJoin?.fullName || 'there')}</strong></p><small>Username: ${h(pendingJoin?.username || '')}</small></div>
      <p class="auth-step-note">Create a private Cloud PIN of 4–8 digits. Avoid repeated or sequential numbers.</p>
      ${pinFieldHTML({ id: 'auth-new-pin', label: 'Create Cloud PIN', autocomplete: 'new-password' })}
      ${pinFieldHTML({ id: 'auth-confirm-pin', label: 'Confirm Cloud PIN', autocomplete: 'new-password' })}`;
    links.innerHTML = `<button type="button" class="link-btn" data-auth-mode="join">Use a different code</button>`;
  } else if (authMode === 'adminJoin') {
    fields.innerHTML = `<p class="auth-step-note">Enter the 10-digit invite code from your PumpLog administrator.</p>
      <div class="field"><label for="auth-admin-code">Station Admin invite code</label><input type="text" id="auth-admin-code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{10}" maxlength="10" placeholder="0000000000" required /></div>`;
    links.innerHTML = `<button type="button" class="link-btn" data-auth-mode="signin">Back to sign in</button>`;
  } else if (authMode === 'adminJoinPin') {
    fields.innerHTML = `<div class="join-welcome"><span class="join-welcome-icon" aria-hidden="true">🔷</span><p>Create your Station Admin profile</p><small>Invite verified · choose your own username and Cloud PIN</small></div>
      <div class="field"><label for="admin-full-name">Full name</label><input type="text" id="admin-full-name" maxlength="80" autocomplete="name" required /></div>
      <div class="field"><label for="admin-username">Username</label><input type="text" id="admin-username" minlength="4" maxlength="16" pattern="[a-zA-Z0-9_.]+" autocomplete="username" autocapitalize="off" required /></div>
      <div class="field"><label for="admin-phone">Phone number <span class="optional">(optional)</span></label><input type="tel" id="admin-phone" autocomplete="tel" inputmode="tel" /></div>
      ${pinFieldHTML({ id: 'admin-pin', label: 'Create Cloud PIN', autocomplete: 'new-password' })}
      ${pinFieldHTML({ id: 'admin-confirm-pin', label: 'Confirm Cloud PIN', autocomplete: 'new-password' })}`;
    links.innerHTML = `<button type="button" class="link-btn" data-auth-mode="adminJoin">Use a different invite</button>`;
  } else {
    fields.innerHTML = `<div class="auth-info-card"><span aria-hidden="true">🔐</span><p>For security, Cloud PIN resets are issued by a Station Admin or Super Admin as a temporary PIN or one-time joining code. Ask your admin for a reset.</p></div>
      <div class="auth-info-card"><span aria-hidden="true">📱</span><p>Forgot your <strong>App Lock</strong> PIN? Use “Forgot App Lock PIN?” on the lock screen and answer your security questions.</p></div>`;
    links.innerHTML = `<button type="button" class="link-btn" data-auth-mode="signin">Back to sign in</button>`;
  }
  wireAuthFields();
  document.querySelectorAll('[data-auth-mode]').forEach(button =>
    button.addEventListener('click', () => setAuthMode(button.dataset.authMode)));
  resetAuthSubmit();
  $('auth-submit').hidden = authMode === 'forgot' || (authMode === 'signin' && methods.length === 0);
}

function setAuthMode(mode) {
  authMode = mode;
  if (mode !== 'joinPin' && mode !== 'adminJoinPin') pendingJoin = null;
  const titles = {
    signin: 'Sign in', join: 'Join organization', joinPin: 'Set your Cloud PIN',
    adminJoin: 'Join as Station Admin', adminJoinPin: 'Create your profile', forgot: 'Forgot your credentials',
  };
  const stationName = loginStations.find(s => s.id === loginStationId)?.name;
  const subtitles = {
    signin: stationName ? `Signing in to ${stationName}.` : 'Sign in to PumpLog.',
    join: 'Activate your staff account securely.',
    joinPin: 'Your Cloud PIN is stored securely in Firebase — never in this app.',
    adminJoin: 'Use the 10-digit invite from your administrator.',
    adminJoinPin: 'Your new Station Admin account is secured by your Cloud PIN.',
    forgot: 'How account recovery works.',
  };
  $('auth-title').textContent = titles[mode] || 'Sign in';
  $('auth-subtitle').textContent = subtitles[mode] || '';
  $('auth-station-field').classList.toggle('hidden', mode !== 'signin');
  renderAuthFields();
}

function setupAuthForm() {
  setAuthMode('signin');
  $('auth-form').addEventListener('submit', async e => {
    e.preventDefault();
    if (authSubmitting) return;
    const fail = message => showAuthMessage(message, 'error');
    try {
      setAuthSubmitting(true);
      if (authMode === 'signin') {
        await handleSignIn(fail);
      } else if (authMode === 'join') {
        const code = $('auth-joining-code').value.trim();
        if (!/^\d{5}$/.test(code)) { resetAuthSubmit(); return fail('❌ Enter the 5-digit joining code.'); }
        showAuthMessage('Checking your joining code…', 'info');
        pendingJoin = { ...(await previewJoiningCode(code)), joiningCode: code };
        setAuthMode('joinPin');
        showAuthMessage('Create your Cloud PIN to activate your account.', 'info');
      } else if (authMode === 'joinPin') {
        const pin = $('auth-new-pin').value;
        const confirmation = $('auth-confirm-pin').value;
        const invalid = validateCloudPinPolicy(pin, { minPinLength: 4, pinComplexity: 'standard' });
        if (invalid) { resetAuthSubmit(); return fail(invalid); }
        if (pin !== confirmation) { resetAuthSubmit(); return fail('❌ Cloud PINs do not match.'); }
        showAuthMessage('Activating your account…', 'info');
        await activateStaff({ joiningCode: pendingJoin?.joiningCode || $('auth-joining-code')?.value, pin });
      } else if (authMode === 'adminJoin') {
        const code = $('auth-admin-code').value.trim();
        if (!/^\d{10}$/.test(code)) { resetAuthSubmit(); return fail('❌ Enter the 10-digit Station Admin invite code.'); }
        showAuthMessage('Checking your invite…', 'info');
        pendingJoin = { ...(await previewAdminInvite(code)), joiningCode: code, kind: 'admin' };
        setAuthMode('adminJoinPin');
        showAuthMessage('Complete your Station Admin profile.', 'info');
      } else if (authMode === 'adminJoinPin') {
        const fullName = $('admin-full-name').value.trim();
        const username = $('admin-username').value.trim().toLowerCase();
        const phoneNumber = $('admin-phone').value.trim();
        const pin = $('admin-pin').value;
        const invalid = validateCloudPinPolicy(pin, { minPinLength: 4, pinComplexity: 'standard' });
        if (!fullName || !/^[a-z0-9_.]{4,16}$/.test(username)) { resetAuthSubmit(); return fail('❌ Enter your name and a valid 4–16 character username.'); }
        if (invalid) { resetAuthSubmit(); return fail(invalid); }
        if (pin !== $('admin-confirm-pin').value) { resetAuthSubmit(); return fail('❌ Cloud PINs do not match.'); }
        showAuthMessage('Creating your Station Admin profile…', 'info');
        await activateAdminInvite({ joiningCode: pendingJoin?.joiningCode, fullName, username, phoneNumber, pin });
      }
    } catch (err) {
      showAuthMessage(formatFirebaseError(err), 'error');
      resetAuthSubmit();
    }
  });
}

async function handleSignIn(fail) {
  const remember = $('auth-remember')?.checked !== false;
  const identifier = $('auth-email')?.value.trim()
    ?? $('auth-username')?.value.trim().toLowerCase() ?? '';
  if (!identifier) { resetAuthSubmit(); return fail('❌ Enter your sign-in details.'); }

  await setAuthPersistence(remember);
  showAuthMessage('Signing you in…', 'info');
  switch (authMethod) {
    case 'email-password': {
      await signIn(identifier, $('auth-password').value);
      recordLogin().catch(() => {});
      break;
    }
    case 'username-password': {
      const { email } = await resolveLoginIdentifier(identifier);
      await signIn(email, $('auth-password').value);
      recordLogin().catch(() => {});
      break;
    }
    case 'email-pin': {
      await signInWithEmailPin({ email: identifier, pin: $('auth-pin').value, remember });
      break;
    }
    case 'username-pin':
    default: {
      await signInWithUsernamePin({ username: identifier, pin: $('auth-pin').value, remember });
      break;
    }
  }
}

// ── App UI (wired once) ─────────────────────────────────────────────────
function setupUI() {
  if (uiReady) return;
  uiReady = true;

  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      if (currentPage === tab.dataset.page) return;
      currentPage = tab.dataset.page;
      renderCurrentPage();
    });
  });

  document.querySelectorAll('.chip').forEach(chip => {
    chip.addEventListener('click', () => {
      document.querySelectorAll('.chip').forEach(c => {
        c.classList.remove('chip-active');
        c.setAttribute('aria-pressed', 'false');
      });
      chip.classList.add('chip-active');
      chip.setAttribute('aria-pressed', 'true');
      currentRange = chip.dataset.range;
      renderCurrentPage();
    });
  });

  $('btn-refresh').addEventListener('click', () => refreshData('user'));
  $('fab-refresh').addEventListener('click', () => refreshData('user'));

  // A page-level write (e.g. a shift saved from the dashboard feed) re-renders
  // the current page in place, whatever it is.
  window.addEventListener('pumplog:dataChanged', () => renderCurrentPage());

  $('station-selector').addEventListener('click', openStationPicker);

  $('btn-profile').addEventListener('click', () => {
    openProfileModal({
      stations: userStations,
      onSignOut: async (event) => {
        setBusy(event?.currentTarget || null, true, 'Signing out…');
        try {
          closeModal('profile-modal');
          await recordLogout().catch(() => {});
          await doSignOut();
        } finally {
          setBusy(event?.currentTarget || null, false);
        }
      },
    });
  });

  // Close buttons + overlay clicks (locked modals cannot be dismissed).
  document.querySelectorAll('.modal').forEach(modal => {
    const guardedClose = () => {
      if (modal.classList.contains('modal-locked')) return;
      closeModal(modal.id);
      modal.dispatchEvent(new CustomEvent('pumplog:closed'));
    };
    modal.querySelector('.modal-close')?.addEventListener('click', guardedClose);
    modal.querySelector('[data-close]')?.addEventListener('click', guardedClose);
  });

  // Refresh when the tab regains focus after being away for a while.
  let hiddenAt = 0;
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      hiddenAt = Date.now();
    } else if (hiddenAt && Date.now() - hiddenAt > 120_000) {
      refreshData('auto');
    }
  });

  window.addEventListener('online', () => toast('Back online.', 'success', 2000));
  window.addEventListener('offline', () => toast('You are offline — showing cached data.', 'info', 4000));
}

function openStationPicker() {
  if (userStations.length === 0) {
    toast(isSuperAdmin()
      ? 'No stations yet. Create one in Config → Stations.'
      : 'No stations assigned to you. Contact your admin.', 'info');
    return;
  }

  $('station-list').innerHTML = userStations.map(s => `
    <button class="station-option ${s.id === currentStationId ? 'is-active' : ''}" data-id="${h(s.id)}">
      <span class="station-emoji" aria-hidden="true">⛽</span>
      <span class="station-text">
        <span class="station-name">${h(s.name || 'Unnamed')}</span>
        <span class="station-addr">${h(s.address || '')}</span>
      </span>
      ${s.id === currentStationId ? '<span class="check" aria-label="Currently selected">✓</span>' : ''}
    </button>
  `).join('');

  openModal('station-modal');

  document.querySelectorAll('.station-option').forEach(opt => {
    opt.addEventListener('click', () => {
      if (opt.dataset.id !== currentStationId) {
        setStation(opt.dataset.id);
        renderCurrentPage();
      }
      closeModal('station-modal');
    });
  });
}

// ── Service worker ──────────────────────────────────────────────────────
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  });
}
