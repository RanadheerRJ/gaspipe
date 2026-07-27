/* PumpLog — Main Application Shell */

import {
  FIREBASE_CONFIG,
  initMainApp,
  collection,
  doc,
  getDoc,
  getDocs,
} from './firebase.js';
import {
  initAuth,
  onAuthChange,
  getCurrentUserData,
  isSuperAdmin,
  isStationAdmin,
  doSignOut,
  signIn,
  signUp,
  formatFirebaseError,
} from './auth.js';
import {
  openModal,
  closeModal,
  closeAllModals,
  showLoading,
  emptyState,
  getGreeting,
} from './components.js';
import { initDashboard, renderDashboard } from './dashboard.js';
import { initPumps, renderPumps } from './pumps.js';
import { initConfig, renderConfig } from './config-page.js';
import { initHistory, renderHistory } from './history.js';

// ── State ───────────────────────────────────────────────────────────────
let db = null;
let auth = null;
let currentStationId = null;
let userStations = [];
let currentPage = 'dashboard';
let authMode = 'signin';
let authSubmitting = false;

// ── DOM refs ────────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);

// ── Init ────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  initAuth();
  setupAuthForm();

  window.addEventListener('pumplog:stationsChanged', async (event) => {
    if (!db) return;
    await loadUserStations();
    if (event.detail?.stationId) {
      currentStationId = event.detail.stationId;
    }
    currentPage = 'config';
    renderCurrentPage();
  });
});

// ── Auth change handler ─────────────────────────────────────────────────
onAuthChange(async (user, userData, authError) => {
  if (user && userData) {
    // User is signed in
    const { auth: a, db: d } = initMainApp(FIREBASE_CONFIG);
    auth = a;
    db = d;

    // Hide auth screen, show app
    clearAuthMessage();
    resetAuthSubmit();
    $('auth-screen').classList.add('hidden');
    $('app-shell').classList.remove('hidden');
    showLoading(false);

    // Initialize sub-modules with firestore instance
    initDashboard(db);
    initPumps(db);
    initConfig(db);
    initHistory(db);

    // Load user's stations
    await loadUserStations();

    // Set the first station
    if (userData.stationIds && userData.stationIds.length > 0) {
      // Check if the stations still exist
      const firstId = userData.stationIds[0];
      const stationSnap = await getDoc(doc(db, 'stations', firstId));
      if (stationSnap.exists()) {
        currentStationId = firstId;
      } else {
        // Station might have been deleted — find first valid station
        for (const sid of userData.stationIds) {
          const snap = await getDoc(doc(db, 'stations', sid));
          if (snap.exists()) {
            currentStationId = sid;
            break;
          }
        }
      }
    }

    // If Super Admin has no stations yet, open Config so they can create one.
    if (!currentStationId && isSuperAdmin()) {
      currentPage = 'config';
    }

    // Render initial page
    renderCurrentPage();

    // Setup UI interactions
    setupUI();
  } else {
    // Show auth screen
    $('auth-screen').classList.remove('hidden');
    $('app-shell').classList.add('hidden');
    showLoading(false);
    resetAuthSubmit();

    if (authError) {
      setAuthMode('signin');
      showAuthMessage(formatFirebaseError(authError), 'error');
    }
  }
});

// ── Load user stations ──────────────────────────────────────────────────
async function loadUserStations() {
  const userData = getCurrentUserData();
  if (!userData) return;

  userStations = [];

  if (isSuperAdmin()) {
    // Super Admin sees all stations
    const snap = await getDocs(collection(db, 'stations'));
    snap.forEach(d => userStations.push({ id: d.id, ...d.data() }));
  } else {
    // Station Admin / Staff see only their assigned stations
    const ids = userData.stationIds || [];
    for (const id of ids) {
      const snap = await getDoc(doc(db, 'stations', id));
      if (snap.exists()) {
        userStations.push({ id, ...snap.data() });
      }
    }
  }
}

