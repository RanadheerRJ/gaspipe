/* PumpLog — Dashboard with live pump feed
 *
 * Instead of a static "recent activity" list, the dashboard shows a live
 * status board: one row per pump with Active / Stopped / No-readings state,
 * today's throughput, and the time of the last reading. The feed is backed
 * by a Firestore onSnapshot listener, so a reading logged on any device
 * appears here within a second. Tapping a pump opens its detail card with
 * recent readings and a shortcut to log a new one.
 */

import {
  getStation, getShifts, getCurrentRateMap, getPumps, watchShifts,
} from './store.js';
import {
  formatFirebaseError, can, canUsePump, filterMyPumps, getCurrentUserData,
} from './auth.js';
import { openShiftForm } from './pumps.js';
import {
  h, formatCurrency, formatVolume, formatDate, formatTime, getGreeting,
  getTodayDate, emptyState, showSkeleton, rangeStart, openModal, closeModal,
} from './components.js';

const RANGE_LABEL = { today: 'Today', week: 'Last 7 days', month: 'Last 30 days', all: 'All time' };

// ── Live feed state (one subscription at a time) ────────────────────────
let feedCtx = null;      // { stationId, pumps, rateMap, token }
let feedUnsub = null;
let latestRows = [];     // newest shifts delivered by the subscription
let wired = false;

export function initDashboard() {
  if (wired) return;
  wired = true;
  // One delegated listener survives feed re-renders.
  document.getElementById('page-content').addEventListener('click', (e) => {
    const row = e.target.closest('.feed-row');
    if (row && feedCtx && document.contains(row)) openPumpDetail(row.dataset.pumpId);
  });
}

export function stopLiveFeed() {
  if (feedUnsub) { try { feedUnsub(); } catch { /* already closed */ } }
  feedUnsub = null;
  feedCtx = null;
  latestRows = [];
}

