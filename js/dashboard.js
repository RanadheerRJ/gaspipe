/* PumpLog — Dashboard with live pump sessions and shift feed */

import {
  getStation, getShifts, getCurrentRateMap, getPumps, getPumpSessions,
  watchShifts, watchPumpSessions,
} from './store.js';
import { can, canUsePump, filterMyPumps, getCurrentUserData } from './auth.js';
import { openShiftForm } from './pumps.js';
import {
  h, formatCurrency, formatVolume, formatDate, formatTime, formatDateTime,
  formatTimeAgo, getGreeting, getTodayDate, emptyState, showSkeleton,
  rangeStart, openModal, closeModal,
} from './components.js';

const RANGE_LABEL = { today: 'Today', week: 'Last 7 days', month: 'Last 30 days', all: 'All time' };
let feedCtx = null;
let shiftUnsub = null;
let sessionUnsub = null;
let latestRows = [];
let latestSessions = [];
let wired = false;

export function initDashboard() {
  if (wired) return;
  wired = true;
  document.getElementById('page-content').addEventListener('click', e => {
    const row = e.target.closest('.feed-row');
    if (row && feedCtx && document.contains(row)) openPumpDetail(row.dataset.pumpId);
  });
}

export function stopLiveFeed() {
  [shiftUnsub, sessionUnsub].forEach(unsub => {
    if (unsub) { try { unsub(); } catch { /* already closed */ } }
  });
  shiftUnsub = null;
  sessionUnsub = null;
  feedCtx = null;
  latestRows = [];
  latestSessions = [];
}

export async function renderDashboard(stationId, range = 'today') {
  const content = document.getElementById('page-content');
  stopLiveFeed();
  if (!stationId) {
    content.innerHTML = `<div class="welcome-section"><h2 class="welcome-greeting">${getGreeting()}</h2>
      <p class="welcome-sub">Select a station to get started</p></div>
      ${emptyState('⛽', 'Tap the station name in the top bar to choose a station.')}`;
    return;
  }

  showSkeleton(3);
  try {
    const from = rangeStart(range);
    const [station, shifts, rateMap, allPumps, sessions] = await Promise.all([
      getStation(stationId),
      getShifts(stationId, { from }),
      getCurrentRateMap(stationId),
      getPumps(stationId),
      getPumpSessions(stationId),
    ]);
    if (!station) {
      content.innerHTML = emptyState('⚠️', 'Station not found. It may have been deleted.');
      return;
    }

    const pumps = filterMyPumps(allPumps);
    const ownOnly = !can('shift.update', { stationId });
    const volume = shifts.reduce((sum, s) => sum + (Number(s.volume) || 0), 0);
    const sales = shifts.reduce((sum, s) => sum + (Number(s.sales) || 0), 0);
    const label = RANGE_LABEL[range] || 'Today';
    const entryWord = `${shifts.length} ${ownOnly ? 'of your ' : ''}entr${shifts.length === 1 ? 'y' : 'ies'}`;
    const rateCards = Object.entries(rateMap).map(([product, r]) => `<article class="stat-card">
      <div class="stat-card-icon amber" aria-hidden="true">⛽</div><h3 class="stat-card-label">${h(product)}</h3>
      <p class="stat-card-value">${formatCurrency(r.rate)}</p><p class="stat-card-sub">per litre</p></article>`).join('');

    content.innerHTML = `<div class="welcome-section"><h2 class="welcome-greeting">${getGreeting()}</h2>
      <p class="welcome-sub">${h(station.name)} · ${h(label)}</p></div>
      <div class="stats-grid">
        <article class="stat-card"><div class="stat-card-icon blue" aria-hidden="true">📊</div>
          <h3 class="stat-card-label">Volume</h3><p class="stat-card-value">${formatVolume(volume)}</p><p class="stat-card-sub">${h(label)}</p></article>
        <article class="stat-card"><div class="stat-card-icon green" aria-hidden="true">💰</div>
          <h3 class="stat-card-label">Sales</h3><p class="stat-card-value">${formatCurrency(sales)}</p><p class="stat-card-sub">${h(entryWord)}</p></article>
        ${rateCards}
      </div>
      <div class="live-head"><h3 class="section-title">Live pump status</h3>
        <span class="live-badge" role="status"><span class="live-dot" aria-hidden="true"></span>LIVE</span></div>
      <p class="feed-summary" id="feed-summary"></p>
      <div id="feed-list">${feedListHTML(pumps, shifts, sessions, stationId)}</div>
      <p class="feed-updated" id="feed-updated"></p>`;
    startLiveFeed(stationId, pumps, rateMap, shifts, sessions);
  } catch (err) {
    console.error('Dashboard render error:', err);
    content.innerHTML = emptyState('⚠️', err?.message || 'Could not load the dashboard.');
  }
}