// ── Render current page ─────────────────────────────────────────────────
async function renderCurrentPage() {
  if (!db) return;

  const content = $('page-content');
  if (!content) return;

  // Update station pill display
  if (currentStationId) {
    const snap = await getDoc(doc(db, 'stations', currentStationId));
    if (snap.exists()) {
      $('station-name-display').textContent = snap.data().name || 'Station';
    }
  } else {
    $('station-name-display').textContent = 'Select Station';
  }

  switch (currentPage) {
    case 'dashboard':
      await renderDashboard(currentStationId);
      break;
    case 'pumps':
      await renderPumps(currentStationId);
      break;
    case 'config':
      await renderConfig(currentStationId);
      break;
    case 'history':
      await renderHistory(currentStationId);
      break;
    default:
      await renderDashboard(currentStationId);
  }

  // Update active tab
  document.querySelectorAll('.tab').forEach(tab => {
    tab.classList.toggle('tab-active', tab.dataset.page === currentPage);
  });

  // Show/hide config tab based on role
  const configTab = document.querySelector('[data-page="config"]');
  if (configTab) {
    const userData = getCurrentUserData();
    configTab.style.display = (isSuperAdmin() || isStationAdmin()) ? 'flex' : 'none';
  }
}

// ── Auth form helpers ──────────────────────────────────────────────────
function showAuthMessage(message, type = 'error') {
  const messageEl = $('auth-error');
  if (!messageEl) return;
  messageEl.textContent = message;
  messageEl.classList.remove('hidden', 'auth-info', 'auth-success');
  if (type === 'info') messageEl.classList.add('auth-info');
  if (type === 'success') messageEl.classList.add('auth-success');
}

function clearAuthMessage() {
  const messageEl = $('auth-error');
  if (!messageEl) return;
  messageEl.textContent = '';
  messageEl.classList.add('hidden');
  messageEl.classList.remove('auth-info', 'auth-success');
}

function authSubmitLabel() {
  return authMode === 'signup' ? 'Sign Up' : 'Sign In';
}

function resetAuthSubmit() {
  authSubmitting = false;
  const submitBtn = $('auth-submit');
  if (!submitBtn) return;
  submitBtn.disabled = false;
  submitBtn.textContent = authSubmitLabel();
}

function setAuthSubmitting(isSubmitting) {
  authSubmitting = isSubmitting;
  const submitBtn = $('auth-submit');
  if (!submitBtn) return;
  submitBtn.disabled = isSubmitting;
  submitBtn.textContent = isSubmitting
    ? (authMode === 'signup' ? 'Creating account…' : 'Signing in…')
    : authSubmitLabel();
}

function setAuthMode(mode) {
  authMode = mode;
  const isSignUp = authMode === 'signup';
  $('auth-title').textContent = isSignUp ? 'Create Account' : 'Sign In';
  $('auth-submit').textContent = isSignUp ? 'Sign Up' : 'Sign In';
  $('auth-password').autocomplete = isSignUp ? 'new-password' : 'current-password';
  $('auth-toggle-text').textContent = isSignUp
    ? 'Already have an account? '
    : "Don't have an account? ";
  $('auth-toggle-link').textContent = isSignUp ? 'Sign In' : 'Sign Up';
}

// ── Setup auth form (runs immediately on page load, before sign-in) ─────
function setupAuthForm() {
  const toggleLink = $('auth-toggle-link');
  const authForm = $('auth-form');

  setAuthMode('signin');

  toggleLink.addEventListener('click', (e) => {
    e.preventDefault();
    if (authSubmitting) return;
    clearAuthMessage();
    setAuthMode(authMode === 'signup' ? 'signin' : 'signup');
  });

  ['auth-email', 'auth-password'].forEach((id) => {
    $(id).addEventListener('input', () => {
      if (!authSubmitting) clearAuthMessage();
    });
  });

  authForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (authSubmitting) return;

    const email = $('auth-email').value.trim();
    const password = $('auth-password').value;

    if (!email || !password) {
      showAuthMessage('Enter both email and password.', 'error');
      return;
    }

    if (authMode === 'signup' && password.length < 6) {
      showAuthMessage('Password must be at least 6 characters.', 'error');
      return;
    }

    setAuthSubmitting(true);
    showAuthMessage(
      authMode === 'signup'
        ? 'Creating your account… Please wait.'
        : 'Signing you in… Please wait.',
      'info'
    );

    try {
      if (authMode === 'signup') {
        await signUp(email, password);
        showAuthMessage('Account created. Setting up your PumpLog profile…', 'success');
      } else {
        await signIn(email, password);
        showAuthMessage('Signed in. Loading PumpLog…', 'success');
      }
      // Keep the button disabled until the auth-state listener either opens the
      // app or reports a profile/Firestore setup error. If Firebase never sends
      // that follow-up event, unlock the form with a clear instruction.
      window.setTimeout(() => {
        const authScreenVisible = !$('auth-screen')?.classList.contains('hidden');
        if (authSubmitting && authScreenVisible) {
          showAuthMessage(
            'Still waiting for Firebase profile setup. If this message stays, refresh the page and make sure the updated Firestore rules are published.',
            'info'
          );
          resetAuthSubmit();
        }
      }, 12000);
    } catch (err) {
      console.error('Auth submit error:', err);
      showAuthMessage(formatFirebaseError(err), 'error');
      resetAuthSubmit();
    }
  });
}

