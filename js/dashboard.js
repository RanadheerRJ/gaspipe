/* PumpLog — Dashboard with live pump sessions and staff-friendly status board
 *
 * Clean, simple design:
 *   - Greeting with Full Name, Date, time, Day + emoji (☕ morning / 🍵 afternoon / 🥤 evening)
 *   - Profile pic in header
 *   - Station info card: Today's rates + last updated, personal volume/sales
 *   - Filter bar: Today / Yesterday / This Week + date picker for historical view
 *   - Live pump status feed below
 */

import {
  getStation, getShifts, getCurrentRateMap, getRates, getPumps, getPumpSessions,
  getAllStations, getStationsByIds, watchShifts, watchPumpSessions,
  getAssignments, pumpIdsForUser,
} from './store.js';
import {
  can, ifCan, canUsePump, filterMyPumps, getCurrentUserData, formatFirebaseError,
  isSuperAdmin, isStationOverseer, userDisplayName,
  setMyDailyPumps,
} from './auth.js';
import { openShiftForm } from './pumps.js';
import {
  h, formatCurrency, formatVolume, formatDate, formatTime, formatDateTime,
  formatTimeAgo, getGreeting, getTodayDate, emptyState, showSkeleton, setBusy,
  rangeStart, openModal, closeModal, timestampToDate,
} from './components.js';
import { avatarHTML } from './profile.js';

// ── Time-of-day emoji ─────────────────────────────────────────────────
function timeEmoji() {
  const hour = new Date().getHours();
  if (hour < 5) return '🌙';   // late night
  if (hour < 12) return '☕';   // morning coffee
  if (hour < 17) return '🍵';   // afternoon tea
  if (hour < 21) return '🥤';   // evening
  return '🌙';                   // night
}

function dayName(date) {
  return date.toLocaleDateString('en-IN', { weekday: 'long' });
}

const RANGE_LABEL = { today: 'Today', yesterday: 'Yesterday', week: 'This week', all: 'All time' };
const RATE_COLLAPSED_KEY = 'pumplog:dashboard:ratesCollapsed';
let feedCtx = null;
let shiftUnsub = null;
let sessionUnsub = null;
let clockTimer = null;
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
  if (clockTimer) clearInterval(clockTimer);
  clockTimer = null;
  feedCtx = null;
  latestRows = [];
  latestSessions = [];
}

function todayRateMap(rates) {
  const today = getTodayDate();
  const map = {};
  for (const rate of rates || []) {
    if (!rate.effectiveDate || rate.effectiveDate > today) continue;
    if (!map[rate.product] || (rate.effectiveDate || '') > (map[rate.product].effectiveDate || '')) {
      map[rate.product] = rate;
    }
  }
  return map;
}

function formatElapsedHours(value) {
  const date = timestampToDate(value);
  if (!date) return '—';
  const hours = Math.max(0, (Date.now() - date.getTime()) / 3600000);
  return `${hours.toFixed(2)} h`;
}

function activeMine(sessions) {
  const uid = getCurrentUserData()?.uid;
  return (sessions || []).filter(session => session.status === 'active' && session.activeUid === uid);
}

// ── Greeting header ───────────────────────────────────────────────────
function greetingHTML(station, sessions, accessibleStations) {
  const me = getCurrentUserData() || {};
  const mine = activeMine(sessions);
  const now = new Date();
  const emoji = timeEmoji();
  const name = userDisplayName(me);
  const greetingText = getGreeting();
  const dateStr = now.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
  const dayStr = dayName(now);
  const timeStr = now.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
  const stationNames = (accessibleStations || []).map(s => s.name).filter(Boolean);
  const assignedText = stationNames.length ? stationNames.join(', ') : station?.name || 'No station assigned';
  const activeText = mine.length
    ? `${formatElapsedHours(mine[0].clockInAt)} · ${mine.length} pump${mine.length === 1 ? '' : 's'}`
    : null;

  return `<section class="dashboard-greeting" aria-label="Greeting">
    <div class="greeting-row">
      ${avatarHTML(me, 'medium')}
      <div class="greeting-text">
        <h2 class="welcome-greeting">${emoji} ${h(greetingText)}, ${h(name.split(' ')[0])}</h2>
        <p class="greeting-date">${h(dateStr)} · ${h(dayStr)} · ${h(timeStr)}</p>
        <p class="greeting-station">⛽ ${h(station?.name || assignedText)}</p>
      </div>
    </div>
    ${activeText ? `<div class="greeting-active"><span class="status-chip active-mine">● Active: ${h(activeText)}</span></div>` : ''}
  </section>`;
}

