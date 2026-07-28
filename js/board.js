/* PumpLog — Daily pump roster board (Kanban / Trello style)
 *
 * One column per pump, plus an "Available" column holding everyone who is
 * on shift at the station but not yet placed. Managers and admins move staff
 * cards between columns to build the day's roster; staff see the same board
 * read-only so they know where they are working.
 *
 * Storage: one document per pump per day —
 *   stations/{stationId}/assignments/{YYYY-MM-DD}_{pumpId}
 *     { date, pumpId, pumpName, product, staffUids[], staffNames{}, ... }
 *
 * The board is a roster, not a lock. Whether a pump is *currently* occupied
 * is still owned by stations/{id}/pumpSessions/{pumpId}, and the clock-in
 * transaction remains the only thing that can claim one. The board decides
 * who is *allowed* to clock in today; the session decides who actually has it.
 *
 * Both layers are live: pumpSessions and assignments each have a snapshot
 * listener, so a card moved on the manager's phone appears on the staff
 * member's device without a refresh.
 */

import {
  getDb, doc, setDoc, deleteDoc, writeBatch, serverTimestamp,
} from './firebase.js';
import {
  getCurrentUserData, isStationOverseer, can, denyReason,
  formatFirebaseError, userDisplayName, setMyDailyPumps,
} from './auth.js';
import {
  getPumps, getStaffForStation, getAssignments, getPumpSessions, getShifts,
  watchAssignments, watchPumpSessions, assignmentId, pumpIdsForUser,
  getCurrentRateMap, invalidateStation,
} from './store.js';
import {
  h, formatCurrency, formatVolume, formatTimeAgo, formatDateTime, getTodayDate,
  openModal, closeModal, emptyState, toastSuccess, toastError, toast,
  confirmDialog, setBusy, showSkeleton, timestampToDate,
} from './components.js';
import { avatarHTML } from './profile.js';

const DATE_KEY = 'pumplog:boardDate';

let ctx = null;              // { stationId, date, pumps, staff, ... }
let assignUnsub = null;
let sessionUnsub = null;
let tickTimer = null;
let picked = null;           // uid "held" for tap-to-move on touch devices

export function initBoard() {}

export function stopBoardLive() {
  [assignUnsub, sessionUnsub].forEach(unsub => {
    if (unsub) { try { unsub(); } catch { /* already closed */ } }
  });
  assignUnsub = null;
  sessionUnsub = null;
  if (tickTimer) clearInterval(tickTimer);
  tickTimer = null;
  ctx = null;
  picked = null;
}

// ── Board date ──────────────────────────────────────────────────────────
export function getBoardDate() {
  const saved = sessionStorage.getItem(DATE_KEY);
  return saved || getTodayDate();
}

function setBoardDate(date) {
  if (date === getTodayDate()) sessionStorage.removeItem(DATE_KEY);
  else sessionStorage.setItem(DATE_KEY, date);
}

// ── Lookups ─────────────────────────────────────────────────────────────
const rowFor = (pumpId) => (ctx?.assignments || []).find(a => a.pumpId === pumpId) || null;
const uidsOn = (pumpId) => rowFor(pumpId)?.staffUids || [];
const sessionOn = (pumpId) =>
  (ctx?.sessions || []).find(s => s.id === pumpId && s.status === 'active') || null;

function staffById(uid) {
  return (ctx?.staff || []).find(user => user.id === uid) || null;
}

/** Everyone not placed on any pump for this date. */
function benchUids() {
  const placed = new Set((ctx?.assignments || []).flatMap(a => a.staffUids || []));
  return (ctx?.staff || []).map(u => u.id).filter(uid => !placed.has(uid));
}

/**
 * What a rostered person is doing right now.
 *   working  — holds the live session on this pump
 *   elsewhere— clocked in, but on a different pump
 *   done     — closed at least one shift on this pump today
 *   waiting  — rostered, not started
 */
