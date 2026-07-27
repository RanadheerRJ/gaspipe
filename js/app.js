/* PumpLog — application shell */

import { initMainApp } from './firebase.js';
import {
  initAuth, onAuthChange, getCurrentUserData,
  isSuperAdmin, isStationAdmin, isStaff, can, ROLES,
  doSignOut, signIn, signUp, formatFirebaseError,
} from './auth.js';
import {
  getAllStations, getStationsByIds, invalidate,
} from './store.js';
import {
  h, openModal, closeModal, closeAllModals, showLoading, toast, setBusy,
} from './components.js';
import { initDashboard, renderDashboard, stopLiveFeed } from './dashboard.js';
import { initPumps, renderPumps, stopPumpsLive } from './pumps.js';
import { initConfig, renderConfig } from './config-page.js';
import { initHistory, renderHistory } from './history.js';
import { initReports, renderReports } from './reports.js';
import { signInWithUsernamePin, previewJoiningCode, activateStaff, recordLogout } from './staff-auth.js';
import { openChangePinForm } from './profile.js';

const $ = id => document.getElementById(id);
const STORE_KEY = 'pumplog:lastStation';

let currentStationId = null;
let userStations = [];
let currentPage = 'dashboard';
let currentRange = 'today';
let authMode = 'signin';
let authSubmitting = false;
let uiReady = false;
let renderToken = 0;

// ── Boot ────────────────────────────────────────────────────────────────
initAuth();
document.addEventListener('DOMContentLoaded', setupAuthForm, { once: true });

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

// ── Auth state ──────────────────────────────────────────────────────────
onAuthChange(async (user, userData, authError) => {
  if (user && userData) {
    initMainApp();
    clearAuthMessage();
    resetAuthSubmit();
    $('auth-screen').classList.add('hidden');
    $('app-shell').classList.remove('hidden');
    showLoading(false);

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
  } else {
    $('auth-screen').classList.remove('hidden');
    $('app-shell').classList.add('hidden');
    closeAllModals();
    showLoading(false);
    resetAuthSubmit();
    stopLiveFeed();
    currentStationId = null;
    userStations = [];
    currentPage = 'dashboard';
    invalidate();

    if (authError) {
      setAuthMode('signin');
      showAuthMessage(formatFirebaseError(authError), 'error');
    }
  }
});

// ── Stations ────────────────────────────────────────────────────────────
async function loadUserStations() {
  const userData = getCurrentUserData();
  if (!userData) return;
  try {
    userStations = isSuperAdmin()
      ? await getAllStations()
      : await getStationsByIds(userData.stationIds || []);
  } catch (err) {
    console.error('Station load error:', err);
    toast(formatFirebaseError(err), 'error');
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
    console.error('Render error:', err);
    toast(formatFirebaseError(err), 'error');
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
    await loadUserStations();
    if (currentStationId && !userStations.some(s => s.id === currentStationId)) {
      setStation(userStations[0]?.id || null);
    }
    await renderCurrentPage();
    if (source === 'user') toast('Data refreshed.', 'success', 2000);
  } catch (err) {
    console.error('Refresh error:', err);
    toast(formatFirebaseError(err), 'error');
  } finally {
    refreshing = false;
    [fab, topBtn].forEach(b => b?.classList.remove('is-spinning'));
    fab?.removeAttribute('aria-busy');
  }
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
  joinPin: 'Activate account',
  legacy: 'Sign in with email',
  forgot: 'Back to sign in',
}[authMode] || 'Continue');

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
      : authMode === 'joinPin' ? 'Activating…'
        : authMode === 'legacy' ? 'Signing in…' : 'Checking…';
  } else {
    btn.removeAttribute('aria-busy');
    btn.textContent = authSubmitLabel();
  }
}

function validPin(pin) {
  if (!/^\d{4}$/.test(pin)) return false;
  if (/^(\d)\1{3}$/.test(pin)) return false;
  return !'0123456789'.includes(pin) && !'9876543210'.includes(pin);
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
      toggle.setAttribute('aria-label', show ? 'Hide PIN' : 'Show PIN');
    });
  });
}