function updateGreetingClock() {
  // Update just the time portion without re-rendering everything
  const clock = document.getElementById('greeting-time');
  if (clock) {
    clock.textContent = new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
  }
  // Update active hours
  const active = activeMine(latestSessions);
  const hours = document.getElementById('greeting-active-hours');
  if (hours) {
    hours.textContent = active.length
      ? `${formatElapsedHours(active[0].clockInAt)} · ${active.length} pump${active.length === 1 ? '' : 's'}`
      : '';
  }
}

function startGreetingClock() {
  updateGreetingClock();
  clockTimer = window.setInterval(updateGreetingClock, 10000);
}

// ── Filter bar for dashboard ──────────────────────────────────────────
function filterBarHTML(selectedRange, selectedDate) {
  const chips = [
    ['today', 'Today'],
    ['yesterday', 'Yesterday'],
    ['week', 'This week'],
    ['all', 'All time'],
  ];
  const isCustom = selectedRange === 'custom';
  return `<div class="dash-filter-bar" role="group" aria-label="Filter data">
    ${chips.map(([value, label]) =>
      `<button type="button" class="chip ${selectedRange === value ? 'chip-active' : ''}" data-dash-range="${value}" aria-pressed="${selectedRange === value}">${label}</button>`
    ).join('')}
    <div class="dash-date-picker">
      <input type="date" id="dash-date-picker" class="dash-date-input" value="${h(selectedDate || '')}" max="${getTodayDate()}" title="Pick a date" />
    </div>
  </div>`;
}

// ── Station info card (Robinhood-style widget) ────────────────────────
function stationInfoCardHTML(station, rateMap, shifts, ownShifts, stationId, range, myPumps, sessions) {
  // Today's rates with last effective date
  const rateEntries = Object.entries(rateMap || {});
  const ratesBody = rateEntries.length
    ? rateEntries.map(([product, rate]) =>
        `<div class="info-rate-row"><span class="info-rate-product">${h(product)}</span><span class="info-rate-value">${formatCurrency(rate.rate)}/L</span><small>${h(formatDate(rate.effectiveDate) || 'today')}</small></div>`
      ).join('')
    : '<p class="muted-note">No rates configured</p>';

  // Personal totals for the selected range
  const me = getCurrentUserData();
  const myShifts = ownShifts || shifts.filter(s => (s.staffId || s.staffUid || s.createdBy) === me?.uid);
  const myVolume = myShifts.reduce((sum, s) => sum + (Number(s.volume) || 0), 0);
  const mySales = myShifts.reduce((sum, s) => sum + (Number(s.sales) || 0), 0);
  const myCount = myShifts.length;
  const myHours = myShifts.reduce((sum, s) => sum + (Number(s.hoursWorked) || 0), 0);
  const rangeLabel = RANGE_LABEL[range] || 'Today';

  // Pending approval
  const pendingShifts = shifts.filter(s => s.status === 'pending');
  const pendingSales = pendingShifts.reduce((sum, s) => sum + (Number(s.sales) || 0), 0);
  const pendingCount = pendingShifts.length;
  const pendingLine = pendingCount > 0
    ? ifCan('shift.update', { stationId },
      `<p class="pending-approval-line">⏳ ${pendingCount} shift${pendingCount === 1 ? '' : 's'} waiting for approval — ${formatCurrency(pendingSales)}</p>`)
    : '';

  // Active session count
  const activeCount = (sessions || []).filter(s => s.status === 'active').length;

  return `<section class="station-info-card" aria-label="Station information">
    <div class="info-columns">
      <div class="info-block info-rates">
        <h4 class="info-title">💰 Rates</h4>
        <div class="info-rates-list">${ratesBody}</div>
      </div>
      <div class="info-block info-personal">
        <h4 class="info-title">📊 My ${h(rangeLabel)}</h4>
        <div class="info-personal-grid">
          <div class="info-stat"><span class="info-stat-label">Entries</span><strong>${myCount}</strong></div>
          <div class="info-stat"><span class="info-stat-label">Volume</span><strong>${formatVolume(myVolume)}</strong></div>
          <div class="info-stat"><span class="info-stat-label">Sales</span><strong>${formatCurrency(mySales)}</strong></div>
          <div class="info-stat"><span class="info-stat-label">Hours</span><strong>${myHours.toFixed(1)} h</strong></div>
        </div>
      </div>
      <div class="info-block info-station">
        <h4 class="info-title">⛽ Station</h4>
        <div class="info-station-grid">
          <div class="info-stat"><span class="info-stat-label">Active pumps</span><strong>${activeCount} / ${myPumps.length}</strong></div>
          <div class="info-stat"><span class="info-stat-label">Total shifts</span><strong>${shifts.length}</strong></div>
        </div>
      </div>
    </div>
    ${pendingLine}
  </section>`;
}