function staffState(uid, pumpId) {
  const here = sessionOn(pumpId);
  if (here && here.activeUid === uid) {
    return { key: 'working', label: 'On shift', icon: '🟢', since: here.clockInAt };
  }
  const other = (ctx?.sessions || []).find(s => s.status === 'active' && s.activeUid === uid);
  if (other) {
    const pump = ctx.pumps.find(p => p.id === other.id);
    return { key: 'elsewhere', label: `On ${pump?.name || 'another pump'}`, icon: '🟡', since: other.clockInAt };
  }
  const done = (ctx?.shifts || []).filter(s => s.pumpId === pumpId
    && (s.staffUid || s.staffId || s.createdBy) === uid);
  if (done.length) {
    const volume = done.reduce((sum, s) => sum + (Number(s.volume) || 0), 0);
    const sales = done.reduce((sum, s) => sum + (Number(s.sales) || 0), 0);
    return { key: 'done', label: 'Shift ended', icon: '✅', volume, sales, count: done.length };
  }
  return { key: 'waiting', label: 'Not started', icon: '⚪' };
}

function elapsedLabel(value) {
  const date = timestampToDate(value);
  if (!date) return '';
  const mins = Math.max(0, Math.round((Date.now() - date.getTime()) / 60000));
  const hours = Math.floor(mins / 60);
  return hours ? `${hours}h ${mins % 60}m` : `${mins}m`;
}

// ── Card + column markup ────────────────────────────────────────────────
function staffCardHTML(uid, pumpId) {
  const user = staffById(uid);
  const name = user ? userDisplayName(user) : (rowFor(pumpId)?.staffNames?.[uid] || 'Staff member');
  const state = pumpId ? staffState(uid, pumpId) : bencherState(uid);
  const mayMove = ctx.mayManage;

  let detail = state.label;
  if (state.key === 'working') detail = `On shift · ${elapsedLabel(state.since)}`;
  if (state.key === 'done') {
    detail = `${state.label} · ${formatVolume(state.volume)} · ${formatCurrency(state.sales)}`;
  }

  const login = user?.lastLogin ? `Signed in ${formatTimeAgo(user.lastLogin)}` : 'No sign-in yet';

  return `<li class="board-card state-${state.key} ${picked === uid ? 'is-picked' : ''}"
      data-uid="${h(uid)}" data-from="${h(pumpId || '')}"
      ${mayMove ? 'draggable="true"' : ''}
      tabindex="0" role="button"
      aria-label="${h(name)} — ${h(detail)}${mayMove ? '. Activate to move.' : ''}">
    ${avatarHTML(user || { fullName: name }, 'small')}
    <span class="board-card-body">
      <span class="board-card-name">${h(name)}</span>
      <span class="board-card-meta">${h(state.icon)} ${h(detail)}</span>
      <span class="board-card-sub">${h(login)}</span>
    </span>
    ${mayMove ? '<span class="board-card-grip" aria-hidden="true">⠿</span>' : ''}
  </li>`;
}

/** State for someone sitting on the bench (not rostered anywhere). */
function bencherState(uid) {
  const active = (ctx?.sessions || []).find(s => s.status === 'active' && s.activeUid === uid);
  if (active) {
    const pump = ctx.pumps.find(p => p.id === active.id);
    return { key: 'elsewhere', label: `On ${pump?.name || 'a pump'} (unrostered)`, icon: '🟡', since: active.clockInAt };
  }
  const done = (ctx?.shifts || []).filter(s => (s.staffUid || s.staffId || s.createdBy) === uid);
  if (done.length) {
    return {
      key: 'done',
      label: `${done.length} shift${done.length === 1 ? '' : 's'} today`,
      icon: '✅',
      volume: done.reduce((sum, s) => sum + (Number(s.volume) || 0), 0),
      sales: done.reduce((sum, s) => sum + (Number(s.sales) || 0), 0),
      count: done.length,
    };
  }
  return { key: 'waiting', label: 'Available', icon: '⚪' };
}

