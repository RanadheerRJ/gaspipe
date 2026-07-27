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

// ── DOM refs ────────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);

// ── Init ────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  initAuth();
  setupAuthForm();
});

// ── Auth change handler ─────────────────────────────────────────────────
onAuthChange(async (user, userData) => {
  if (user && userData) {
    // User is signed in
    const { auth: a, db: d } = initMainApp(FIREBASE_CONFIG);
    auth = a;
    db = d;

    // Hide auth screen, show app
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

    // If Super Admin with no stations, still allow station creation
    if (!currentStationId && isSuperAdmin()) {
      // Super Admin can still access config to create stations
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

// ── Setup auth form (runs immediately on page load, before sign-in) ─────
function setupAuthForm() {
  let isSignUp = false;
  const toggleLink = $('auth-toggle-link');
  const authForm = $('auth-form');

  toggleLink.addEventListener('click', (e) => {
    e.preventDefault();
    isSignUp = !isSignUp;
    $('auth-title').textContent = isSignUp ? 'Create Account' : 'Sign In';
    $('auth-submit').textContent = isSignUp ? 'Sign Up' : 'Sign In';
    toggleLink.textContent = isSignUp
      ? 'Already have an account? Sign In'
      : "Don't have an account? Sign Up";
  });

  authForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = $('auth-email').value.trim();
    const password = $('auth-password').value;
    const errorEl = $('auth-error');
    errorEl.classList.add('hidden');

    try {
      if (isSignUp) {
        await signUp(email, password);
      } else {
        await signIn(email, password);
      }
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.classList.remove('hidden');
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