// ── Quick start (staff with no active shift) ──────────────────────────
async function loadQuickStartData(currentStationId, currentStation, currentPumps, currentRateMap, currentSessions) {
  if (isStationOverseer() || activeMine(currentSessions).length) return null;
  const stations = await accessibleStationList(currentStationId, currentStation);
  const rows = [];
  for (const station of stations) {
    let pumps = station.id === currentStationId ? currentPumps : [];
    let rateMap = station.id === currentStationId ? currentRateMap : {};
    let sessions = station.id === currentStationId ? currentSessions : [];
    if (station.id !== currentStationId) {
      try {
        [pumps, rateMap, sessions] = await Promise.all([
          getPumps(station.id), getCurrentRateMap(station.id), getPumpSessions(station.id),
        ]);
      } catch { continue; }
    }
    const assigned = filterMyPumps(pumps);
    if (assigned.length) rows.push({ station, pumps: assigned, rateMap, sessions });
  }
  if (rows.some(row => activeMine(row.sessions).length)) return null;
  return rows.length ? { stations: rows, selected: rows[0].station.id } : null;
}

function quickStartHTML(quick) {
  if (!quick) return '';
  const stationSelect = quick.stations.length > 1 ? `<label class="quick-station-label" for="quick-station">Start at</label>
    <select id="quick-station" class="quick-station-select">${quick.stations.map(row =>
      `<option value="${h(row.station.id)}" ${row.station.id === quick.selected ? 'selected' : ''}>${h(row.station.name)}</option>`).join('')}</select>` : '';
  return `<section class="quick-start-card" aria-labelledby="quick-start-title"><div class="quick-start-copy">
    <span class="quick-start-icon" aria-hidden="true">☀️</span><div><h3 id="quick-start-title">Start my day</h3>
    <p>You have not started a shift. Choose a pump to begin.</p></div></div>
    <div class="quick-start-controls">${stationSelect}<div id="quick-start-pumps">${quickPumpButtons(quick.stations[0])}</div></div></section>`;
}

function quickPumpButtons(row) {
  if (!row) return emptyState('⛽', 'No assigned pumps at this station.');
  const me = getCurrentUserData();
  return `<div class="quick-pump-list">${row.pumps.map(pump => {
    const session = row.sessions.find(s => s.id === pump.id && s.status === 'active');
    const other = session && session.activeUid !== me?.uid;
    const rate = row.rateMap[pump.product];
    return ifCan('pumpSession.start', { stationId: row.station.id, pumpId: pump.id },
      `<button type="button" class="quick-pump-btn" data-quick-pump="${h(pump.id)}" ${other ? 'disabled' : ''}>
        <span aria-hidden="true">⛽</span><span><strong>${h(pump.name)}</strong><small>${h(pump.product || 'No product')}${rate ? ` · ${h(formatCurrency(rate.rate))}/L` : ''}</small></span>
        <span>${other ? 'In use' : '▶️ Start shift'}</span></button>`);
  }).join('')}</div>`;
}

function wireQuickStart(quick) {
  const select = document.getElementById('quick-station');
  const list = document.getElementById('quick-start-pumps');
  const rowFor = id => quick.stations.find(row => row.station.id === id);
  const paint = () => {
    const row = rowFor(select?.value || quick.selected);
    if (list) list.innerHTML = quickPumpButtons(row);
    list?.querySelectorAll('[data-quick-pump]').forEach(button => button.addEventListener('click', () => {
      const pump = row.pumps.find(item => item.id === button.dataset.quickPump);
      if (pump) openShiftForm(row.station.id, pump, row.rateMap[pump.product], null);
    }));
  };
  select?.addEventListener('change', paint);
  paint();
}