function renderAuthFields() {
  const fields = $('auth-fields');
  const links = $('auth-links');
  if (!fields || !links) return;
  if (authMode === 'signin') {
    fields.innerHTML = `
      <div class="field"><label for="auth-username">Username</label>
        <input type="text" id="auth-username" autocomplete="username" autocapitalize="off" spellcheck="false" minlength="4" maxlength="25" required /></div>
      <div class="field"><label for="auth-pin">PIN</label><div class="input-affix">
        <input type="password" id="auth-pin" inputmode="numeric" autocomplete="current-password" pattern="[0-9]{4}" maxlength="4" required />
        <button type="button" class="affix-btn" data-password-toggle="auth-pin" aria-label="Show PIN" aria-pressed="false">Show</button></div></div>
      <label class="remember-row"><input type="checkbox" id="auth-remember" checked /> <span>Remember me on this device</span></label>`;
    links.innerHTML = `<button type="button" class="link-btn" data-auth-mode="forgot">Forgot PIN?</button>
      <span class="auth-link-separator">·</span><button type="button" class="link-btn" data-auth-mode="join">Join with code</button>
      <button type="button" class="link-btn auth-legacy-link" data-auth-mode="legacy">Existing account sign in</button>`;
  } else if (authMode === 'join') {
    fields.innerHTML = `<p class="auth-step-note">Enter the 5-digit code your admin shared with you.</p>
      <div class="field"><label for="auth-joining-code">Joining code</label>
        <input type="text" id="auth-joining-code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{5}" maxlength="5" placeholder="00000" required /></div>`;
    links.innerHTML = `<button type="button" class="link-btn" data-auth-mode="signin">Back to sign in</button>`;
  } else if (authMode === 'joinPin') {
    fields.innerHTML = `<div class="join-welcome"><span class="join-welcome-icon" aria-hidden="true">✓</span><p>Welcome, <strong>${h(pendingJoin?.fullName || 'there')}</strong></p><small>Username: ${h(pendingJoin?.username || '')}</small></div>
      <p class="auth-step-note">Create a private 4-digit PIN. Avoid repeated or sequential numbers.</p>
      <div class="field"><label for="auth-new-pin">Create PIN</label><div class="input-affix"><input type="password" id="auth-new-pin" inputmode="numeric" autocomplete="new-password" pattern="[0-9]{4}" maxlength="4" required /><button type="button" class="affix-btn" data-password-toggle="auth-new-pin" aria-label="Show PIN" aria-pressed="false">Show</button></div></div>
      <div class="field"><label for="auth-confirm-pin">Confirm PIN</label><input type="password" id="auth-confirm-pin" inputmode="numeric" autocomplete="new-password" pattern="[0-9]{4}" maxlength="4" required /></div>`;
    links.innerHTML = `<button type="button" class="link-btn" data-auth-mode="join">Use a different code</button>`;
  } else if (authMode === 'legacy') {
    fields.innerHTML = `<p class="auth-step-note">Use this temporary path while an existing account is migrated to username and PIN.</p>
      <div class="field"><label for="auth-email">Email</label><input type="email" id="auth-email" autocomplete="email" required /></div>
      <div class="field"><label for="auth-password">Password</label><div class="input-affix"><input type="password" id="auth-password" autocomplete="current-password" required /><button type="button" class="affix-btn" data-password-toggle="auth-password" aria-label="Show password" aria-pressed="false">Show</button></div></div>`;
    links.innerHTML = `<button type="button" class="link-btn" data-auth-mode="signin">Back to username sign in</button>`;
  } else {
    fields.innerHTML = `<div class="auth-info-card"><span aria-hidden="true">🔐</span><p>For security, PIN resets are issued by a Station Admin or Super Admin. Ask your admin for a new joining code.</p></div>`;
    links.innerHTML = `<button type="button" class="link-btn" data-auth-mode="signin">Back to sign in</button>`;
  }
  wireAuthFields();
  document.querySelectorAll('[data-auth-mode]').forEach(button => button.addEventListener('click', () => setAuthMode(button.dataset.authMode)));
  resetAuthSubmit();
}