function pumpColumnHTML(pump) {
  const uids = uidsOn(pump.id);
  const session = sessionOn(pump.id);
  const rate = ctx.rateMap?.[pump.product];
  const shiftsHere = (ctx.shifts || []).filter(s => s.pumpId === pump.id);
  const volume = shiftsHere.reduce((sum, s) => sum + (Number(s.volume) || 0), 0);
  const sales = shiftsHere.reduce((sum, s) => sum + (Number(s.sales) || 0), 0);

  const status = session
    ? `<span class="status-chip mine">● ${h(session.activeName || 'In use')} · ${h(elapsedLabel(session.clockInAt))}</span>`
    : '<span class="status-chip idle">○ Idle</span>';

  const cards = uids.length
    ? `<ul class="board-card-list">${uids.map(uid => staffCardHTML(uid, pump.id)).join('')}</ul>`
    : `<p class="board-empty">${ctx.mayManage ? 'Drop a staff card here' : 'Nobody rostered'}</p>`;

  return `<section class="board-column" data-pump-id="${h(pump.id)}" aria-label="${h(pump.name)} roster">
    <header class="board-column-head">
      <div class="board-column-title">
        <span class="board-column-icon" aria-hidden="true">⛽</span>
        <div>
          <h3>${h(pump.name)}</h3>
          <p>${h(pump.product || 'No product')}${rate ? ` · ${h(formatCurrency(rate.rate))}/L` : ''}</p>
        </div>
        <span class="board-count" title="${uids.length} rostered">${uids.length}</span>
      </div>
      ${status}
    </header>
    <div class="board-dropzone" data-drop="${h(pump.id)}">
      ${cards}
    </div>
    <footer class="board-column-foot">
      <span>${shiftsHere.length} shift${shiftsHere.length === 1 ? '' : 's'} · ${formatVolume(volume)} · ${formatCurrency(sales)}</span>
      ${ctx.mayManage ? `<button type="button" class="btn btn-secondary btn-small board-add" data-pump-id="${h(pump.id)}">➕ Assign</button>` : ''}
    </footer>
  </section>`;
}

function benchColumnHTML() {
  const uids = benchUids();
  const cards = uids.length
    ? `<ul class="board-card-list">${uids.map(uid => staffCardHTML(uid, '')).join('')}</ul>`
    : '<p class="board-empty">Everyone is rostered 🎉</p>';

  return `<section class="board-column board-column-bench" data-pump-id="" aria-label="Available staff">
    <header class="board-column-head">
      <div class="board-column-title">
        <span class="board-column-icon" aria-hidden="true">👥</span>
        <div>
          <h3>Available</h3>
          <p>Not on a pump yet</p>
        </div>
        <span class="board-count">${uids.length}</span>
      </div>
    </header>
    <div class="board-dropzone" data-drop="">
      ${cards}
    </div>
    <footer class="board-column-foot">
      <span>${ctx.staff.length} staff at this station</span>
    </footer>
  </section>`;
}

// ── Painting ────────────────────────────────────────────────────────────
function paintBoard() {
  const host = document.getElementById('board-columns');
  if (!ctx || !host) return;

  host.innerHTML = `${benchColumnHTML()}${ctx.pumps.map(pumpColumnHTML).join('')}`;
  wireBoardInteractions();
  paintSummary();
  publishMyDailyPumps();
}

function paintSummary() {
  const el = document.getElementById('board-summary');
  if (!el || !ctx) return;
  const rostered = new Set((ctx.assignments || []).flatMap(a => a.staffUids || [])).size;
  const active = (ctx.sessions || []).filter(s => s.status === 'active').length;
  const covered = ctx.pumps.filter(p => uidsOn(p.id).length).length;
  el.textContent = `${rostered} of ${ctx.staff.length} staff rostered · ${covered} of ${ctx.pumps.length} pumps covered · ${active} running now`;
}

/**
 * Tell the RBAC layer which pumps today's board grants the signed-in user,
 * so Start shift stops being blocked the moment a manager rosters them.
 */
function publishMyDailyPumps() {
  if (!ctx) return;
  const me = getCurrentUserData();
  if (!me) return;
  if (ctx.date !== getTodayDate()) return;   // only today's board grants access
  setMyDailyPumps(pumpIdsForUser(ctx.assignments, me.uid), ctx.date);
}

// ── Interactions ────────────────────────────────────────────────────────
function wireBoardInteractions() {
  const host = document.getElementById('board-columns');
  if (!host) return;

  host.querySelectorAll('.board-card').forEach(card => {
    card.addEventListener('click', () => onCardActivate(card));
    card.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onCardActivate(card); }
    });

    if (!ctx.mayManage) return;
    card.addEventListener('dragstart', e => {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', JSON.stringify({
        uid: card.dataset.uid, from: card.dataset.from,
      }));
      card.classList.add('is-dragging');
    });
    card.addEventListener('dragend', () => card.classList.remove('is-dragging'));
  });

  if (!ctx.mayManage) return;

  host.querySelectorAll('.board-dropzone').forEach(zone => {
    zone.addEventListener('dragover', e => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      zone.classList.add('is-over');
    });
    zone.addEventListener('dragleave', () => zone.classList.remove('is-over'));
    zone.addEventListener('drop', async e => {
      e.preventDefault();
      zone.classList.remove('is-over');
      let payload;
      try { payload = JSON.parse(e.dataTransfer.getData('text/plain')); } catch { return; }
      await moveStaff(payload.uid, payload.from || '', zone.dataset.drop || '');
    });
    // Tap-to-move: with a card "picked up", tapping a column drops it there.
    zone.addEventListener('click', async () => {
      if (!picked) return;
      const from = findCurrentPump(picked);
      const uid = picked;
      picked = null;
      await moveStaff(uid, from, zone.dataset.drop || '');
    });
  });

  host.querySelectorAll('.board-add').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      openAssignPicker(btn.dataset.pumpId);
    });
  });
}