async function accessibleStationList(currentStationId, currentStation) {
  try {
    const stations = isSuperAdmin()
      ? await getAllStations()
      : await getStationsByIds(getCurrentUserData()?.stationIds || []);
    if (!stations.some(s => s.id === currentStationId) && currentStation) stations.unshift(currentStation);
    return stations;
  } catch {
    return currentStation ? [currentStation] : [];
  }
}

// ── Rate card (collapsible) ───────────────────────────────────────────
function rateCardHTML(rateMap) {
  const collapsed = localStorage.getItem(RATE_COLLAPSED_KEY) === 'true';
  const rows = Object.entries(rateMap || {}).map(([product, rate]) => `<div class="daily-rate-row"><span>${h(product)}</span><strong>${h(formatCurrency(rate.rate))}/L</strong><small>Effective ${h(formatDate(rate.effectiveDate) || 'today')}</small></div>`).join('');
  return `<section class="daily-rates-card ${collapsed ? 'is-collapsed' : ''}" aria-labelledby="daily-rates-title">
    <div class="daily-rates-head"><button type="button" class="daily-rates-toggle" id="daily-rates-toggle" aria-expanded="${!collapsed}" aria-controls="daily-rates-body">
      <span><span class="daily-rates-icon" aria-hidden="true">₹</span><span><strong id="daily-rates-title">Daily rates</strong><small>Current station prices</small></span></span><span class="chevron" aria-hidden="true">⌄</span></button>
      <span id="rate-active-hours" class="rate-active-hours"></span></div>
    <div id="daily-rates-body" class="daily-rates-body" ${collapsed ? 'hidden' : ''}>${rows || '<p class="muted-note">No rate is configured for today.</p>'}</div></section>`;
}

function wireRateCard(stationId) {
  const toggle = document.getElementById('daily-rates-toggle');
  const body = document.getElementById('daily-rates-body');
  toggle?.addEventListener('click', () => {
    const collapsed = body.hidden;
    body.hidden = !collapsed;
    toggle.setAttribute('aria-expanded', String(!collapsed));
    toggle.closest('.daily-rates-card')?.classList.toggle('is-collapsed', !collapsed);
    localStorage.setItem(RATE_COLLAPSED_KEY, String(!collapsed));
  });
}

// ── Main render ───────────────────────────────────────────────────────
export async function renderDashboard(stationId, range = 'today') {
  const content = document.getElementById('page-content');
  stopLiveFeed();
  if (!stationId) {
    content.innerHTML = `<div class="welcome-section"><h2 class="welcome-greeting">${getGreeting()}</h2><p class="welcome-sub">Select a station to get started</p></div>${emptyState('⛽', 'Tap the station name in the top bar to choose a station.')}`;
    return;
  }
  showSkeleton(4);
  try {
    let from;
    let customDate = '';
    if (range === 'yesterday') {
      from = getTodayDate(-1);
    } else if (range === 'custom') {
      // Will be passed from the date picker
      from = localStorage.getItem('pumplog:dashCustomDate') || getTodayDate();
      customDate = from;
    } else {
      from = rangeStart(range);
    }

    const [station, shifts, rateMap, rates, allPumps, sessions, assignments] = await Promise.all([
      getStation(stationId), getShifts(stationId, { from }), getCurrentRateMap(stationId), getRates(stationId),
      getPumps(stationId), getPumpSessions(stationId),
      getAssignments(stationId, getTodayDate()).catch(() => []),
    ]);
    if (!station) { content.innerHTML = emptyState('⚠️', 'Station not found. It may have been deleted.'); return; }

    // Refresh today's pump grants before filtering, so a staff member rostered
    // while the app was open sees their pumps here too.
    const meNow = getCurrentUserData();
    if (meNow && !isStationOverseer()) {
      setMyDailyPumps(pumpIdsForUser(assignments, meNow.uid), getTodayDate());
    }

    const assignedPumps = filterMyPumps(allPumps);
    const activeMineIds = new Set(sessions
      .filter(session => session.status === 'active' && session.activeUid === getCurrentUserData()?.uid)
      .map(session => session.id));
    const pumps = allPumps.filter(pump => assignedPumps.includes(pump) || activeMineIds.has(pump.id));
    const ownOnly = !can('shift.update', { stationId });
    const accessibleStations = await accessibleStationList(stationId, station);
    const quick = await loadQuickStartData(stationId, station, pumps, rateMap, sessions);

    content.innerHTML = `${greetingHTML(station, sessions, accessibleStations)}
      ${filterBarHTML(range, customDate)}
      ${stationInfoCardHTML(station, rateMap, shifts, null, stationId, range, pumps, sessions)}
      ${dashboardActionsHTML(stationId, sessions, shifts)}
      ${quickStartHTML(quick)}
      <div class="live-head"><h3 class="section-title">Live pump status</h3><span class="live-badge" role="status"><span class="live-dot" aria-hidden="true"></span>LIVE</span></div>
      <p class="feed-summary" id="feed-summary"></p><div id="feed-list">${feedListHTML(pumps, shifts, sessions, stationId)}</div><p class="feed-updated" id="feed-updated"></p>`;
    startLiveFeed(stationId, pumps, rateMap, shifts, sessions);
    startGreetingClock();
    wireFilterBar(range);
    if (quick) wireQuickStart(quick);
    wireDashboardActions();
  } catch (err) {
    content.innerHTML = emptyState('⚠️', formatFirebaseError(err));
  }
}

