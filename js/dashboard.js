/* PumpLog — Dashboard */

import { getStation, getShifts, getCurrentRateMap } from './store.js';
import { formatFirebaseError } from './auth.js';
import {
  h, formatCurrency, formatVolume, formatDateTime, getGreeting,
  emptyState, showSkeleton, rangeStart,
} from './components.js';

export function initDashboard() {}

const RANGE_LABEL = { today: 'Today', week: 'Last 7 days', month: 'Last 30 days', all: 'All time' };

export async function renderDashboard(stationId, range = 'today') {
  const content = document.getElementById('page-content');

  if (!stationId) {
    content.innerHTML = `
      <div class="welcome-section">
        <h2 class="welcome-greeting">${getGreeting()}</h2>
        <p class="welcome-sub">Select a station to get started</p>
      </div>
      ${emptyState('⛽', 'Tap the station name in the top bar to choose a station.')}
    `;
    return;
  }

  showSkeleton(3);

  try {
    const from = rangeStart(range);
    const [station, shifts, rateMap] = await Promise.all([
      getStation(stationId),
      getShifts(stationId, { from }),
      getCurrentRateMap(stationId),
    ]);

    if (!station) {
      content.innerHTML = emptyState('⚠️', 'Station not found. It may have been deleted.');
      return;
    }

    let volume = 0, sales = 0;
    for (const s of shifts) {
      volume += Number(s.volume) || 0;
      sales += Number(s.sales) || 0;
    }

    const label = RANGE_LABEL[range] || 'Today';
    const rateCards = Object.entries(rateMap).map(([product, r]) => `
      <article class="stat-card">
        <div class="stat-card-icon amber" aria-hidden="true">⛽</div>
        <h3 class="stat-card-label">${h(product)}</h3>
        <p class="stat-card-value">${formatCurrency(r.rate)}</p>
        <p class="stat-card-sub">per litre</p>
      </article>
    `).join('');

    const recent = shifts.slice(0, 6);
    const activity = recent.length === 0
      ? emptyState('📝', 'No shift entries in this period.')
      : `<ul class="card activity-list">${recent.map(s => {
          const dot = s.shiftLabel === '1' ? 'green' : s.shiftLabel === '2' ? 'blue' : 'amber';
          return `<li class="activity-item">
            <span class="activity-dot ${dot}" aria-hidden="true"></span>
            <span class="activity-text">
              <strong>${h(s.pumpName || 'Pump')}</strong> · Shift ${h(s.shiftLabel || '?')}
              <br />${formatVolume(s.volume)} · ${formatCurrency(s.sales)}
            </span>
            <span class="activity-time">${h(formatDateTime(s.createdAt) || s.date || '')}</span>
          </li>`;
        }).join('')}</ul>`;

    content.innerHTML = `
      <div class="welcome-section">
        <h2 class="welcome-greeting">${getGreeting()}</h2>
        <p class="welcome-sub">${h(station.name)} · ${h(label)}</p>
      </div>

      <div class="stats-grid">
        <article class="stat-card">
          <div class="stat-card-icon blue" aria-hidden="true">📊</div>
          <h3 class="stat-card-label">Volume</h3>
          <p class="stat-card-value">${formatVolume(volume)}</p>
          <p class="stat-card-sub">${h(label)}</p>
        </article>
        <article class="stat-card">
          <div class="stat-card-icon green" aria-hidden="true">💰</div>
          <h3 class="stat-card-label">Sales</h3>
          <p class="stat-card-value">${formatCurrency(sales)}</p>
          <p class="stat-card-sub">${shifts.length} entr${shifts.length === 1 ? 'y' : 'ies'}</p>
        </article>
        ${rateCards}
      </div>

      <h3 class="section-title">Recent activity</h3>
      ${activity}
    `;
  } catch (err) {
    console.error('Dashboard render error:', err);
    content.innerHTML = emptyState('⚠️', formatFirebaseError(err));
  }
}