function findCurrentPump(uid) {
  const row = (ctx.assignments || []).find(a => (a.staffUids || []).includes(uid));
  return row ? row.pumpId : '';
}

function onCardActivate(card) {
  const uid = card.dataset.uid;
  if (!ctx.mayManage) { openStaffDetail(uid); return; }
  // Toggle "picked up" state — the next column tap moves them.
  if (picked === uid) {
    picked = null;
    paintBoard();
    return;
  }
  picked = uid;
  paintBoard();
  const user = staffById(uid);
  toast(`${userDisplayName(user) || 'Staff'} picked up — tap a pump column to move, or tap the card again to cancel.`, 'info', 3500);
}

function openStaffDetail(uid) {
  const user = staffById(uid);
  if (!user) return;
  const pumpId = findCurrentPump(uid);
  const pump = ctx.pumps.find(p => p.id === pumpId);
  const state = pumpId ? staffState(uid, pumpId) : bencherState(uid);
  document.getElementById('modal-title').textContent = userDisplayName(user);
  document.getElementById('modal-body').innerHTML = `
    <div class="board-detail-head">${avatarHTML(user, 'medium')}
      <div><strong>${h(userDisplayName(user))}</strong>
      <small>${h(user.email || user.username || '')}</small></div></div>
    <dl class="profile-settings-list">
      <dt>Rostered to</dt><dd>${h(pump?.name || 'Not rostered today')}</dd>
      <dt>Status</dt><dd>${h(state.icon)} ${h(state.label)}</dd>
      <dt>Last sign-in</dt><dd>${h(user.lastLogin ? formatDateTime(user.lastLogin) : 'Never')}</dd>
    </dl>`;
  openModal('generic-modal');
}

// ── Writes ──────────────────────────────────────────────────────────────
async function moveStaff(uid, fromPumpId, toPumpId) {
  if (!ctx || !uid || fromPumpId === toPumpId) { paintBoard(); return; }
  if (!can('assignment.manage', { stationId: ctx.stationId })) {
    toastError(denyReason('assignment.manage'));
    return;
  }

  // A staff member holding a live session should not be quietly moved off it.
  const live = (ctx.sessions || []).find(s => s.status === 'active' && s.activeUid === uid);
  if (live && live.id === fromPumpId) {
    const pump = ctx.pumps.find(p => p.id === fromPumpId);
    const user = staffById(uid);
    const ok = await confirmDialog({
      title: '⚠️ Staff member is on shift',
      message: `${userDisplayName(user)} is clocked in on ${pump?.name || 'this pump'} right now. Moving the roster card does not end that shift — the pump stays locked until they clock out or a manager ends it. Move them anyway?`,
      confirmLabel: 'Move anyway',
      danger: true,
    });
    if (!ok) { paintBoard(); return; }
  }

  const user = staffById(uid);
  const name = user ? userDisplayName(user) : 'Staff member';

  try {
    await writeAssignment(fromPumpId, uids => uids.filter(id => id !== uid));
    await writeAssignment(toPumpId, uids => [...new Set([...uids, uid])], { uid, name });
    invalidateStation(ctx.stationId);
    const target = ctx.pumps.find(p => p.id === toPumpId);
    toastSuccess(toPumpId ? `${name} → ${target?.name || 'pump'}` : `${name} moved to Available`);
    await reloadAssignments();
  } catch (err) {
    toastError(formatFirebaseError(err));
    await reloadAssignments();
  }
}

/**
 * Rewrite one pump's roster document for the board's date.
 * `mutate` receives the current uid list and returns the next one.
 */