function dashboardActionsHTML(stationId, sessions, shifts) {
  const active = (sessions || []).filter(row => row.status === 'active').length;
  const closed = (shifts || []).filter(row => row.date === getTodayDate()).length;
  if (isStationOverseer()) return `<section class="quick-start-card dashboard-actions"><div class="quick-start-copy"><span class="quick-start-icon">✓</span><div><h3>Today’s operations</h3><p>${active} active pumps · ${closed} pumps closed today</p></div></div><div class="quick-start-controls"><button class="btn btn-primary" data-dashboard-page="pumps">Assign shift</button><button class="btn btn-secondary" data-dashboard-page="reports">Generate daily report</button><button class="btn btn-secondary" data-dashboard-page="reports">View reports</button></div></section>`;
  return `<section class="quick-start-card dashboard-actions"><div class="quick-start-copy"><span class="quick-start-icon">⛽</span><div><h3>My shift</h3><p>Start your assigned pump, then enter one closing reading when you finish.</p></div></div><div class="quick-start-controls"><button class="btn btn-primary" data-dashboard-page="pumps">My assigned pump</button><button class="btn btn-secondary" data-dashboard-page="reports">My reports</button></div></section>`;
}

function wireDashboardActions() {
  document.querySelectorAll('[data-dashboard-page]').forEach(button => button.addEventListener('click', () => document.querySelector(`[data-page="${button.dataset.dashboardPage}"]`)?.click()));
}

function wireFilterBar(currentRange) {
  document.querySelectorAll('[data-dash-range]').forEach(btn => {
    btn.addEventListener('click', () => {
      const range = btn.dataset.dashRange;
      // Update chips
      document.querySelectorAll('[data-dash-range]').forEach(c => {
        c.classList.remove('chip-active');
        c.setAttribute('aria-pressed', 'false');
      });
      btn.classList.add('chip-active');
      btn.setAttribute('aria-pressed', 'true');
      // Re-render with the new range
      window.dispatchEvent(new CustomEvent('pumplog:dashRangeChange', { detail: { range } }));
    });
  });

  const datePicker = document.getElementById('dash-date-picker');
  if (datePicker) {
    datePicker.addEventListener('change', () => {
      const val = datePicker.value;
      if (val) {
        localStorage.setItem('pumplog:dashCustomDate', val);
        window.dispatchEvent(new CustomEvent('pumplog:dashRangeChange', { detail: { range: 'custom' } }));
      }
    });
  }
}

// ── Live feed ─────────────────────────────────────────────────────────
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
  shiftUnsub = watchShifts(stationId, { onUpdate: (rows, meta) => { if (!feedCtx || feedCtx.token !== token) return; rows.forEach(row => known.set(row.id, row)); latestRows = [...known.values()].sort(byNewest); paintFeed(meta); }, onError: err => { const el = document.getElementById('feed-updated'); if (el) el.textContent = 'Live updates paused — pull ↻ to refresh.'; } });
  sessionUnsub = watchPumpSessions(stationId, { onUpdate: (sessions, meta) => { if (!feedCtx || feedCtx.token !== token) return; latestSessions = sessions; paintFeed(meta); updateGreetingClock(); }, onError: () => {} });
}

