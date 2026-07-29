/* PumpLog — application shell
 *
 * Sign-in gate order, every sign-in:
 *   1. Forced Cloud PIN change  (when a profile flag requires it)
 *   2. Local App Lock           (device PIN — refresh / PWA reopen)
 *   3. App shell renders
 */

import { initMainApp, setAuthPersistence } from './firebase.js';
import {
  initAuth, onAuthChange, getCurrentUser, getCurrentUserData,
  isSuperAdmin, can, applyPermission,
  doSignOut, formatFirebaseError,
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
} from './station-settings.js';
import {
  getAppLockStatus, engageAppLockFor, armAppLockSession,
  resetAppLockForSignOut, updateAppLockPolicy,
} from './app-lock.js';
import { initDashboard, renderDashboard, stopLiveFeed } from './dashboard.js';
import { initPumps, renderPumps, stopPumpsLive } from './pumps.js';
import { initBoard, renderBoard, stopBoardLive, primeMyDailyPumps } from './board.js';
import { initConfig, renderConfig } from './config-page.js';
import { initHistory, renderHistory } from './history.js';
import { initReports, renderReports } from './reports.js';
import {
  signInWithEmailPin, recordLogout, getMyPinStatus,
} from './staff-auth.js';
import {
  openProfileModal, openForcedCloudPinChange,
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
let authMethod = 'email-pin';
let authSubmitting = false;
let uiReady = false;
let renderToken = 0;

let loginStations = [];
let loginStationId = null;
let loginPolicy = { ...DEFAULT_SECURITY };
let loginSettingsUnsub = null;
let appLockPromptShown = false;

// ── Boot ────────────────────────────────────────────────────────────────
initAuth();
document.addEventListener('DOMContentLoaded', () => {
  setupAuthForm();
  initFreeModeLogin();
  initDevBuildTag(); // DEV-ONLY — see block below.
}, { once: true });

// ── DEV-ONLY: build/version tag for staging — remove before production launch ──
// Fetches version.json (generated fresh on every Pages deploy by
// .github/workflows/deploy-pages.yml) and renders a small, low-contrast
// "Build: <timestamp> · <short sha>" tag under the logo on #auth-screen, so
// it's easy to eyeball whether a browser is on the latest deploy or stuck on
// a stale service-worker cache. Entirely best-effort: any failure (missing
// file, network error, bad JSON) is swallowed silently and simply results in
// no tag — it must never block, delay, or throw during app boot.
// To remove: delete this whole block plus the initDevBuildTag() call above.
function initDevBuildTag() {
  const logo = document.querySelector('#auth-screen .auth-logo');
  if (!logo) return;

  fetch(`version.json?t=${Date.now()}`, { cache: 'no-store' })
    .then(res => (res.ok ? res.json() : null))
    .then((info) => {
      if (!info || !info.deployedAt || !info.commit) return;
      const tag = document.createElement('p');
      tag.id = 'dev-build-tag';
      tag.style.cssText =
        'margin-top:8px;font-size:11px;line-height:1.4;color:#9ca3af;' +
        'opacity:.8;letter-spacing:.02em;user-select:text;';
      tag.textContent = `Build: ${info.deployedAt} · ${info.commit}`;
      logo.appendChild(tag);
    })
    .catch(() => { /* no version.json / offline / bad JSON — fail silent */ });
}
// ── END DEV-ONLY build/version tag block ──

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
    stopBoardLive();
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
  initBoard();
  initConfig();
  initHistory();
  initReports();

  setupUI();

  await loadUserStations();
  restoreStation(userData);

  // Tab visibility depends on the selected station, so apply it after the
  // station is restored rather than before.
  applyRoleVisibility();

  // Load today's roster before the first paint so a staff member rostered by
  // their manager can start a shift immediately, without opening the board.
  await primeMyDailyPumps(currentStationId);

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


function initFreeModeLogin() {
  loginStations = [];
  loginStationId = '';
  loginPolicy = { ...DEFAULT_SECURITY };
  authMethod = 'email-pin';
  const stationField = $('auth-station-field');
  if (stationField) stationField.classList.add('hidden');
  const subtitle = $('auth-subtitle');
  if (subtitle) subtitle.textContent = 'Sign in with your email and Cloud PIN.';
  renderAuthFields();
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
  if (currentPage === 'board' && !can('assignment.view', { stationId: currentStationId })) currentPage = 'dashboard';

  // Keep live listeners attached only to the screen currently using them.
  if (currentPage !== 'dashboard') stopLiveFeed();
  if (currentPage !== 'pumps') stopPumpsLive();
  if (currentPage !== 'board') stopBoardLive();

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
      case 'board':   await renderBoard(currentStationId); break;
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
  applyPermission(document.querySelector('[data-page="config"]'), 'config.view');
  applyPermission(
    document.querySelector('[data-page="reports"]'),
    'report.view',
    { stationId: currentStationId },
  );
  // Every station member sees the same daily board; edit controls have their
  // own assignment.manage gate inside the page.
  applyPermission(
    document.querySelector('[data-page="board"]'),
    'assignment.view',
    { stationId: currentStationId },
  );
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

// Station picker/sign-in policy loading is intentionally disabled in free
// mode. The login screen stays simple and uses email + Cloud PIN only.
function watchLoginSettings() {
  loginSettingsUnsub?.();
  loginSettingsUnsub = null;
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
    btn.textContent = 'Signing in…';
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
  return `<div class="field"><label for="auth-email">Email</label>
      <input type="email" id="auth-email" autocomplete="email" autocapitalize="off" spellcheck="false" required /></div>
    ${pinFieldHTML({ id: 'auth-pin', label: 'Cloud PIN' })}${remember}`;
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
        <p>Email + Cloud PIN sign-in is disabled for this station. Contact your admin.</p></div>`;
    } else {
      fields.innerHTML = signinFieldsHTML();
    }
    links.innerHTML = `<button type="button" class="link-btn" data-auth-mode="forgot">Forgot Cloud PIN?</button>`;
  } else {
    fields.innerHTML = `<div class="auth-info-card"><span aria-hidden="true">🔐</span><p>Ask your admin to create a new testing account if you forget your Cloud PIN. Signed-in users can change their own Cloud PIN from Profile.</p></div>
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
  authMode = mode === 'forgot' ? 'forgot' : 'signin';
  const titles = {
    signin: 'Sign in', forgot: 'Forgot your Cloud PIN',
  };
  const subtitles = {
    signin: 'Sign in with email + Cloud PIN.',
    forgot: 'How account recovery works.',
  };
  $('auth-title').textContent = titles[authMode] || 'Sign in';
  $('auth-subtitle').textContent = subtitles[authMode] || '';
  $('auth-station-field').classList.add('hidden');
  renderAuthFields();
}


function setupAuthForm() {
  setAuthMode('signin');
  $('auth-form').addEventListener('submit', async e => {
    e.preventDefault();
    if (authSubmitting) return;
    if (authMode !== 'signin') return;
    const fail = message => showAuthMessage(message, 'error');
    try {
      setAuthSubmitting(true);
      await handleSignIn(fail);
    } catch (err) {
      showAuthMessage(formatFirebaseError(err), 'error');
      resetAuthSubmit();
    }
  });
}


async function handleSignIn(fail) {
  const remember = $('auth-remember')?.checked !== false;
  const email = $('auth-email')?.value.trim().toLowerCase() || '';
  const pin = $('auth-pin')?.value || '';
  if (!email || !pin) { resetAuthSubmit(); return fail('❌ Enter your email and Cloud PIN.'); }

  await setAuthPersistence(remember);
  showAuthMessage('Signing you in…', 'info');
  await signInWithEmailPin({ email, pin, remember });
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

  // Dashboard range change from the new filter bar
  window.addEventListener('pumplog:dashRangeChange', (e) => {
    if (currentPage === 'dashboard') {
      currentRange = e.detail.range;
      renderCurrentPage();
    }
  });

  // A page-level write (e.g. a shift saved from the dashboard feed) re-renders
  // the current page in place, whatever it is.
  window.addEventListener('pumplog:dataChanged', () => renderCurrentPage());

  // The signed-in user's own profile changed under them — a manager altered
  // their role, stations, or pump assignments. Re-apply tab visibility and
  // repaint so the new permissions take effect without a reload.
  window.addEventListener('pumplog:profileChanged', async () => {
    applyRoleVisibility();
    await primeMyDailyPumps(currentStationId);
    renderCurrentPage();
  });

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
      ? 'No stations yet. Create one in Settings → Stations.'
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
    opt.addEventListener('click', async () => {
      if (opt.dataset.id !== currentStationId) {
        setStation(opt.dataset.id);
        // Pump access is per station, so reload this station's roster before
        // rendering — otherwise the previous station's grants leak across.
        await primeMyDailyPumps(currentStationId);
        applyRoleVisibility();
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
