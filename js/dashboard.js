/* PumpLog — Dashboard Page */

import {
  collection,
  doc,
  getDoc,
  getDocs,
  query,
  where,
  orderBy,
  limit,
} from './firebase.js';
import { getCurrentUserData } from './auth.js';
import { formatCurrency, formatVolume, formatDateTime, getGreeting, emptyState } from './components.js';

let db = null;
let currentStationId = null;

// ── Init ────────────────────────────────────────────────────────────────
export function initDashboard(firestore) {
  db = firestore;
}

// ── Render ──────────────────────────────────────────────────────────────
export async function renderDashboard(stationId) {
  currentStationId = stationId;
  if (!stationId) {
    document.getElementById('page-content').innerHTML = `
      <div class="welcome-section">
        <div class="welcome-greeting">${getGreeting()}!</div>
        <div class="welcome-sub">Select a station to get started</div>
      </div>
      ${emptyState('⛽', 'Tap the station selector above to choose a station.')}
    `;
    // Update station pill
    document.getElementById('station-name-display').textContent = 'Select Station';
    return;
  }

  const userData = getCurrentUserData();
  if (!userData || !db) return;

  try {
    // Fetch station data
    const stationSnap = await getDoc(doc(db, 'stations', stationId));
    if (!stationSnap.exists()) {
      document.getElementById('page-content').innerHTML = emptyState('⚠️', 'Station not found.');
      return;
    }
    const station = stationSnap.data();
    document.getElementById('station-name-display').textContent = station.name || 'Unnamed Station';

    // Fetch today's shifts
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayStr = today.toISOString().split('T')[0];

    const shiftsQ = query(
      collection(db, 'stations', stationId, 'shifts'),
      where('date', '>=', todayStr),
      orderBy('date', 'desc'),
      limit(50)
    );
    const shiftSnap = await getDocs(shiftsQ);
    const todayShifts = [];
    shiftSnap.forEach(d => todayShifts.push({ id: d.id, ...d.data() }));

    // Compute totals
    let totalVolume = 0;
    let totalSales = 0;
    todayShifts.forEach(s => {
      totalVolume += Number(s.volume) || 0;
      totalSales += Number(s.sales) || 0;
    });

    // Fetch current rates
    const ratesQ = query(
      collection(db, 'stations', stationId, 'rates'),
      orderBy('effectiveDate', 'desc')
    );
    const ratesSnap = await getDocs(ratesQ);
    const rates = [];
    ratesSnap.forEach(d => rates.push({ id: d.id, ...d.data() }));

    // Group rates by product (latest effective)
    const rateMap = {};
    rates.forEach(r => {
      if (!rateMap[r.product] || r.effectiveDate > rateMap[r.product].effectiveDate) {
        rateMap[r.product] = r;
      }
    });

    // Render
    let html = `
      <div class="welcome-section">
        <div class="welcome-greeting">${getGreeting()}!</div>
        <div class="welcome-sub">${station.name}</div>
      </div>

      <div class="stats-grid">
        <div class="stat-card" data-action="history-today">
          <div class="stat-card-icon blue">📊</div>
          <div class="stat-card-label">Today's Volume</div>
          <div class="stat-card-value">${formatVolume(totalVolume)}</div>
        </div>
        <div class="stat-card" data-action="history-today">
          <div class="stat-card-icon green">💰</div>
          <div class="stat-card-label">Today's Sales</div>
          <div class="stat-card-value">${formatCurrency(totalSales)}</div>
        </div>
    `;

    // Rate cards
    Object.entries(rateMap).forEach(([product, rate]) => {
      html += `
        <div class="stat-card" data-action="config-rates">
          <div class="stat-card-icon amber">⛽</div>
          <div class="stat-card-label">${product}</div>
          <div class="stat-card-value">${formatCurrency(rate.rate, '₹')}</div>
          <div class="stat-card-sub">per liter</div>
        </div>
      `;
    });

    // Balance card
    html += `
        <div class="stat-card" data-action="history">
          <div class="stat-card-icon red">💳</div>
          <div class="stat-card-label">Balance / to Collect</div>
          <div class="stat-card-value">${formatCurrency(totalSales)}</div>
          <div class="stat-card-sub">Today's running total</div>
        </div>
      </div> <!-- end stats-grid -->
    `;

    // Recent activity
    html += `<div class="section-title">Recent Activity</div>`;
    const recentQ = query(
      collection(db, 'stations', stationId, 'shifts'),
      orderBy('createdAt', 'desc'),
      limit(5)
    );
    const recentSnap = await getDocs(recentQ);
    const recent = [];
    recentSnap.forEach(d => recent.push({ id: d.id, ...d.data() }));

    if (recent.length === 0) {
      html += emptyState('📝', 'No shift entries yet. Tap a pump to get started!');
    } else {
      html += `<div class="card">`;
      recent.forEach(s => {
        const dotClass = s.shiftLabel === '1' ? 'green' : s.shiftLabel === '2' ? 'blue' : 'amber';
        html += `
          <div class="activity-item">
            <div class="activity-dot ${dotClass}"></div>
            <div class="activity-text">
              <strong>${s.pumpName || 'Pump'}</strong> — Shift ${s.shiftLabel || '?'}
              <br/>${formatVolume(s.volume)} · ${formatCurrency(s.sales)}
            </div>
            <div class="activity-time">${formatDateTime(s.createdAt)}</div>
          </div>
        `;
      });
      html += `</div>`;
    }

    // Station switcher hint
    if ((userData.stationIds || []).length > 1) {
      html += `
        <div class="section-title mt-16">
          <span>Your Stations</span>
          <span class="link" id="show-station-switcher">Switch</span>
        </div>
      `;
    }

    document.getElementById('page-content').innerHTML = html;

    // Attach click handlers for stat cards
    document.querySelectorAll('.stat-card[data-action]').forEach(el => {
      el.addEventListener('click', () => {
        const action = el.dataset.action;
        if (action === 'history-today' || action === 'history') {
          document.querySelector('[data-page="history"]')?.click();
        } else if (action === 'config-rates') {
          document.querySelector('[data-page="config"]')?.click();
        }
      });
    });

    document.getElementById('show-station-switcher')?.addEventListener('click', () => {
      document.getElementById('station-selector')?.click();
    });

  } catch (err) {
    console.error('Dashboard render error:', err);
    document.getElementById('page-content').innerHTML = emptyState('⚠️', 'Error loading dashboard.');
  }
}