// ── Setup app UI interactions (only runs after sign-in) ─────────────────
function setupUI() {
  // ── Tab navigation ──────────────────────────────────────────────
  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      currentPage = tab.dataset.page;
      renderCurrentPage();
    });
  });

  // ── Station selector ────────────────────────────────────────────
  $('station-selector').addEventListener('click', () => {
    if (userStations.length === 0) {
      if (isSuperAdmin()) {
        alert('No stations yet. Go to Config → Stations to create one.');
      } else {
        alert('No stations assigned. Contact your admin.');
      }
      return;
    }

    let html = '';
    userStations.forEach(s => {
      const isActive = s.id === currentStationId;
      html += `
        <div class="station-option" data-id="${s.id}">
          <span class="station-emoji">⛽</span>
          <div>
            <div class="station-name">${s.name || 'Unnamed'}</div>
            <div class="station-addr">${s.address || ''}</div>
          </div>
          ${isActive ? '<span class="check">✓</span>' : ''}
        </div>
      `;
    });
    $('station-list').innerHTML = html;
    openModal('station-modal');

    document.querySelectorAll('.station-option').forEach(opt => {
      opt.addEventListener('click', async () => {
        currentStationId = opt.dataset.id;
        closeModal('station-modal');
        await loadUserStations();
        renderCurrentPage();
      });
    });
  });

  // ── Station modal close ─────────────────────────────────────────
  $('station-modal').querySelector('.modal-close').addEventListener('click', () => {
    closeModal('station-modal');
  });

  // ── Generic modal close ─────────────────────────────────────────
  $('generic-modal').querySelector('.modal-close').addEventListener('click', () => {
    closeModal('generic-modal');
  });

  // ── Profile ─────────────────────────────────────────────────────
  $('btn-profile').addEventListener('click', () => {
    const userData = getCurrentUserData();
    if (!userData) return;

    $('profile-email').textContent = userData.email || '—';
    const roleNames = { superadmin: 'Super Admin', stationadmin: 'Station Admin', staff: 'Staff' };
    $('profile-role').textContent = roleNames[userData.role] || userData.role || '—';
    $('profile-stations').textContent = (userData.stationIds || []).length > 0
      ? userData.stationIds.length + ' station(s)'
      : 'None';
    openModal('profile-modal');
  });

  $('profile-modal').querySelector('.modal-close').addEventListener('click', () => {
    closeModal('profile-modal');
  });

  // ── Sign out ────────────────────────────────────────────────────
  $('btn-signout').addEventListener('click', async () => {
    await doSignOut();
    closeModal('profile-modal');
  });

  // ── Quick add reading ───────────────────────────────────────────
  $('btn-add-reading').addEventListener('click', () => {
    if (!currentStationId) {
      alert('Select a station first.');
      return;
    }
    // Navigate to pumps page
    currentPage = 'pumps';
    renderCurrentPage();
  });

  // ── Notifications (placeholder) ─────────────────────────────────
  $('btn-notifications').addEventListener('click', () => {
    alert('No new alerts.');
  });

  // ── Modal overlay closes modals ─────────────────────────────────
  document.querySelectorAll('.modal-overlay').forEach(overlay => {
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) {
        closeAllModals();
      }
    });
  });

  // ── Chip clicks ─────────────────────────────────────────────────
  document.querySelectorAll('.chip').forEach(chip => {
    chip.addEventListener('click', () => {
      document.querySelectorAll('.chip').forEach(c => c.classList.remove('chip-active'));
      chip.classList.add('chip-active');

      const view = chip.dataset.view;
      if (view === 'today' || view === 'week') {
        currentPage = 'dashboard';
        renderCurrentPage();
      } else if (view === 'all-pumps') {
        currentPage = 'pumps';
        renderCurrentPage();
      } else if (view === 'alerts') {
        currentPage = 'history';
        renderCurrentPage();
      }
    });
  });

}
