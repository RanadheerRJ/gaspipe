/* PumpLog — Team Board
 *
 * Touch-first daily board. One document per pump per day is kept at:
 *   stations/{stationId}/assignments/{YYYY-MM-DD}_{pumpId}
 *
 * Every station member sees the same flat list of pump rows. Managers and
 * admins get an “Add or remove staff” button; staff get the complete board
 * without edit controls. Changes use taps (not drag-and-drop), write in one
 * batch, and offer Undo.
 */

import {
  getDb, doc, writeBatch, serverTimestamp,
} from './firebase.js';
import {
  getCurrentUserData, isStationOverseer, can, ifCan, denyReason,
  formatFirebaseError, userDisplayName, setMyDailyPumps,
} from './auth.js';
import {
  getPumps, getUsersAtStation, getAssignments, getPumpSessions, getShifts,
  watchAssignments, watchPumpSessions, watchShifts, assignmentId, pumpIdsForUser,
  invalidateStation,
} from './store.js';
import {
  h, formatDate, getTodayDate, openModal, emptyState,
  toastAction, toastSuccess, toastError, confirmDialog, showSkeleton,
  formatCurrency, formatVolume,
} from './components.js';
import { avatarHTML } from './profile.js';

const DATE_KEY = 'pumplog:boardDate';
const ASSIGNMENT_FIELDS = [
  'date', 'pumpId', 'pumpName', 'product', 'staffUids', 'staffNames', 'note',
  'createdAt', 'createdBy', 'updatedAt', 'updatedBy',
];

let ctx = null;
let assignUnsub = null;
let sessionUnsub = null;
let shiftsUnsub = null;
let tickTimer = null;
let pickerPumpId = null;

export function initBoard() {}

export function stopBoardLive() {
  [assignUnsub, sessionUnsub, shiftsUnsub].forEach(unsub => {
    if (unsub) { try { unsub(); } catch { /* already closed */ } }
  });
  assignUnsub = null;
  sessionUnsub = null;
  shiftsUnsub = null;
  if (tickTimer) clearInterval(tickTimer);
  tickTimer = null;
  ctx = null;
  pickerPumpId = null;
}

// ── Day picker ──────────────────────────────────────────────────────────
export function getBoardDate() {
  return sessionStorage.getItem(DATE_KEY) || getTodayDate();
}

function setBoardDate(date) {
  if (date === getTodayDate()) sessionStorage.removeItem(DATE_KEY);
  else sessionStorage.setItem(DATE_KEY, date);
}

export function selectTodayOnBoard() {
  setBoardDate(getTodayDate());
}

function shiftDate(date, days) {
  const value = new Date(`${date}T12:00:00`);
  value.setDate(value.getDate() + days);
  const pad = number => String(number).padStart(2, '0');
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
}

// ── Board lookups ───────────────────────────────────────────────────────
const rowFor = pumpId => (ctx?.assignments || []).find(row => row.pumpId === pumpId) || null;
const uidsOn = pumpId => rowFor(pumpId)?.staffUids || [];
const sessionOn = pumpId =>
  (ctx?.sessions || []).find(session => session.id === pumpId && session.status === 'active') || null;
const pumpFor = pumpId => (ctx?.pumps || []).find(pump => pump.id === pumpId) || null;
const staffById = uid => (ctx?.staff || []).find(person => person.id === uid || person.uid === uid) || null;

function nameFor(uid, pumpId = '') {
  const person = staffById(uid);
  if (person) return userDisplayName(person);
  const stored = rowFor(pumpId)?.staffNames?.[uid];
  if (stored) return stored;
  const me = getCurrentUserData();
  if (me?.uid === uid) return userDisplayName(me);
  return 'Staff member';
}

function currentPumpFor(uid) {
  return (ctx?.assignments || []).find(row => (row.staffUids || []).includes(uid))?.pumpId || '';
}

function selectedDayText() {
  if (!ctx || ctx.date === getTodayDate()) return 'today';
  return `on ${formatDate(ctx.date) || ctx.date}`;
}