let pendingJoin = null;
function setAuthMode(mode) {
  authMode = mode;
  if (mode !== 'joinPin') pendingJoin = null;
  const titles = { signin: 'Sign in', join: 'Join organization', joinPin: 'Set your PIN', legacy: 'Existing account', forgot: 'Forgot PIN' };
  const subtitles = { signin: 'Use your PumpLog username and PIN.', join: 'Activate your staff account securely.', joinPin: 'Your PIN stays private and is never stored in the browser.', legacy: 'Complete migration from the previous login.', forgot: 'Recover access without exposing your PIN.' };
  $('auth-title').textContent = titles[mode] || 'Sign in';
  $('auth-subtitle').textContent = subtitles[mode] || '';
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
        const username = $('auth-username').value.trim().toLowerCase();
        const pin = $('auth-pin').value;
        if (!username || !validPin(pin)) { resetAuthSubmit(); return fail('Enter your username and a valid 4-digit PIN.'); }
        showAuthMessage('Signing you in…', 'info');
        await signInWithUsernamePin({ username, pin, remember: $('auth-remember')?.checked !== false });
      } else if (authMode === 'join') {
        const code = $('auth-joining-code').value.trim();
        if (!/^\d{5}$/.test(code)) { resetAuthSubmit(); return fail('Enter the 5-digit joining code.'); }
        showAuthMessage('Checking your joining code…', 'info');
        pendingJoin = { ...(await previewJoiningCode(code)), joiningCode: code };
        setAuthMode('joinPin');
        showAuthMessage('Create your PIN to activate your account.', 'info');
      } else if (authMode === 'joinPin') {
        const pin = $('auth-new-pin').value;
        const confirmation = $('auth-confirm-pin').value;
        if (!validPin(pin)) { resetAuthSubmit(); return fail('PIN must be exactly 4 digits and not repeated or sequential.'); }
        if (pin !== confirmation) { resetAuthSubmit(); return fail('PINs do not match.'); }
        showAuthMessage('Activating your account…', 'info');
        await activateStaff({ joiningCode: $('auth-joining-code')?.value || pendingJoin?.joiningCode || pendingJoin?.code, pin });
      } else if (authMode === 'legacy') {
        const email = $('auth-email').value.trim();
        const password = $('auth-password').value;
        if (!email || !password) { resetAuthSubmit(); return fail('Enter both email and password.'); }
        showAuthMessage('Signing you in…', 'info');
        await signIn(email, password);
      } else if (authMode === 'forgot') {
        setAuthMode('signin');
        showAuthMessage('Ask your station admin for a new joining code to reset your PIN.', 'info');
      }
    } catch (err) {
      console.error('Auth error:', err);
      showAuthMessage(formatFirebaseError(err), 'error');
      resetAuthSubmit();
    }
  });
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
    const userData = getCurrentUserData();
    if (!userData) return;
    $('profile-name').textContent = userData.fullName || userData.displayName || '—';
    $('profile-username').textContent = userData.username || '—';
    $('profile-email').textContent = userData.email || '—';
    $('profile-role').textContent = ROLES[userData.role] || userData.role || '—';
    $('profile-stations').textContent = isSuperAdmin()
      ? 'All stations'
      : userStations.length
        ? userStations.map(s => s.name).join(', ')
        : 'None assigned';
    $('profile-pumps').textContent = userData.role === 'staff'
      ? (userData.pumpIds?.length
          ? `${userData.pumpIds.length} assigned pump${userData.pumpIds.length === 1 ? '' : 's'}`
          : 'All pumps at your stations')
      : 'All pumps';
    openModal('profile-modal');
  });

  $('profile-change-pin').addEventListener('click', () => {
    closeModal('profile-modal');
    openChangePinForm();
  });

  $('btn-signout').addEventListener('click', async (e) => {
    setBusy(e.currentTarget, true, 'Signing out…');
    try {
      closeModal('profile-modal');
      await recordLogout().catch(() => {});
      await doSignOut();
    } finally {
      setBusy(e.currentTarget, false);
    }
  });

  // Close buttons + overlay clicks
  document.querySelectorAll('.modal').forEach(modal => {
    modal.querySelector('.modal-close')?.addEventListener('click', () => {
      closeModal(modal.id);
      modal.dispatchEvent(new CustomEvent('pumplog:closed'));
    });
    modal.querySelector('[data-close]')?.addEventListener('click', () => {
      closeModal(modal.id);
      modal.dispatchEvent(new CustomEvent('pumplog:closed'));
    });
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
    navigator.serviceWorker.register('sw.js').catch(err =>
      console.warn('Service worker registration failed:', err));
  });
}