const byNewest = (a, b) => {
  const d = (b.date || '').localeCompare(a.date || '');
  return d !== 0 ? d : (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0);
};

function startLiveFeed(stationId, pumps, rateMap, seedRows, seedSessions) {
  const token = Symbol(stationId);
  feedCtx = { stationId, pumps, rateMap, token };
  const known = new Map((seedRows || []).map(row => [row.id, row]));
  latestRows = [...known.values()].sort(byNewest);
  latestSessions = seedSessions || [];
  paintFeed({ at: Date.now(), fromCache: true });

  shiftUnsub = watchShifts(stationId, {
    onUpdate: (rows, meta) => {
      if (!feedCtx || feedCtx.token !== token) return;
      rows.forEach(row => known.set(row.id, row));
      latestRows = [...known.values()].sort(byNewest);
      paintFeed(meta);
    },
    onError: err => {
      if (!feedCtx || feedCtx.token !== token) return;
      const el = document.getElementById('feed-updated');
      if (el) el.textContent = 'Live updates paused — pull ↻ to refresh.';
      console.warn('Live shift feed paused:', err?.code || err);
    },
  });
  sessionUnsub = watchPumpSessions(stationId, {
    onUpdate: (sessions, meta) => {
      if (!feedCtx || feedCtx.token !== token) return;
      latestSessions = sessions;
      paintFeed(meta);
    },
    onError: err => console.warn('Live pump status paused:', err?.code || err),
  });
}

function getSession(pumpId, sessions = latestSessions) {
  return sessions.find(s => s.id === pumpId && s.status === 'active') || null;
}

function pumpStatus(pumpId, rows, sessions = latestSessions) {
  const today = getTodayDate();
  let todayCount = 0, todayVol = 0, todaySales = 0, last = null;
  for (const shift of rows) {
    if (shift.pumpId !== pumpId) continue;
    if (!last) last = shift;
    if (shift.date === today) {
      todayCount += 1;
      todayVol += Number(shift.volume) || 0;
      todaySales += Number(shift.sales) || 0;
    }
  }
  const session = getSession(pumpId, sessions);
  let state = 'none';
  if (session) state = session.activeUid === getCurrentUserData()?.uid ? 'activeMine' : 'activeOther';
  else if (last) state = 'stopped';
  return { state, session, todayCount, todayVol, todaySales, last };
}

const STATUS_META = {
  activeMine:  { chip: 'Active — you', cls: 'active-mine', icon: '●' },
  activeOther: { chip: 'In use', cls: 'active-other', icon: '🔒' },
  stopped:     { chip: 'Idle', cls: 'idle', icon: '○' },
  none:        { chip: 'Idle', cls: 'idle', icon: '○' },
};