function elapsed(value) {
  const started = value?.toDate?.() || (value instanceof Date ? value : null);
  if (!started) return '';
  const minutes = Math.max(0, Math.floor((Date.now() - started.getTime()) / 60000));
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

// ── Today's per-pump sales totals ───────────────────────────────────────
function pumpTodayTotals(pumpId) {
  if (!ctx || ctx.date !== getTodayDate()) return { vol: 0, sales: 0, count: 0 };
  const today = ctx.date;
  let vol = 0, sales = 0, count = 0;
  for (const shift of ctx.shifts || []) {
    if (shift.pumpId !== pumpId) continue;
    if (shift.date !== today) continue;
    vol += Number(shift.volume) || 0;
    sales += Number(shift.sales) || 0;
    count += 1;
  }
  return { vol, sales, count };
}

// ── Pump rows (flat list) ───────────────────────────────────────────────
function pumpRowHTML(pump) {
  const uids = uidsOn(pump.id);
  const session = sessionOn(pump.id);
  const todayTotals = pumpTodayTotals(pump.id);
  const isToday = ctx.date === getTodayDate();

  let statusDotClass = 'board-dot board-dot-unassigned';
  let statusLabel = 'Unassigned';
  let statusExtra = '';
  if (session) {
    statusDotClass = 'board-dot board-dot-active';
    statusLabel = 'Active';
    const el = elapsed(session.clockInAt);
    statusExtra = el ? `${h(session.activeName || 'In use')} · ${h(el)}` : h(session.activeName || 'In use');
  } else if (uids.length) {
    statusDotClass = 'board-dot board-dot-idle';
    statusLabel = 'Idle';
    statusExtra = uids.map(uid => h(nameFor(uid, pump.id))).join(', ');
  }

  const names = uids.length
    ? uids.map(uid => {
        const person = staffById(uid);
        const name = nameFor(uid, pump.id);
        const live = sessionOn(pump.id);
        const working = live?.activeUid === uid;
        return `<span class="board-assignee ${working ? 'is-working' : ''}">${h(name)}${working ? ' <em>(now)</em>' : ''}</span>`;
      }).join('')
    : `<span class="board-assignee-empty">—</span>`;

  const elapsedCell = session
    ? h(elapsed(session.clockInAt) || 'just now')
    : '—';

  const totalsCell = isToday && todayTotals.count
    ? `<strong>${formatVolume(todayTotals.vol)}</strong><small>${formatCurrency(todayTotals.sales)}</small>`
    : isToday
      ? '<span class="muted">—</span>'
      : '<span class="muted">n/a</span>';

  const assignButton = ifCan('assignment.manage', { stationId: ctx.stationId }, `
    <button type="button" class="icon-btn board-row-assign" data-pump-id="${h(pump.id)}" aria-label="Assign staff to ${h(pump.name || 'pump')}">＋</button>`);

  return `<article class="board-row" aria-labelledby="board-pump-${h(pump.id)}">
    <div class="board-row-main">
      <span class="${statusDotClass}" aria-hidden="true"></span>
      <div class="board-row-pump">
        <h3 id="board-pump-${h(pump.id)}" class="board-row-name">${h(pump.name || 'Pump')}</h3>
        <p class="board-row-product">${h(pump.product || '')}</p>
      </div>
      <div class="board-row-assignees">
        ${names}
      </div>
      <div class="board-row-status">
        <span class="board-status-label">${statusLabel}</span>
        ${statusExtra ? `<small>${statusExtra}</small>` : ''}
      </div>
      <div class="board-row-elapsed">${elapsedCell}</div>
      <div class="board-row-totals">${totalsCell}</div>
      ${assignButton ? `<div class="board-row-actions">${assignButton}</div>` : ''}
    </div>
  </article>`;
}

function paintBoard() {
  const host = document.getElementById('board-cards');
  if (!ctx || !host) return;
  host.innerHTML = ctx.pumps.map(pumpRowHTML).join('');
  host.querySelectorAll('.board-row-assign').forEach(button =>
    button.addEventListener('click', () => openStaffPicker(button.dataset.pumpId)));
  paintSummary();
  publishMyDailyPumps();
}

function paintSummary() {
  const summary = document.getElementById('board-summary');
  if (!summary || !ctx) return;
  // Count only staff that still belong to this station's roster. When the
  // signed-in user cannot list station users (e.g. plain staff viewing the
  // board read-only) fall back to the set of UIDs visible from assignments
  // and active sessions so we never show "of 0".
  const staffList = ctx.staff || [];
  const validUids = new Set(staffList.map(p => p.id || p.uid));
  const allKnown = new Set(validUids);
  for (const row of ctx.assignments || []) {
    (row.staffUids || []).forEach(uid => allKnown.add(uid));
  }
  for (const session of ctx.sessions || []) {
    if (session.activeUid) allKnown.add(session.activeUid);
  }

  const peopleUids = new Set();
  let covered = 0;
  for (const pump of ctx.pumps) {
    const uids = (uidsOn(pump.id) || []).filter(uid => allKnown.has(uid));
    if (uids.length) covered += 1;
    uids.forEach(uid => peopleUids.add(uid));
  }
  const active = (ctx.sessions || []).filter(s => s.status === 'active').length;
  const knownCount = allKnown.size;
  const staffCount = staffList.length || knownCount;
  const staffPart = staffList.length
    ? `${peopleUids.size} of ${staffCount} staff rostered`
    : `${peopleUids.size} staff rostered`;
  summary.textContent = `${covered} of ${ctx.pumps.length} pumps covered · ${staffPart}${ctx.date === getTodayDate() ? ` · ${active} active now` : ''}`;
}

function publishMyDailyPumps() {
  const me = getCurrentUserData();
  if (!ctx || !me || ctx.date !== getTodayDate()) return;
  setMyDailyPumps(pumpIdsForUser(ctx.assignments, me.uid), ctx.date);
}

// ── Tap-first staff picker ──────────────────────────────────────────────
function pickerRowsHTML(pumpId) {
  if (!ctx?.staff.length) {
    return emptyState('👥', 'No staff are at this station yet. Add staff in Settings first.');
  }
  return `<div class="board-picker-list">${ctx.staff.map(person => {
    const uid = person.id || person.uid;
    const currentPumpId = currentPumpFor(uid);
    const onThisPump = currentPumpId === pumpId;
    const otherPump = currentPumpId ? pumpFor(currentPumpId) : null;
    const action = onThisPump
      ? '✓ On this pump · tap to remove'
      : otherPump
        ? `Move from ${otherPump.name}`
        : '+ Add to this pump';
    return `<button type="button" class="board-picker-person ${onThisPump ? 'is-selected' : ''}" data-picker-uid="${h(uid)}">
      ${avatarHTML(person, 'small')}
      <span><strong>${h(userDisplayName(person))}</strong><small>${h(action)}</small></span>
    </button>`;
  }).join('')}</div>`;
}

function paintPickerList() {
  const host = document.getElementById('board-picker-list');
  if (!host || !ctx || !pickerPumpId) return;
  host.innerHTML = pickerRowsHTML(pickerPumpId);
  host.querySelectorAll('[data-picker-uid]').forEach(button => {
    button.addEventListener('click', () => changePersonOnPump(button.dataset.pickerUid, pickerPumpId, button));
  });
}

function openStaffPicker(pumpId) {
  if (!ctx || !can('assignment.manage', { stationId: ctx.stationId })) {
    toastError(denyReason('assignment.manage', { stationId: ctx?.stationId }));
    return;
  }
  const pump = pumpFor(pumpId);
  if (!pump) return;
  pickerPumpId = pumpId;
  document.getElementById('modal-title').textContent = `Staff on ${pump.name}`;
  document.getElementById('modal-body').innerHTML = `
    <p class="modal-intro">Tap a name to add them ${h(selectedDayText())}. Tap a checked name to remove them. A person can be on one pump per day.</p>
    <p id="board-picker-error" class="form-error hidden" role="alert"></p>
    <div id="board-picker-list"></div>`;
  paintPickerList();
  openModal('generic-modal');
}

function cleanRow(row) {
  if (!row) return null;
  const clean = {};
  ASSIGNMENT_FIELDS.forEach(key => {
    if (row[key] !== undefined) clean[key] = row[key];
  });
  return clean;
}

function rowWithPerson(row, pump, uid, name, add) {
  const currentUids = [...(row?.staffUids || [])];
  const staffUids = add
    ? [...new Set([...currentUids, uid])]
    : currentUids.filter(value => value !== uid);
  const staffNames = { ...(row?.staffNames || {}) };
  if (add) staffNames[uid] = name;
  else delete staffNames[uid];
  const me = getCurrentUserData();
  return {
    date: ctx.date,
    pumpId: pump.id,
    pumpName: pump.name || 'Pump',
    product: pump.product || '',
    staffUids,
    staffNames,
    ...(row?.note ? { note: row.note } : {}),
    createdAt: row?.createdAt || serverTimestamp(),
    createdBy: row?.createdBy || me?.uid || 'unknown',
    updatedAt: serverTimestamp(),
    updatedBy: me?.uid || 'unknown',
  };
}

function queueRow(batch, pumpId, row) {
  const ref = doc(getDb(), 'stations', ctx.stationId, 'assignments', assignmentId(ctx.date, pumpId));
  if (!row || !row.staffUids?.length) batch.delete(ref);
  else batch.set(ref, row);
}

function replaceLocalRows(changes) {
  const changedIds = new Set(changes.keys());
  ctx.assignments = ctx.assignments.filter(row => !changedIds.has(row.pumpId));
  changes.forEach((row, pumpId) => {
    if (row?.staffUids?.length) ctx.assignments.push({ id: assignmentId(ctx.date, pumpId), ...row });
  });
  paintBoard();
  paintPickerList();
}

async function confirmLiveMove(uid, fromPumpId, toPumpId) {
  const live = (ctx.sessions || []).find(session => session.status === 'active' && session.activeUid === uid);
  if (!live || live.id !== fromPumpId) return true;
  const name = nameFor(uid, fromPumpId);
  const from = pumpFor(fromPumpId)?.name || 'this pump';
  const destination = toPumpId ? pumpFor(toPumpId)?.name || 'another pump' : 'today’s list';
  return confirmDialog({
    title: '⚠️ This person is working now',
    message: `${name} is using ${from}. This change only updates today’s staff list; it will not end their shift or unlock the pump. ${toPumpId ? `Move them to ${destination} anyway?` : 'Remove them anyway?'}`,
    confirmLabel: toPumpId ? 'Move staff' : 'Remove staff',
    danger: true,
  });
}

async function restoreRows(before) {
  if (!ctx || !can('assignment.manage', { stationId: ctx.stationId })) {
    const error = new Error(denyReason('assignment.manage', { stationId: ctx?.stationId }));
    error.userMessage = error.message;
    throw error;
  }
  try {
    const batch = writeBatch(getDb());
    before.forEach((row, pumpId) => queueRow(batch, pumpId, row));
    await batch.commit();
    invalidateStation(ctx.stationId);
    replaceLocalRows(before);
    toastSuccess('Change undone');
  } catch (err) {
    err.userMessage = formatFirebaseError(err);
    throw err;
  }
}

async function changePersonOnPump(uid, toPumpId, button) {
  if (!ctx || !uid || !can('assignment.manage', { stationId: ctx.stationId })) {
    toastError(denyReason('assignment.manage', { stationId: ctx?.stationId }));
    return;
  }

  const fromPumpId = currentPumpFor(uid);
  const removing = fromPumpId === toPumpId;
  if (fromPumpId && !(await confirmLiveMove(uid, fromPumpId, removing ? '' : toPumpId))) return;

  const name = nameFor(uid, fromPumpId || toPumpId);
  const changedIds = new Set([toPumpId]);
  if (fromPumpId && fromPumpId !== toPumpId) changedIds.add(fromPumpId);
  const before = new Map([...changedIds].map(pumpId => [pumpId, cleanRow(rowFor(pumpId))]));
  const after = new Map();

  if (fromPumpId && fromPumpId !== toPumpId) {
    after.set(fromPumpId, rowWithPerson(rowFor(fromPumpId), pumpFor(fromPumpId), uid, name, false));
  }
  after.set(toPumpId, rowWithPerson(rowFor(toPumpId), pumpFor(toPumpId), uid, name, !removing));

  button.disabled = true;
  button.setAttribute('aria-busy', 'true');
  try {
    const batch = writeBatch(getDb());
    after.forEach((row, pumpId) => queueRow(batch, pumpId, row));
    await batch.commit();
    invalidateStation(ctx.stationId);
    replaceLocalRows(after);

    const pumpName = pumpFor(toPumpId)?.name || 'this pump';
    const message = removing
      ? `Removed ${name} from ${pumpName}`
      : `Added ${name} to ${pumpName}`;
    toastAction(message, {
      label: 'Undo',
      onAction: () => restoreRows(before),
      type: 'success',
      timeout: 9000,
    });
  } catch (err) {
    const error = document.getElementById('board-picker-error');
    if (error) {
      error.textContent = `❌ ${formatFirebaseError(err)}`;
      error.classList.remove('hidden');
    } else {
      toastError(formatFirebaseError(err));
    }
    button.disabled = false;
    button.removeAttribute('aria-busy');
  }
}

// ── Render and live updates ─────────────────────────────────────────────
export async function renderBoard(stationId) {
  stopBoardLive();
  const content = document.getElementById('page-content');

  if (!stationId) {
    content.innerHTML = emptyState('⛽', 'Choose a station to see who is working on each pump.');
    return;
  }
  if (!can('assignment.view', { stationId })) {
    content.innerHTML = emptyState('🔒', 'This station is not assigned to you.');
    return;
  }

  showSkeleton(3);
  const date = getBoardDate();
  try {
    const mayManage = can('assignment.manage', { stationId });
    const isToday = date === getTodayDate();
    const [pumps, staff, assignments, sessions, shifts] = await Promise.all([
      getPumps(stationId),
      getUsersAtStation(stationId).catch(() => []),
      getAssignments(stationId, date),
      getPumpSessions(stationId),
      isToday ? getShifts(stationId, { from: date }).catch(() => []) : Promise.resolve([]),
    ]);
    ctx = { stationId, date, pumps, staff, assignments, sessions, shifts, mayManage };

    content.innerHTML = `${boardHeaderHTML(date)}
      ${pumps.length
        ? '<div id="board-cards" class="board-cards"></div>'
        : emptyState('⛽', mayManage
          ? 'No pumps are set up yet. Add a pump in Settings first.'
          : 'No pumps are set up yet. Ask your manager to add one.')}
      <p id="board-note" class="section-hint" role="status" aria-live="polite"></p>`;
    wireBoardHeader();
    if (pumps.length) {
      paintBoard();
      startBoardLive(stationId, date);
    }
  } catch (err) {
    content.innerHTML = emptyState('⚠️', `${formatFirebaseError(err)} Refresh the page to try again.`);
  }
}

function boardHeaderHTML(date) {
  const isToday = date === getTodayDate();
  return `<div class="page-head board-head">
    <div>
      <h2 class="page-title">Team Board</h2>
      <p class="section-hint">${ctx?.mayManage
        ? 'Tap “Add or remove staff” on a pump, then tap a name. Everyone sees changes right away.'
        : 'See who is working on every pump. Your manager makes any changes.'}</p>
    </div>
    <span class="live-badge" role="status"><span class="live-dot" aria-hidden="true"></span>Live</span>
  </div>
  <div class="board-toolbar">
    <button type="button" class="btn btn-secondary board-day-button" id="board-prev">‹ Previous day</button>
    <div class="board-date-field">
      <label for="board-date">Day</label>
      <input type="date" id="board-date" class="dash-date-input" value="${h(date)}" />
    </div>
    <button type="button" class="btn btn-secondary board-day-button" id="board-next">Next day ›</button>
    ${isToday ? '<span class="tag tag-on">Today</span>'
      : '<button type="button" class="btn btn-primary" id="board-today">Go to today</button>'}
  </div>
  <p class="feed-summary" id="board-summary"></p>`;
}

function wireBoardHeader() {
  const input = document.getElementById('board-date');
  const go = date => {
    if (!date) return;
    const stationId = ctx?.stationId || null;
    setBoardDate(date);
    renderBoard(stationId);
  };
  input?.addEventListener('change', () => go(input.value));
  document.getElementById('board-prev')?.addEventListener('click', () => go(shiftDate(input.value, -1)));
  document.getElementById('board-next')?.addEventListener('click', () => go(shiftDate(input.value, 1)));
  document.getElementById('board-today')?.addEventListener('click', () => go(getTodayDate()));
}

function startBoardLive(stationId, date) {
  assignUnsub = watchAssignments(stationId, date, {
    onUpdate: rows => {
      if (!ctx || ctx.stationId !== stationId || ctx.date !== date) return;
      ctx.assignments = rows;
      paintBoard();
      paintPickerList();
    },
    onError: () => {
      const note = document.getElementById('board-note');
      if (note) note.textContent = 'Live updates paused. Tap Refresh to reconnect.';
    },
  });
  sessionUnsub = watchPumpSessions(stationId, {
    onUpdate: rows => {
      if (!ctx || ctx.stationId !== stationId) return;
      ctx.sessions = rows;
      paintBoard();
    },
    onError: () => {
      const note = document.getElementById('board-note');
      if (note) note.textContent = 'Pump status could not update. Tap Refresh to reconnect.';
    },
  });
  if (date === getTodayDate()) {
    shiftsUnsub = watchShifts(stationId, {
      onUpdate: rows => {
        if (!ctx || ctx.stationId !== stationId) return;
        ctx.shifts = rows.filter(r => r.date === date);
        paintBoard();
      },
      onError: () => {
        const note = document.getElementById('board-note');
        if (note) note.textContent = 'Shift totals paused. Tap Refresh to reconnect.';
      },
    });
  }
  tickTimer = window.setInterval(() => { if (ctx) paintBoard(); }, 60_000);
}

/**
 * Publish today's pump list before the Pumps page first renders. This keeps
 * Start shift available for staff who were added on the daily board.
 */
export async function primeMyDailyPumps(stationId) {
  const me = getCurrentUserData();
  if (!stationId || !me || isStationOverseer()) return;
  try {
    const date = getTodayDate();
    const rows = await getAssignments(stationId, date);
    setMyDailyPumps(pumpIdsForUser(rows, me.uid), date);
  } catch {
    setMyDailyPumps([], null);
  }
}