async function writeAssignment(pumpId, mutate, addName = null) {
  if (!pumpId) return;                   // the bench is "absence of a doc"
  const pump = ctx.pumps.find(p => p.id === pumpId);
  if (!pump) return;

  const row = rowFor(pumpId);
  const nextUids = mutate([...(row?.staffUids || [])]);
  const names = { ...(row?.staffNames || {}) };
  if (addName) names[addName.uid] = addName.name;
  for (const key of Object.keys(names)) {
    if (!nextUids.includes(key)) delete names[key];
  }

  const ref = doc(getDb(), 'stations', ctx.stationId, 'assignments', assignmentId(ctx.date, pumpId));
  const me = getCurrentUserData();

  if (nextUids.length === 0) {
    await deleteDoc(ref).catch(async (err) => {
      if (err?.code !== 'not-found') throw err;
    });
    return;
  }

  await setDoc(ref, {
    date: ctx.date,
    pumpId,
    pumpName: pump.name || 'Pump',
    product: pump.product || '',
    staffUids: nextUids,
    staffNames: names,
    updatedAt: serverTimestamp(),
    updatedBy: me?.uid || 'unknown',
    ...(row ? {} : { createdAt: serverTimestamp(), createdBy: me?.uid || 'unknown' }),
  }, { merge: true });
}

async function reloadAssignments() {
  if (!ctx) return;
  invalidateStation(ctx.stationId);
  ctx.assignments = await getAssignments(ctx.stationId, ctx.date).catch(() => ctx.assignments);
  paintBoard();
}

// ── Assign picker (accessible alternative to dragging) ──────────────────
function openAssignPicker(pumpId) {
  const pump = ctx.pumps.find(p => p.id === pumpId);
  if (!pump) return;
  const current = new Set(uidsOn(pumpId));

  const rows = ctx.staff.map(user => {
    const elsewhere = findCurrentPump(user.id);
    const busy = elsewhere && elsewhere !== pumpId
      ? ` <span class="muted-note">on ${h(ctx.pumps.find(p => p.id === elsewhere)?.name || 'another pump')}</span>`
      : '';
    return `<div class="checkbox-item">
      <input type="checkbox" id="roster-${h(user.id)}" value="${h(user.id)}" ${current.has(user.id) ? 'checked' : ''} />
      <label for="roster-${h(user.id)}">${h(userDisplayName(user))}${busy}</label>
    </div>`;
  }).join('');

  document.getElementById('modal-title').textContent = `Assign — ${pump.name}`;
  document.getElementById('modal-body').innerHTML = `<form id="roster-form" novalidate>
    <p class="modal-intro">Who works ${h(pump.name)} on ${h(ctx.date)}? Ticking someone already on another pump moves them here.</p>
    ${ctx.staff.length ? `<div class="checkbox-list">${rows}</div>`
      : '<p class="muted-note">No staff are assigned to this station yet. Add them from Config → Team.</p>'}
    <p id="roster-error" class="form-error hidden" role="alert"></p>
    <button type="submit" class="btn btn-primary btn-full mt-16" ${ctx.staff.length ? '' : 'disabled'}>Save roster</button>
  </form>`;
  openModal('generic-modal');

  document.getElementById('roster-form').addEventListener('submit', async e => {
    e.preventDefault();
    const button = e.currentTarget.querySelector('button[type="submit"]');
    const error = document.getElementById('roster-error');
    const selected = Array.from(e.currentTarget.querySelectorAll('input:checked')).map(i => i.value);
    setBusy(button, true, 'Saving…');
    try {
      // Someone ticked here must leave whatever pump they were on.
      for (const uid of selected) {
        const from = findCurrentPump(uid);
        if (from && from !== pumpId) {
          await writeAssignment(from, uids => uids.filter(id => id !== uid));
        }
      }
      const names = {};
      for (const uid of selected) {
        const user = staffById(uid);
        names[uid] = user ? userDisplayName(user) : 'Staff member';
      }
      await writeAssignmentExact(pumpId, selected, names);
      invalidateStation(ctx.stationId);
      closeModal('generic-modal');
      toastSuccess(`Roster saved — ${pump.name}`);
      await reloadAssignments();
    } catch (err) {
      error.textContent = `❌ ${formatFirebaseError(err)}`;
      error.classList.remove('hidden');
      setBusy(button, false);
    }
  });
}