// ── Render ──────────────────────────────────────────────────────────────
export async function renderDashboard(stationId, range = 'today') {
  const content = document.getElementById('page-content');
  stopLiveFeed();

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
    const [station, shifts, rateMap, allPumps] = await Promise.all([
      getStation(stationId),
      getShifts(stationId, { from }),
      getCurrentRateMap(stationId),
      getPumps(stationId),
    ]);

    if (!station) {
      content.innerHTML = emptyState('⚠️', 'Station not found. It may have been deleted.');
      return;
    }

    // Staff only ever see their assigned pumps and their own readings.
    const pumps = filterMyPumps(allPumps);
    const ownOnly = !can('shift.update', { stationId });

    let volume = 0, sales = 0;
    for (const s of shifts) {
      volume += Number(s.volume) || 0;
      sales += Number(s.sales) || 0;
    }

    const label = RANGE_LABEL[range] || 'Today';
    const entryWord = `${shifts.length} ${ownOnly ? 'of your ' : ''}entr${shifts.length === 1 ? 'y' : 'ies'}`;

    const rateCards = Object.entries(rateMap).map(([product, r]) => `
      <article class="stat-card">
        <div class="stat-card-icon amber" aria-hidden="true">⛽</div>
        <h3 class="stat-card-label">${h(product)}</h3>
        <p class="stat-card-value">${formatCurrency(r.rate)}</p>
        <p class="stat-card-sub">per litre</p>
      </article>
    `).join('');

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
          <p class="stat-card-sub">${h(entryWord)}</p>
        </article>
        ${rateCards}
      </div>

      <div class="live-head">
        <h3 class="section-title">Live pump status</h3>
        <span class="live-badge" role="status">
          <span class="live-dot" aria-hidden="true"></span>LIVE
        </span>
      </div>
      <p class="feed-summary" id="feed-summary"></p>
      <div id="feed-list">${feedListHTML(pumps, shifts, stationId)}</div>
      <p class="feed-updated" id="feed-updated"></p>
    `;

    startLiveFeed(stationId, pumps, rateMap, shifts);
  } catch (err) {
    console.error('Dashboard render error:', err);
    content.innerHTML = emptyState('⚠️', formatFirebaseError(err));
  }
}

// Newest first: by shift date, then by creation time.
const byNewest = (a, b) => {
  const d = (b.date || '').localeCompare(a.date || '');
  return d !== 0 ? d : (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0);
};

// ── Subscription ────────────────────────────────────────────────────────
function startLiveFeed(stationId, pumps, rateMap, seedRows) {
  const token = Symbol(stationId);
  feedCtx = { stationId, pumps, rateMap, token };

  // Keep range-fetched records and merge live deliveries on top, so a pump
  // whose last reading is older than the live window still shows "Stopped"
  // instead of being mistaken for never-used.
  const known = new Map();
  (seedRows || []).forEach(r => known.set(r.id, r));
  latestRows = [...known.values()].sort(byNewest);
  paintFeed(latestRows, { at: Date.now(), fromCache: true });

  feedUnsub = watchShifts(stationId, {
    onUpdate: (rows, meta) => {
      // Ignore stale deliveries after the view moved on.
      if (!feedCtx || feedCtx.token !== token) return;
      rows.forEach(r => known.set(r.id, r));
      latestRows = [...known.values()].sort(byNewest);
      paintFeed(latestRows, meta);
    },
    onError: (err) => {
      if (!feedCtx || feedCtx.token !== token) return;
      const el = document.getElementById('feed-updated');
      if (el) el.textContent = 'Live updates paused — pull ↻ to refresh.';
      console.warn('Live feed paused:', err?.code || err);
    },
  });
}

// ── Feed computation + paint ────────────────────────────────────────────
function pumpStatus(pumpId, rows) {
  const today = getTodayDate();
  let todayCount = 0, todayVol = 0, todaySales = 0, last = null;

  for (const s of rows) {
    if (s.pumpId !== pumpId) continue;
    if (!last) last = s; // rows arrive sorted newest-first
    if (s.date === today) {
      todayCount += 1;
      todayVol += Number(s.volume) || 0;
      todaySales += Number(s.sales) || 0;
    }
  }

  return {
    state: todayCount > 0 ? 'active' : last ? 'stopped' : 'none',
    todayCount, todayVol, todaySales, last,
  };
}

const STATUS_META = {
  active:  { chip: 'Active',      cls: 'active',  icon: '●' },
  stopped: { chip: 'Stopped',     cls: 'stopped', icon: '◼' },
  none:    { chip: 'No readings', cls: 'none',    icon: '○' },
};

function timeAgo(createdAt, date) {
  const d = createdAt && typeof createdAt.toDate === 'function' ? createdAt.toDate() : null;
  if (!d) return date ? formatDate(date) : '';
  const mins = Math.floor((Date.now() - d.getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return formatDate(d);
}

function feedListHTML(pumps, rows, stationId) {
  if (!pumps.length) {
    return emptyState('⛽', 'No pumps to show. '
      + (can('pump.create', { stationId })
        ? 'Add them from Config → Pumps.'
        : 'Ask your admin or manager to assign pumps to you.'));
  }

  const items = pumps.map(p => {
    const st = pumpStatus(p.id, rows);
    const meta = STATUS_META[st.state];
    const me = getCurrentUserData();

    const mainLine = st.state === 'active'
      ? `${st.todayCount} reading${st.todayCount === 1 ? '' : 's'} today · ${formatVolume(st.todayVol)} · ${formatCurrency(st.todaySales)}`
      : st.last
        ? `Last reading ${timeAgo(st.last.createdAt, st.last.date)}${st.last.createdBy && me && st.last.createdBy !== me.uid ? ' · by staff' : ''}`
        : 'No readings logged yet';
    const time = st.last ? (formatTime(st.last.createdAt) || '') : '';

    return `
      <li>
        <button class="card-row feed-row" data-pump-id="${h(p.id)}"
                aria-label="${h(p.name)} — ${meta.chip}. Open pump details">
          <span class="feed-dot ${meta.cls}" aria-hidden="true"></span>
          <span class="card-row-body">
            <span class="card-row-title">${h(p.name)}</span>
            <span class="card-row-meta">${h(p.product || 'No product')} · ${h(mainLine)}</span>
          </span>
          <span class="feed-right">
            <span class="status-chip ${meta.cls}">${meta.chip}</span>
            ${time ? `<span class="feed-time">${h(time)}</span>` : ''}
          </span>
        </button>
      </li>
    `;
  }).join('');

  return `<ul class="plain-list feed-list">${items}</ul>`;
}

function paintFeed(rows, meta = {}) {
  if (!feedCtx) return;
  const list = document.getElementById('feed-list');
  if (!list) return;

  const today = getTodayDate();
  const activeCount = feedCtx.pumps.filter(p =>
    rows.some(s => s.pumpId === p.id && s.date === today)).length;

  const summary = document.getElementById('feed-summary');
  if (summary) {
    summary.textContent = feedCtx.pumps.length
      ? `${activeCount} of ${feedCtx.pumps.length} pump${feedCtx.pumps.length === 1 ? '' : 's'} active today — tap a pump for details`
      : '';
  }

  list.innerHTML = feedListHTML(feedCtx.pumps, rows, feedCtx.stationId);

  const updated = document.getElementById('feed-updated');
  if (updated) {
    const t = new Date(meta.at || Date.now());
    updated.textContent = `Updated ${t.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`
      + (meta.fromCache ? ' · cached' : '');
  }
}

// ── Pump detail modal ───────────────────────────────────────────────────
function openPumpDetail(pumpId) {
  if (!feedCtx) return;
  const { stationId, pumps, rateMap } = feedCtx;
  const pump = pumps.find(p => p.id === pumpId);
  if (!pump) return;

  const st = pumpStatus(pumpId, latestRows);
  const meta = STATUS_META[st.state];
  const recent = latestRows.filter(s => s.pumpId === pumpId).slice(0, 5);
  const mayLog = can('shift.create', { stationId }) && canUsePump(pump.id);
  const rate = rateMap[pump.product];

  const recentList = recent.length
    ? `<ul class="feed-detail-list">${recent.map(s => `
        <li>
          <span class="shift-badge">S${h(s.shiftLabel || '?')}</span>
          <span class="feed-detail-main">
            <strong>${formatVolume(s.volume)}</strong> · ${formatCurrency(s.sales)}
            <small>${h(formatDate(s.date))}${formatTime(s.createdAt) ? ' · ' + h(formatTime(s.createdAt)) : ''}</small>
          </span>
        </li>`).join('')}</ul>`
    : '<p class="muted-note">No readings recorded for this pump yet.</p>';

  document.getElementById('modal-title').textContent = pump.name;
  document.getElementById('modal-body').innerHTML = `
    <div class="feed-detail-head">
      <span class="status-chip ${meta.cls}">${meta.icon} ${meta.chip}</span>
      <span class="muted-note">${h(pump.product || 'No product')}${rate ? ` · ${formatCurrency(rate.rate)}/L` : ''}</span>
    </div>
    <div class="feed-detail-today">
      <div><span class="label">Today</span><strong>${st.todayCount} reading${st.todayCount === 1 ? '' : 's'}</strong></div>
      <div><span class="label">Volume</span><strong>${formatVolume(st.todayVol)}</strong></div>
      <div><span class="label">Sales</span><strong>${formatCurrency(st.todaySales)}</strong></div>
    </div>
    <h4 class="feed-detail-subhead">Recent readings</h4>
    ${recentList}
    ${mayLog ? '<button type="button" id="feed-log-btn" class="btn btn-primary btn-full mt-16">Log reading</button>' : ''}
  `;
  openModal('generic-modal');

  document.getElementById('feed-log-btn')?.addEventListener('click', () => {
    closeModal('generic-modal');
    openShiftForm(stationId, pump, rate);
  });
}