function getSession(pumpId, sessions = latestSessions) { return sessions.find(s => s.id === pumpId && s.status === 'active') || null; }

function pumpStatus(pumpId, rows, sessions = latestSessions) {
  const today = getTodayDate(); let todayCount = 0, todayVol = 0, todaySales = 0, last = null;
  for (const shift of rows) { if (shift.pumpId !== pumpId) continue; if (!last) last = shift; if (shift.date === today) { todayCount += 1; todayVol += Number(shift.volume) || 0; todaySales += Number(shift.sales) || 0; } }
  const session = getSession(pumpId, sessions); let state = 'none';
  if (session) state = session.activeUid === getCurrentUserData()?.uid ? 'activeMine' : 'activeOther'; else if (last) state = 'stopped';
  return { state, session, todayCount, todayVol, todaySales, last };
}

const STATUS_META = { activeMine: { chip: 'Active — you', cls: 'active-mine', icon: '●' }, activeOther: { chip: 'In use', cls: 'active-other', icon: '🔒' }, stopped: { chip: 'Idle', cls: 'idle', icon: '○' }, none: { chip: 'Idle', cls: 'idle', icon: '○' } };

function shiftTime(createdAt, date) {
  const at = createdAt && typeof createdAt.toDate === 'function' ? createdAt.toDate() : null;
  if (!at) return date ? formatDate(date) : '';
  const minutes = Math.floor((Date.now() - at.getTime()) / 60000);
  if (minutes < 1) return 'just now'; if (minutes < 60) return `${minutes} min ago`; if (minutes < 1440) return `${Math.floor(minutes / 60)}h ago`; return formatDate(at);
}

function visibleActiveName(session) { return isStationOverseer() ? session?.activeName : ''; }

function pumpVisual(pump, status) {
  const level = Number(pump.tankLevel ?? pump.level ?? pump.tank?.level);
  const hasTank = Number.isFinite(level) && level >= 0 && level <= 100;
  const fill = hasTank ? `<span class="tank-gauge" title="Tank level ${level}%"><svg viewBox="0 0 28 40" role="img" aria-label="Tank level ${level}%"><rect x="3" y="2" width="22" height="36" rx="5" class="tank-outline"/><rect x="5" y="${38 - (level * .34)}" width="18" height="${level * .34}" rx="3" class="tank-fill"/></svg></span>` : '';
  const active = status.session ? 'active' : 'idle';
  return `<span class="pump-visual ${active}" aria-hidden="true"><svg viewBox="0 0 58 58"><rect x="16" y="18" width="22" height="28" rx="4" class="pump-body"/><path d="M21 18V11h12v7M38 23h6c4 0 6 3 6 6v10" class="pump-line"/><circle cx="27" cy="29" r="4" class="pump-light"/><path d="M44 39v7h-7" class="pump-nozzle"/>${status.session ? '<path d="M8 50c7-8 15-8 22 0s15 8 22 0" class="pump-flow"/>' : ''}</svg></span>${fill}`;
}

function feedListHTML(pumps, rows, sessions, stationId) {
  if (!pumps.length) return emptyState('⛽', 'No pumps to show. ' + (can('pump.create', { stationId }) ? 'Add them in Settings → Pumps.' : 'Ask your admin or manager to assign pumps to you.'));
  const items = pumps.map(pump => {
    const status = pumpStatus(pump.id, rows, sessions); const meta = STATUS_META[status.state]; const activeName = visibleActiveName(status.session);
    const liveLine = status.session ? `Started ${formatTimeAgo(status.session.clockInAt) || 'just now'}${activeName ? ` · ${activeName}` : ''}` : status.last ? `Last reading ${shiftTime(status.last.createdAt, status.last.date)}` : 'No readings logged yet';
    const readingLine = status.todayCount ? `${status.todayCount} reading${status.todayCount === 1 ? '' : 's'} today · ${formatVolume(status.todayVol)} · ${formatCurrency(status.todaySales)}` : liveLine;
    return `<li><button class="card-row feed-row pump-status-row" data-pump-id="${h(pump.id)}" aria-label="${h(pump.name)} — ${h(meta.chip)}. Open pump details">${pumpVisual(pump, status)}<span class="card-row-body"><span class="card-row-title">${h(pump.name)}</span><span class="card-row-meta">${h(pump.product || 'No product')} · ${h(readingLine)}</span></span><span class="feed-right"><span class="status-chip ${meta.cls}">${meta.icon} ${h(meta.chip)}</span>${status.last?.createdAt ? `<span class="feed-time">${h(formatTime(status.last.createdAt))}</span>` : ''}</span></button></li>`;
  }).join('');
  return `<ul class="plain-list feed-list">${items}</ul>`;
}