async function writeAssignmentExact(pumpId, uids, names) {
  const pump = ctx.pumps.find(p => p.id === pumpId);
  const ref = doc(getDb(), 'stations', ctx.stationId, 'assignments', assignmentId(ctx.date, pumpId));
  const me = getCurrentUserData();
  if (!uids.length) {
    await deleteDoc(ref).catch(err => { if (err?.code !== 'not-found') throw err; });
    return;
  }
  await setDoc(ref, {
    date: ctx.date,
    pumpId,
    pumpName: pump?.name || 'Pump',
    product: pump?.product || '',
    staffUids: uids,
    staffNames: names,
    createdAt: serverTimestamp(),
    createdBy: me?.uid || 'unknown',
    updatedAt: serverTimestamp(),
    updatedBy: me?.uid || 'unknown',
  }, { merge: true });
}

// ── Bulk helpers ────────────────────────────────────────────────────────
async function copyPreviousDay() {
  if (!ctx || !can('assignment.manage', { stationId: ctx.stationId })) return;
  const previous = getTodayDate(-1) === ctx.date ? getTodayDate(-2) : shiftDate(ctx.date, -1);
  const rows = await getAssignments(ctx.stationId, previous).catch(() => []);
  if (!rows.length) { toast(`No roster found for ${previous}.`, 'info'); return; }

  const ok = await confirmDialog({
    title: 'Copy previous roster',
    message: `Copy the roster from ${previous} onto ${ctx.date}? This replaces the current board for this date.`,
    confirmLabel: 'Copy roster',
  });
  if (!ok) return;

  try {
    const batch = writeBatch(getDb());
    const me = getCurrentUserData();
    // Clear the day first so removals on the source day carry over.
    for (const row of ctx.assignments) {
      batch.delete(doc(getDb(), 'stations', ctx.stationId, 'assignments', assignmentId(ctx.date, row.pumpId)));
    }
    for (const row of rows) {
      if (!(row.staffUids || []).length) continue;
      batch.set(doc(getDb(), 'stations', ctx.stationId, 'assignments', assignmentId(ctx.date, row.pumpId)), {
        date: ctx.date,
        pumpId: row.pumpId,
        pumpName: row.pumpName || '',
        product: row.product || '',
        staffUids: row.staffUids,
        staffNames: row.staffNames || {},
        createdAt: serverTimestamp(),
        createdBy: me?.uid || 'unknown',
        updatedAt: serverTimestamp(),
        updatedBy: me?.uid || 'unknown',
      });
    }
    await batch.commit();
    toastSuccess(`Roster copied from ${previous}`);
    await reloadAssignments();
  } catch (err) {
    toastError(formatFirebaseError(err));
  }
}

async function clearBoard() {
  if (!ctx || !can('assignment.manage', { stationId: ctx.stationId })) return;
  if (!ctx.assignments.length) { toast('The board is already empty.', 'info'); return; }
  const ok = await confirmDialog({
    title: '⚠️ Clear the board',
    message: `Remove every roster card for ${ctx.date}? Shifts already recorded are not affected, and live pump locks stay as they are.`,
    confirmLabel: 'Clear board',
    danger: true,
  });
  if (!ok) return;
  try {
    const batch = writeBatch(getDb());
    for (const row of ctx.assignments) {
      batch.delete(doc(getDb(), 'stations', ctx.stationId, 'assignments', assignmentId(ctx.date, row.pumpId)));
    }
    await batch.commit();
    toastSuccess('Board cleared');
    await reloadAssignments();
  } catch (err) {
    toastError(formatFirebaseError(err));
  }
}

