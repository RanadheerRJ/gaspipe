/* PumpLog — application shell */

import { initMainApp } from './firebase.js';
import {
  initAuth, onAuthChange, getCurrentUserData,
  isSuperAdmin, can, ROLES,
  doSignOut, signIn, signUp, formatFirebaseError,
} from './auth.js';
import {
  getAllStations, getStationsByIds, invalidate,
} from './store.js';
import {
  h, openModal, closeModal, closeAllModals, showLoading, toast, setBusy,
} from './components.js';
import { initDashboard, renderDashboard, stopLiveFeed } from './dashboard.js';
import { initPumps, renderPumps } from './pumps.js';
import { initConfig, renderConfig } from './config-page.js';
import { initHistory, renderHistory } from './history.js';

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

  // The dashboard's Firestore listener runs only while the dashboard is open.
  if (currentPage !== 'dashboard') stopLiveFeed();

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

const authSubmitLabel = () => (authMode === 'signup' ? 'Create account' : 'Sign in');

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
    btn.textContent = authMode === 'signup' ? 'Creating account…' : 'Signing in…';
  } else {
    btn.removeAttribute('aria-busy');
    btn.textContent = authSubmitLabel();
  }
}

function setAuthMode(mode) {
  authMode = mode;
  const signup = mode === 'signup';
  $('auth-title').textContent = signup ? 'Create account' : 'Sign in';
  $('auth-submit').textContent = authSubmitLabel();
  $('auth-password').autocomplete = signup ? 'new-password' : 'current-password';
  $('auth-toggle-text').textContent = signup ? 'Already have an account? ' : "Don't have an account? ";
  $('auth-toggle-link').textContent = signup ? 'Sign in' : 'Sign up';
}

function setupAuthForm() {
  setAuthMode('signin');

  $('auth-toggle-link').addEventListener('click', () => {
    if (authSubmitting) return;
    clearAuthMessage();
    setAuthMode(authMode === 'signup' ? 'signin' : 'signup');
  });

  const pwToggle = $('auth-password-toggle');
  pwToggle.addEventListener('click', () => {
    const field = $('auth-password');
    const show = field.type === 'password';
    field.type = show ? 'text' : 'password';
    pwToggle.textContent = show ? 'Hide' : 'Show';
    pwToggle.setAttribute('aria-pressed', String(show));
    pwToggle.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
  });

  ['auth-email', 'auth-password'].forEach(id =>
    $(id).addEventListener('input', () => { if (!authSubmitting) clearAuthMessage(); }));

  $('auth-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (authSubmitting) return;

    const email = $('auth-email').value.trim();
    const password = $('auth-password').value;

    if (!email || !password) return showAuthMessage('Enter both email and password.', 'error');
    if (authMode === 'signup' && password.length < 6) {
      return showAuthMessage('Password must be at least 6 characters.', 'error');
    }

    setAuthSubmitting(true);
    showAuthMessage(authMode === 'signup' ? 'Creating your account…' : 'Signing you in…', 'info');

    try {
      if (authMode === 'signup') await signUp(email, password);
      else await signIn(email, password);
      // onAuthChange takes over from here and swaps to the app shell.
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

  $('btn-signout').addEventListener('click', async (e) => {
    setBusy(e.currentTarget, true, 'Signing out…');
    try {
      closeModal('profile-modal');
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