function paintFeed(meta = {}) {
  if (!feedCtx) return; const list = document.getElementById('feed-list'); if (!list) return;
  const activeCount = feedCtx.pumps.filter(p => getSession(p.id)).length; const summary = document.getElementById('feed-summary');
  if (summary) summary.textContent = feedCtx.pumps.length ? `${activeCount} of ${feedCtx.pumps.length} pump${feedCtx.pumps.length === 1 ? '' : 's'} currently active — tap a pump for details` : '';
  list.innerHTML = feedListHTML(feedCtx.pumps, latestRows, latestSessions, feedCtx.stationId);
  const updated = document.getElementById('feed-updated'); if (updated) { const time = new Date(meta.at || Date.now()); updated.textContent = `Updated ${time.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}${meta.fromCache ? ' · cached' : ''}`; }
}

function openPumpDetail(pumpId) {
  if (!feedCtx) return; const { stationId, pumps, rateMap } = feedCtx; const pump = pumps.find(p => p.id === pumpId); if (!pump) return;
  const status = pumpStatus(pumpId, latestRows, latestSessions); const meta = STATUS_META[status.state]; const recent = latestRows.filter(s => s.pumpId === pumpId).slice(0, 5);
  const mayLog = (isStationOverseer() && can('shift.create', { stationId }))
    || (!isStationOverseer() && can('shift.create', { stationId })
      && (canUsePump(pump.id) || status.session?.activeUid === getCurrentUserData()?.uid)
      && (!status.session || status.session.activeUid === getCurrentUserData()?.uid));
  const rate = rateMap[pump.product];
  const recentList = recent.length ? `<ul class="feed-detail-list">${recent.map(s => `<li><span class="shift-badge">S${h(s.shiftLabel || '?')}</span><span class="feed-detail-main"><strong>${formatVolume(s.volume)}</strong> · ${formatCurrency(s.sales)}<small>${h(formatDate(s.date))}${formatTime(s.createdAt) ? ` · ${h(formatTime(s.createdAt))}` : ''}${s.hoursWorked != null ? ` · ${h(Number(s.hoursWorked).toFixed(2))} h` : ''}</small></span></li>`).join('')}</ul>` : '<p class="muted-note">No readings recorded for this pump yet.</p>';
  const sessionLine = status.session ? `Started ${formatDateTime(status.session.clockInAt) || 'just now'}${visibleActiveName(status.session) ? ` by ${visibleActiveName(status.session)}` : ''}` : 'No active shift';
  document.getElementById('modal-title').textContent = pump.name;
  const action = status.session ? 'pumpSession.end' : 'pumpSession.start';
  const logButton = mayLog ? ifCan(action, {
    stationId, pumpId: pump.id, activeUid: status.session?.activeUid,
  }, `<button type="button" id="feed-log-btn" class="btn btn-primary btn-full mt-16">${status.session ? '⏹️ End shift' : '▶️ Start shift'}</button>`) : '';
  document.getElementById('modal-body').innerHTML = `<div class="feed-detail-head"><span class="status-chip ${meta.cls}">${meta.icon} ${h(meta.chip)}</span><span class="muted-note">${h(pump.product || 'No product')}${rate ? ` · ${formatCurrency(rate.rate)}/L` : ''}</span></div><p class="session-reference">${h(sessionLine)}</p><div class="feed-detail-today"><div><span class="label">Today</span><strong>${status.todayCount} reading${status.todayCount === 1 ? '' : 's'}</strong></div><div><span class="label">Volume</span><strong>${formatVolume(status.todayVol)}</strong></div><div><span class="label">Sales</span><strong>${formatCurrency(status.todaySales)}</strong></div></div><h4 class="feed-detail-subhead">Recent readings</h4>${recentList}${logButton}`;
  openModal('generic-modal');
  document.getElementById('feed-log-btn')?.addEventListener('click', () => { closeModal('generic-modal'); openShiftForm(stationId, pump, rate, status.session); });
}