function shiftTime(createdAt, date) {
  const at = createdAt && typeof createdAt.toDate === 'function' ? createdAt.toDate() : null;
  if (!at) return date ? formatDate(date) : '';
  const minutes = Math.floor((Date.now() - at.getTime()) / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h ago`;
  return formatDate(at);
}

function visibleActiveName(session) {
  const admin = ['superadmin', 'stationadmin'].includes(getCurrentUserData()?.role);
  return admin ? session?.activeName : '';
}

function feedListHTML(pumps, rows, sessions, stationId) {
  if (!pumps.length) return emptyState('⛽', 'No pumps to show. '
    + (can('pump.create', { stationId }) ? 'Add them from Config → Pumps.' : 'Ask your admin or manager to assign pumps to you.'));
  const items = pumps.map(pump => {
    const status = pumpStatus(pump.id, rows, sessions);
    const meta = STATUS_META[status.state];
    const activeName = visibleActiveName(status.session);
    const liveLine = status.session
      ? `Started ${formatTimeAgo(status.session.clockInAt) || 'just now'}${activeName ? ` · ${activeName}` : ''}`
      : status.last
        ? `Last reading ${shiftTime(status.last.createdAt, status.last.date)}`
        : 'No readings logged yet';
    const readingLine = status.todayCount
      ? `${status.todayCount} reading${status.todayCount === 1 ? '' : 's'} today · ${formatVolume(status.todayVol)} · ${formatCurrency(status.todaySales)}`
      : liveLine;
    return `<li><button class="card-row feed-row" data-pump-id="${h(pump.id)}"
      aria-label="${h(pump.name)} — ${h(meta.chip)}. Open pump details">
      <span class="feed-dot ${meta.cls}" aria-hidden="true">${meta.icon}</span>
      <span class="card-row-body"><span class="card-row-title">${h(pump.name)}</span>
        <span class="card-row-meta">${h(pump.product || 'No product')} · ${h(readingLine)}</span></span>
      <span class="feed-right"><span class="status-chip ${meta.cls}">${meta.icon} ${h(meta.chip)}</span>
        ${status.last?.createdAt ? `<span class="feed-time">${h(formatTime(status.last.createdAt))}</span>` : ''}</span>
    </button></li>`;
  }).join('');
  return `<ul class="plain-list feed-list">${items}</ul>`;
}

function paintFeed(meta = {}) {
  if (!feedCtx) return;
  const list = document.getElementById('feed-list');
  if (!list) return;
  const activeCount = feedCtx.pumps.filter(p => getSession(p.id)).length;
  const summary = document.getElementById('feed-summary');
  if (summary) summary.textContent = feedCtx.pumps.length
    ? `${activeCount} of ${feedCtx.pumps.length} pump${feedCtx.pumps.length === 1 ? '' : 's'} currently active — tap a pump for details`
    : '';
  list.innerHTML = feedListHTML(feedCtx.pumps, latestRows, latestSessions, feedCtx.stationId);
  const updated = document.getElementById('feed-updated');
  if (updated) {
    const time = new Date(meta.at || Date.now());
    updated.textContent = `Updated ${time.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}${meta.fromCache ? ' · cached' : ''}`;
  }
}

function openPumpDetail(pumpId) {
  if (!feedCtx) return;
  const { stationId, pumps, rateMap } = feedCtx;
  const pump = pumps.find(p => p.id === pumpId);
  if (!pump) return;
  const status = pumpStatus(pumpId, latestRows, latestSessions);
  const meta = STATUS_META[status.state];
  const recent = latestRows.filter(s => s.pumpId === pumpId).slice(0, 5);
  const mayLog = can('shift.create', { stationId }) && canUsePump(pump.id)
    && (!status.session || status.session.activeUid === getCurrentUserData()?.uid);
  const rate = rateMap[pump.product];
  const recentList = recent.length ? `<ul class="feed-detail-list">${recent.map(s => `<li>
    <span class="shift-badge">S${h(s.shiftLabel || '?')}</span><span class="feed-detail-main"><strong>${formatVolume(s.volume)}</strong> · ${formatCurrency(s.sales)}
      <small>${h(formatDate(s.date))}${formatTime(s.createdAt) ? ` · ${h(formatTime(s.createdAt))}` : ''}${s.hoursWorked != null ? ` · ${h(Number(s.hoursWorked).toFixed(2))} h` : ''}</small></span></li>`).join('')}</ul>`
    : '<p class="muted-note">No readings recorded for this pump yet.</p>';
  const sessionLine = status.session
    ? `Started ${formatDateTime(status.session.clockInAt) || 'just now'}${visibleActiveName(status.session) ? ` by ${visibleActiveName(status.session)}` : ''}`
    : 'No active shift';
  document.getElementById('modal-title').textContent = pump.name;
  document.getElementById('modal-body').innerHTML = `<div class="feed-detail-head"><span class="status-chip ${meta.cls}">${meta.icon} ${h(meta.chip)}</span>
    <span class="muted-note">${h(pump.product || 'No product')}${rate ? ` · ${formatCurrency(rate.rate)}/L` : ''}</span></div>
    <p class="session-reference">${h(sessionLine)}</p>
    <div class="feed-detail-today"><div><span class="label">Today</span><strong>${status.todayCount} reading${status.todayCount === 1 ? '' : 's'}</strong></div>
      <div><span class="label">Volume</span><strong>${formatVolume(status.todayVol)}</strong></div><div><span class="label">Sales</span><strong>${formatCurrency(status.todaySales)}</strong></div></div>
    <h4 class="feed-detail-subhead">Recent readings</h4>${recentList}
    ${mayLog ? '<button type="button" id="feed-log-btn" class="btn btn-primary btn-full mt-16">' + (status.session ? 'End shift' : 'Start shift') + '</button>' : ''}`;
  openModal('generic-modal');
  document.getElementById('feed-log-btn')?.addEventListener('click', () => {
    closeModal('generic-modal');
    openShiftForm(stationId, pump, rate, status.session);
  });
}