function shiftDate(date, days) {
  const d = new Date(`${date}T12:00:00`);
  d.setDate(d.getDate() + days);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// ── Render ──────────────────────────────────────────────────────────────
export async function renderBoard(stationId) {
  stopBoardLive();
  const content = document.getElementById('page-content');

  if (!stationId) {
    content.innerHTML = emptyState('🗂️', 'Select a station to see its roster board.');
    return;
  }

  showSkeleton(3);
  const date = getBoardDate();

  try {
    const mayManage = can('assignment.manage', { stationId });
    const [pumps, staff, assignments, sessions, shifts, rateMap] = await Promise.all([
      getPumps(stationId),
      getStaffForStation(stationId).catch(() => []),
      getAssignments(stationId, date).catch(() => []),
      getPumpSessions(stationId),
      getShifts(stationId, { from: date }).catch(() => []),
      getCurrentRateMap(stationId).catch(() => ({})),
    ]);

    ctx = {
      stationId, date, pumps, staff, assignments, sessions,
      shifts: shifts.filter(s => s.date === date),
      rateMap, mayManage,
    };

    if (pumps.length === 0) {
      content.innerHTML = `${boardHeaderHTML(date, mayManage)}${emptyState('⛽', can('pump.create', { stationId })
        ? 'No pumps yet. Add them from Config → Pumps, then come back to build the roster.'
        : 'No pumps configured yet. Ask your manager to add them.')}`;
      wireBoardHeader();
      return;
    }

    content.innerHTML = `${boardHeaderHTML(date, mayManage)}
      <div id="board-columns" class="board-columns"></div>
      <p id="board-note" class="section-hint" aria-live="polite"></p>`;

    paintBoard();
    wireBoardHeader();
    startBoardLive(stationId, date);
  } catch (err) {
    content.innerHTML = emptyState('⚠️', formatFirebaseError(err));
  }
}

function boardHeaderHTML(date, mayManage) {
  const isToday = date === getTodayDate();
  const hint = mayManage
    ? 'Drag a staff card onto a pump — or tap the card, then tap a column. Changes are live on every device.'
    : 'Your station roster for the day. Cards show who is on which pump and what they are doing right now.';

  return `<div class="page-head board-head">
      <div>
        <h2 class="page-title">Roster board</h2>
        <p class="section-hint">${h(hint)}</p>
      </div>
      <span class="live-badge" role="status"><span class="live-dot" aria-hidden="true"></span>LIVE</span>
    </div>
    <div class="board-toolbar">
      <div class="board-date-group">
        <button type="button" class="icon-btn" id="board-prev" aria-label="Previous day" title="Previous day">‹</button>
        <input type="date" id="board-date" class="dash-date-input" value="${h(date)}" aria-label="Roster date" />
        <button type="button" class="icon-btn" id="board-next" aria-label="Next day" title="Next day">›</button>
        ${isToday ? '<span class="tag tag-on">Today</span>'
          : '<button type="button" class="btn btn-secondary btn-small" id="board-today">Jump to today</button>'}
      </div>
      ${mayManage ? `<div class="board-actions">
        <button type="button" class="btn btn-secondary btn-small" id="board-copy">⧉ Copy previous day</button>
        <button type="button" class="btn btn-secondary btn-small" id="board-clear">🧹 Clear</button>
      </div>` : ''}
    </div>
    <p class="feed-summary" id="board-summary"></p>`;
}

function wireBoardHeader() {
  const input = document.getElementById('board-date');
  const go = (date) => { setBoardDate(date); renderBoard(ctx?.stationId || null); };

  input?.addEventListener('change', () => { if (input.value) go(input.value); });
  document.getElementById('board-prev')?.addEventListener('click', () => go(shiftDate(input.value, -1)));
  document.getElementById('board-next')?.addEventListener('click', () => go(shiftDate(input.value, 1)));
  document.getElementById('board-today')?.addEventListener('click', () => go(getTodayDate()));
  document.getElementById('board-copy')?.addEventListener('click', copyPreviousDay);
  document.getElementById('board-clear')?.addEventListener('click', clearBoard);
}

function startBoardLive(stationId, date) {
  assignUnsub = watchAssignments(stationId, date, {
    onUpdate: rows => {
      if (!ctx || ctx.stationId !== stationId || ctx.date !== date) return;
      ctx.assignments = rows;
      paintBoard();
    },
    onError: () => {
      const note = document.getElementById('board-note');
      if (note) note.textContent = 'Live roster updates paused — use Refresh to re-sync.';
    },
  });

  sessionUnsub = watchPumpSessions(stationId, {
    onUpdate: rows => {
      if (!ctx || ctx.stationId !== stationId) return;
      ctx.sessions = rows;
      paintBoard();
    },
    onError: () => {},
  });

  // Keep the "on shift for 42m" counters honest without a re-query.
  tickTimer = window.setInterval(() => { if (ctx) paintBoard(); }, 60_000);
}

/**
 * Load today's roster for the signed-in user and publish it to the RBAC
 * layer. Called at sign-in so Start shift works on the Pumps page without
 * the user having to open the board first.
 */
export async function primeMyDailyPumps(stationId) {
  const me = getCurrentUserData();
  if (!stationId || !me) return;
  if (isStationOverseer()) return;         // overseers are never restricted
  try {
    const date = getTodayDate();
    const rows = await getAssignments(stationId, date);
    setMyDailyPumps(pumpIdsForUser(rows, me.uid), date);
  } catch {
    setMyDailyPumps([], null);
  }
}
