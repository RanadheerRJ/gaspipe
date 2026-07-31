/* PumpLog — Pumps page
 *
 * This is the staff-first screen. A pump has one live session document which
 * acts as its lock; the transaction in start/endShift is the final authority,
 * not the button state a device happened to render.
 *
 * Part B: Managers/admins may start a shift themselves OR assign a pump to
 * a staff member. They may also end another staff member's active shift
 * (attributing the shift to the original staff member), not just force-release.
 *
 * Part C: Clock-out form now collects Notes, Expenses (repeatable rows), and
 * computes Cash to hand over.
 */

import {
  getDb, collection, doc, runTransaction, serverTimestamp,
} from './firebase.js';
import {
  getCurrentUserData, isStationOverseer,
  can, ifCan, denyReason, formatFirebaseError,
  canUsePump, filterMyPumps, userDisplayName,
  pumpAccessMode, setMyDailyPumps,
} from './auth.js';
import {
  getPumps, getCurrentRateMap, getPumpSessions, getStaffForStation, watchPumpSessions,
  getShifts, invalidateStation,
  getAssignments, watchAssignments, pumpIdsForUser, getOperationsSettings,
} from './store.js';
import { recordAudit } from './audit.js';
import {
  h, formatCurrency, formatVolume, formatDateTime, formatTimeAgo,
  getTodayDate, openModal, closeModal, emptyState, toastSuccess, toastError,
  confirmDialog, setBusy, showSkeleton,
} from './components.js';

let currentStationId = null;
let pumpContext = null;
let sessionUnsub = null;
let assignmentUnsub = null;

export function initPumps() {}

export function stopPumpsLive() {
  [sessionUnsub, assignmentUnsub].forEach(unsub => {
    if (unsub) { try { unsub(); } catch { /* already closed */ } }
  });
  sessionUnsub = null;
  assignmentUnsub = null;
  pumpContext = null;
}

function stopSessionWatch() {
  stopPumpsLive();
}

function sessionFor(pumpId, rows = pumpContext?.sessions || []) {
  return rows.find(s => s.id === pumpId && s.status === 'active') || null;
}

function isMine(session) {
  return !!session && session.activeUid === getCurrentUserData()?.uid;
}

function sessionLabel(session) {
  if (!session || session.status !== 'active') return { text: 'Idle', cls: 'idle', icon: '○' };
  if (isMine(session)) return { text: 'Active — your shift', cls: 'mine', icon: '●' };
  return {
    text: session.activeName ? `In use by ${session.activeName}` : 'In use — try again shortly',
    cls: 'other',
    icon: '🔒',
  };
}

function actionFor(pump, session, mayLog, stationId) {
  if (!session && can('pumpSession.start', { stationId, pumpId: pump.id })
      && (isStationOverseer() || mayLog)) {
    return { label: '▶️ Start shift', mode: isStationOverseer() ? 'manager-start' : 'start' };
  }
  if (session && can('pumpSession.end', {
    stationId, pumpId: pump.id, activeUid: session.activeUid,
  }) && (isStationOverseer() || isMine(session))) {
    return {
      label: isMine(session) ? '⏹️ End shift' : `⏹️ End ${session.activeName || 'staff'}’s shift`,
      mode: isStationOverseer() ? 'manager-end' : 'end',
    };
  }
  // The status chip already explains why there is no action. Do not show a
  // disabled button that looks tappable but can never succeed.
  return null;
}

function pumpCardHTML(pump, rateMap, sessions, stationId, staff = []) {
  const session = sessionFor(pump.id, sessions);
  const state = sessionLabel(session);
  const mayLog = !isStationOverseer() && can('shift.create', { stationId })
    && (canUsePump(pump.id) || isMine(session));
  const action = actionFor(pump, session, mayLog, stationId);
  // Who is rostered on this pump today, per the board. Falls back to the
  // standing pumpIds list so stations that never open the board still see
  // their assignments here.
  const roster = (pumpContext?.assignments || []).find(row => row.pumpId === pump.id);
  const rosterNames = (roster?.staffUids || []).map(uid =>
    userDisplayName(staff.find(user => user.id === uid)) || roster.staffNames?.[uid] || 'Staff');
  const standingNames = staff
    .filter(user => (user.pumpIds || []).includes(pump.id))
    .map(user => userDisplayName(user));
  const names = rosterNames.length ? rosterNames : standingNames;
  const assignmentLine = isStationOverseer()
    ? `<span class="pump-assignment-line">${names.length
        ? `${rosterNames.length ? 'Working here today' : 'Usual staff'}: ${names.map(h).join(', ')}`
        : 'No active assignment'}</span>`
    : '';
  const rate = rateMap[pump.product];
  const detail = session
    ? `Started ${h(formatTimeAgo(session.clockInAt) || formatDateTime(session.clockInAt) || 'just now')}`
    : rate
      ? `${h(formatCurrency(rate.rate))}/L configured rate`
      : 'No rate configured';
  const primaryPermission = session ? 'pumpSession.end' : 'pumpSession.start';
  const primaryAction = action ? ifCan(primaryPermission, {
    stationId, pumpId: pump.id, activeUid: session?.activeUid,
  }, `
    <button type="button" class="btn pump-action ${action.mode === 'end' || action.mode === 'manager-end' ? 'btn-danger' : 'btn-primary'}"
            data-pump-id="${h(pump.id)}" data-mode="${h(action.mode)}">
      ${h(action.label)}
    </button>`) : '';
  const assignAction = ifCan('assignment.manage', { stationId }, `
    <button type="button" class="btn btn-secondary pump-secondary-action" data-action="assign" data-pump-id="${h(pump.id)}">
      👤 Assign shift
    </button>`);
  const releaseAction = session ? ifCan('pumpSession.forceRelease', { stationId }, `
    <button type="button" class="btn btn-secondary pump-secondary-action danger-text" data-action="force-release" data-pump-id="${h(pump.id)}">
      🔓 Release without saving
    </button>`) : '';

  return `<li>
    <article class="pump-card ${state.cls}">
      <div class="pump-card-head">
        <div class="pump-card-icon" aria-hidden="true">⛽</div>
        <div class="pump-card-title">
          <h3>${h(pump.name || 'Pump')}</h3>
          <p>${h(pump.product || 'No product')}</p>
        </div>
        <span class="status-chip pump-status ${state.cls}" role="status">${state.icon} ${h(state.text)}</span>
      </div>
      <p class="pump-card-detail">${detail}${assignmentLine}</p>
      ${(primaryAction || assignAction || releaseAction) ? `<div class="pump-card-actions">
        ${primaryAction}${assignAction}${releaseAction}
      </div>` : ''}
    </article>
  </li>`;
}

function paintPumpBoard() {
  if (!pumpContext) return;
  const content = document.getElementById('page-content');
  const board = document.getElementById('pump-board');
  if (!board || !content || currentStationId !== pumpContext.stationId) return;

  const { stationId, pumps, rateMap, sessions, staff } = pumpContext;
  board.innerHTML = pumps.map(p => pumpCardHTML(p, rateMap, sessions, stationId, staff)).join('');
  board.querySelectorAll('.pump-action').forEach(button => {
    button.addEventListener('click', () => {
      const pump = pumps.find(p => p.id === button.dataset.pumpId);
      if (!pump) return;
      const session = sessionFor(pump.id, sessions);
      const mode = button.dataset.mode;
      if (mode === 'start') openClockInForm(stationId, pump, rateMap[pump.product]);
      if (mode === 'end') openClockOutForm(stationId, pump, rateMap[pump.product], session);
      if (mode === 'manager-start') openClockInForm(stationId, pump, rateMap[pump.product]);
      if (mode === 'manager-end') openClockOutForm(stationId, pump, rateMap[pump.product], session);
    });
  });
  board.querySelectorAll('.pump-secondary-action').forEach(item => {
    item.addEventListener('click', () => {
      const pump = pumps.find(p => p.id === item.dataset.pumpId);
      if (!pump) return;
      const session = sessionFor(pump.id, sessions);
      if (item.dataset.action === 'assign') openAssignmentForm(stationId, pump, rateMap[pump.product], staff);
      if (item.dataset.action === 'force-release') forceReleasePumpAtStation(stationId, pump, session, item);
    });
  });
}

async function forceReleasePumpAtStation(stationId, pump, session, button = null) {
  if (!pump || !session || !can('pumpSession.forceRelease', { stationId })) {
    toastError(denyReason('pumpSession.forceRelease'));
    return;
  }
  const started = formatDateTime(session.clockInAt) || 'an unknown time';
  const startedBy = session.activeName || 'an unknown staff member';
  const ok = await confirmDialog({
    title: '⚠️ Force-Release Pump',
    message: `Pump ${pump.name} has been active since ${started}, started by ${startedBy}. Force-release it without saving a shift record?`,
    confirmLabel: 'Force release 🔓',
    danger: true,
  });
  if (!ok) return;
  setBusy(button, true, 'Releasing…');
  try {
    const db = getDb();
    const ref = doc(db, 'stations', stationId, 'pumpSessions', pump.id);
    await runTransaction(db, async (transaction) => {
      const snap = await transaction.get(ref);
      const current = snap.exists() ? snap.data() : null;
      transaction.update(ref, {
        status: 'idle',
        activeUid: null,
        activeName: null,
        clockInAt: null,
        opening: null,
        date: null,
        shiftLabel: null,
        pumpName: current?.pumpName || pump.name || 'Pump',
        product: current?.product || pump.product || '',
        updatedAt: serverTimestamp(),
        updatedBy: getCurrentUserData()?.uid || 'unknown',
      });
    });
    invalidateStation(stationId);
    toastSuccess(`${pump.name} released`);
    window.dispatchEvent(new CustomEvent('pumplog:dataChanged', { detail: { stationId } }));
    renderPumps(stationId);
  } catch (err) {
    toastError(formatFirebaseError(err));
    setBusy(button, false);
  }
}

/**
 * Watch today's roster so a manager rostering someone from the board unlocks
 * Start shift on that person's device within a second, with no refresh.
 */
function startAssignmentWatch(stationId, date) {
  assignmentUnsub = watchAssignments(stationId, date, {
    onUpdate: (rows) => {
      if (!pumpContext || pumpContext.stationId !== stationId) return;
      pumpContext.assignments = rows;
      const me = getCurrentUserData();
      if (!me) return;

      if (!isStationOverseer()) {
        const all = pumpContext.allPumps || pumpContext.pumps;
        const before = filterMyPumps(all).map(p => p.id).join(',');
        setMyDailyPumps(pumpIdsForUser(rows, me.uid), date);
        // A roster change can add or remove whole pumps from this page, which
        // paintPumpBoard() alone cannot express — re-render in that case.
        if (filterMyPumps(all).map(p => p.id).join(',') !== before) {
          renderPumps(stationId);
          return;
        }
      }
      paintPumpBoard();
    },
    onError: () => { /* roster is advisory here; the lock still governs */ },
  });
}

function startSessionWatch(stationId) {
  sessionUnsub = watchPumpSessions(stationId, {
    onUpdate: (sessions) => {
      if (!pumpContext || pumpContext.stationId !== stationId) return;
      pumpContext.sessions = sessions;
      paintPumpBoard();
    },
    onError: () => {
      const note = document.getElementById('pump-live-note');
      if (note) note.textContent = 'Live lock updates paused — use Refresh to re-sync.';
    },
  });
}

export async function renderPumps(stationId) {
  currentStationId = stationId;
  stopSessionWatch();
  const content = document.getElementById('page-content');

  if (!stationId) {
    content.innerHTML = emptyState('⛽', 'Select a station to see its pumps.');
    return;
  }

  showSkeleton(3);

  const today = getTodayDate();

  try {
    const [pumps, rateMap, sessions, staff, assignments] = await Promise.all([
      getPumps(stationId),
      getCurrentRateMap(stationId),
      getPumpSessions(stationId),
      isStationOverseer() ? getStaffForStation(stationId).catch(() => []) : [],
      getAssignments(stationId, today).catch(() => []),
    ]);

    // Publish today's roster to the RBAC layer before any permission check
    // runs — this is what makes Start shift work for a rostered staff member.
    const me = getCurrentUserData();
    if (me && !isStationOverseer()) {
      setMyDailyPumps(pumpIdsForUser(assignments, me.uid), today);
    }

    const mayConfigure = can('pump.create', { stationId });
    const assignedPumps = filterMyPumps(pumps);
    const activeMineIds = new Set(sessions
      .filter(session => session.status === 'active' && session.activeUid === me?.uid)
      .map(session => session.id));
    // Keep an in-progress pump visible to its owner if a manager removes the
    // assignment mid-shift. The owner may still end it, but cannot start it
    // again after it becomes idle unless it is reassigned.
    const myPumps = pumps.filter(pump => assignedPumps.includes(pump) || activeMineIds.has(pump.id));

    if (pumps.length === 0) {
      content.innerHTML = `<h2 class="page-title">Shifts</h2>${emptyState('⛽', mayConfigure
        ? 'No pumps yet. Add them in Settings → Pumps.'
        : 'No pumps configured yet. Ask your station admin to add them.')}`;
      return;
    }

    if (myPumps.length === 0) {
      content.innerHTML = `<h2 class="page-title">Shifts</h2>${emptyState('🔒',
        'No pumps are assigned to you today. Ask your manager to assign a shift.')}`;
      return;
    }

    const mayLog = !isStationOverseer() && can('shift.create', { stationId });
    const mode = pumpAccessMode();
    const hint = isStationOverseer()
      ? 'Assign an employee to a pump, then close each shift when work is finished.'
      : mode === 'daily'
        ? `You are on ${myPumps.length} pump${myPumps.length === 1 ? '' : 's'} today. Tap one to start your shift.`
        : mode === 'standing'
          ? `Showing the ${myPumps.length} pump${myPumps.length === 1 ? '' : 's'} assigned to you.`
          : mayLog ? 'Choose a pump to start or end your shift. Live locks update on every device.' : 'You have read-only access.';

    content.innerHTML = `
      <div class="page-head">
        <div>
          <h2 class="page-title">Shifts</h2>
          <p class="section-hint">${h(hint)}</p>
        </div>
        <span class="live-badge" role="status"><span class="live-dot" aria-hidden="true"></span>LIVE LOCKS</span>
      </div>
      <p id="pump-live-note" class="section-hint" aria-live="polite"></p>
      <ul id="pump-board" class="pump-grid"></ul>
    `;

    pumpContext = {
      stationId, pumps: myPumps, allPumps: pumps, rateMap, sessions, staff,
      assignments, date: today,
    };
    paintPumpBoard();
    startSessionWatch(stationId);
    startAssignmentWatch(stationId, today);
  } catch (err) {
    content.innerHTML = emptyState('⚠️', formatFirebaseError(err));
  }
}

// Kept as the shared entry point for Dashboard's pump detail action.
export function openShiftForm(stationId, pump, rate, session = null) {
  if (isStationOverseer()) {
    // Overseers: show clock-in if idle, clock-out if active (anyone's)
    if (session && session.status === 'active') {
      openClockOutForm(stationId, pump, rate, session);
    } else {
      openClockInForm(stationId, pump, rate);
    }
  } else if (session && isMine(session)) {
    openClockOutForm(stationId, pump, rate, session);
  } else {
    openClockInForm(stationId, pump, rate);
  }
}

// ── Simple manager assignment ───────────────────────────────────────────
// Assignment and start are one transaction: a pump never has two active shifts.
function openAssignmentForm(stationId, pump, rate, staff) {
  if (!can('assignment.manage', { stationId })) return toastError(denyReason('assignment.manage', { stationId }));
  if (!staff?.length) return toastError('Add an employee in Settings before assigning a shift.');
  document.getElementById('modal-title').textContent = `Assign shift — ${pump.name}`;
  document.getElementById('modal-body').innerHTML = `<form id="assignment-form" novalidate>
    <p class="modal-intro">Choose an employee and opening meter reading. This starts their shift immediately.</p>
    <div class="field"><label for="assignment-staff">Employee</label><select id="assignment-staff" required>
      <option value="">Choose employee…</option>${staff.map(person => `<option value="${h(person.id || person.uid)}" data-name="${h(userDisplayName(person))}">${h(userDisplayName(person))}</option>`).join('')}
    </select></div>
    <div class="field"><label for="assignment-opening">Opening meter reading</label><input id="assignment-opening" type="number" min="0" step="0.01" inputmode="decimal" required /></div>
    <p class="hint">${rate ? `Configured rate: ${formatCurrency(rate.rate)}/L.` : 'No rate is configured; add one in Settings before closing.'}</p>
    <p id="assignment-error" class="form-error hidden" role="alert"></p>
    <button class="btn btn-primary btn-full" type="submit">Assign & start shift</button>
  </form>`;
  openModal('generic-modal');
  document.getElementById('assignment-form').addEventListener('submit', async event => {
    event.preventDefault();
    const button = event.currentTarget.querySelector('button');
    const error = document.getElementById('assignment-error');
    const fail = message => { error.textContent = message; error.classList.remove('hidden'); };
    const select = document.getElementById('assignment-staff');
    const uid = select.value;
    const name = select.selectedOptions[0]?.dataset.name || '';
    const openingRaw = document.getElementById('assignment-opening').value;
    const opening = Number(openingRaw);
    if (!uid) return fail('Choose an employee.');
    if (openingRaw === '' || !Number.isFinite(opening) || opening < 0) return fail('Enter a valid opening meter reading.');
    setBusy(button, true, 'Assigning…');
    try {
      const db = getDb();
      const sessionRef = doc(db, 'stations', stationId, 'pumpSessions', pump.id);
      const assignmentRef = doc(db, 'stations', stationId, 'assignments', `${getTodayDate()}_${pump.id}`);
      await runTransaction(db, async transaction => {
        const existing = await transaction.get(sessionRef);
        if (existing.exists() && existing.data().status === 'active') {
          const conflict = new Error('This pump already has an active shift.'); conflict.code = 'pump-active'; throw conflict;
        }
        transaction.set(sessionRef, { status: 'active', activeUid: uid, activeName: name, pumpName: pump.name || 'Pump', product: pump.product || '', clockInAt: serverTimestamp(), opening, date: getTodayDate(), shiftLabel: '24 Hour', updatedAt: serverTimestamp(), updatedBy: getCurrentUserData().uid });
        transaction.set(assignmentRef, { date: getTodayDate(), pumpId: pump.id, pumpName: pump.name || 'Pump', product: pump.product || '', staffUids: [uid], staffNames: { [uid]: name }, createdAt: serverTimestamp(), createdBy: getCurrentUserData().uid, updatedAt: serverTimestamp(), updatedBy: getCurrentUserData().uid });
      });
      recordAudit(stationId, 'Shift Assigned', { type: 'pump', id: pump.id, name: pump.name, employeeId: uid, employeeName: name }, 'Manager assigned and started shift.').catch(() => {});
      invalidateStation(stationId); closeModal('generic-modal'); toastSuccess(`${name} assigned to ${pump.name}`);
      window.dispatchEvent(new CustomEvent('pumplog:dataChanged', { detail: { stationId } }));
    } catch (err) { fail(err.code === 'pump-active' ? 'This pump already has an active shift.' : formatFirebaseError(err)); setBusy(button, false); }
  });
}

// ── Clock-in form (now open to managers/admins too) ──────────────────────
function openClockInForm(stationId, pump, rate) {
  if (!isStationOverseer() && (!can('pumpSession.start', { stationId, pumpId: pump.id }) || !canUsePump(pump.id))) {
    toastError(canUsePump(pump.id) ? denyReason('shift.create', { stationId }) : 'This pump is not assigned to you.');
    return;
  }

  const rateLocked = !can('rate.update', { stationId });
  const missingRate = rateLocked && !rate;

  // E2: Prefill initialReading for the pump's genuine first shift (no prior history)
  const prefillOpening = async () => {
    try {
      const shifts = await getShifts(stationId, { max: 1 });
      const hasHistory = shifts.some(s => s.pumpId === pump.id);
      return !hasHistory && pump.initialReading != null ? pump.initialReading : '';
    } catch {
      return pump.initialReading != null ? pump.initialReading : '';
    }
  };

  let openingPrefillPromise = prefillOpening();

  document.getElementById('modal-title').textContent = `Start shift — ${pump.name}`;
  document.getElementById('modal-body').innerHTML = `
    <form id="clock-in-form" novalidate>
      <p class="modal-intro">Enter the opening meter reading. The pump will be reserved for you until you end this shift.</p>
      <div class="form-row">
        <div class="field"><label for="clock-in-date">Date</label>
          <input type="date" id="clock-in-date" value="${getTodayDate()}" max="${getTodayDate()}" ${isStationOverseer() ? '' : `min="${getTodayDate()}" readonly aria-readonly="true"`} required /></div>
        <input type="hidden" id="clock-in-shift" value="24 Hour" />
        <div class="field"><label>Shift</label><input value="24 Hour" readonly aria-readonly="true" /><small class="hint">Your station uses one continuous shift.</small></div>
      </div>
      <div class="field"><label for="clock-in-opening">Opening reading</label>
        <input type="number" id="clock-in-opening" step="0.01" min="0" inputmode="decimal" placeholder="0.00" required /></div>
      <p class="hint">${rateLocked
        ? (rate ? `Configured rate: ${formatCurrency(rate.rate)}/L (managed by your admin).` : `No rate configured for ${h(pump.product || 'this product')}. Ask your manager to add one before starting.`)
        : rate ? `Current rate: ${formatCurrency(rate.rate)}/L.` : 'A manager can enter a rate when ending the shift.'}</p>
      <p class="form-error ${missingRate ? '' : 'hidden'}" id="clock-in-error" role="alert">${missingRate
        ? 'No rate is configured for this product. Ask your manager or admin to set one in Config → Rates.' : ''}</p>
      <button type="submit" class="btn btn-primary btn-full" ${missingRate ? 'disabled' : ''}>Start shift</button>
    </form>`;
  openModal('generic-modal');

  // Prefill the opening reading once resolved
  openingPrefillPromise.then(val => {
    const el = document.getElementById('clock-in-opening');
    if (el && val !== '') el.value = val;
  });

  document.getElementById('clock-in-form').addEventListener('submit', async e => {
    e.preventDefault();
    const form = e.currentTarget;
    const button = form.querySelector('button[type="submit"]');
    const error = document.getElementById('clock-in-error');
    const fail = message => { error.textContent = message; error.classList.remove('hidden'); };
    const date = document.getElementById('clock-in-date').value;
    const openingRaw = document.getElementById('clock-in-opening').value;
    const opening = Number(openingRaw);
    if (!date || date > getTodayDate()) return fail('Choose today or an earlier date.');
    if (!isStationOverseer() && date !== getTodayDate()) return fail('Staff shifts must start today. Refresh the page and try again.');
    if (openingRaw === '' || !Number.isFinite(opening) || opening < 0) return fail('Enter a valid opening reading.');
    if (missingRate) return fail('No rate configured — ask a manager or admin to set one first.');

    setBusy(button, true, 'Starting…');
    const me = getCurrentUserData();
    const sessionRef = doc(getDb(), 'stations', stationId, 'pumpSessions', pump.id);
    try {
      await runTransaction(getDb(), async transaction => {
        const snapshot = await transaction.get(sessionRef);
        const existing = snapshot.exists() ? snapshot.data() : null;
        if (existing?.status === 'active') {
          const conflict = new Error('This pump is already active.');
          conflict.code = 'pump-active';
          conflict.activeName = existing.activeName;
          conflict.clockInAt = existing.clockInAt;
          throw conflict;
        }
        transaction.set(sessionRef, {
          status: 'active',
          activeUid: me.uid,
          activeName: userDisplayName(me),
          pumpName: pump.name || 'Pump',
          product: pump.product || '',
          clockInAt: serverTimestamp(),
          opening,
          date,
          shiftLabel: document.getElementById('clock-in-shift').value,
          updatedAt: serverTimestamp(),
          updatedBy: me.uid,
        });
      });
      recordAudit(stationId, 'Shift Started', { type: 'pump', id: pump.id, name: pump.name }, 'Opening reading recorded.').catch(() => {});
      invalidateStation(stationId);
      closeModal('generic-modal');
      toastSuccess(`Shift Started — ${pump.name}`);
      window.dispatchEvent(new CustomEvent('pumplog:dataChanged', { detail: { stationId } }));
    } catch (err) {
      if (err.code === 'pump-active') {
        const who = err.activeName || 'another staff member';
        const when = formatDateTime(err.clockInAt) || 'just now';
        fail(`This pump is already active — started by ${who} at ${when}.`);
      } else {
        fail(formatFirebaseError(err));
      }
      setBusy(button, false);
    }
  });
}

// ── Clock-out form (Part B: manager can close others' shifts)
// ── Part C: adds Notes, Expenses, Cash to hand over
async function openClockOutForm(stationId, pump, rate, session) {
  const me = getCurrentUserData();
  const isOverseerClosing = isStationOverseer() && session && session.activeUid !== me?.uid;
  const isSelfClosing = session && session.activeUid === me?.uid;

  // Allow closing: self OR station overseer
  if (!session) {
    toastError('This pump has no active session to end.');
    return;
  }
  if (!isSelfClosing && !isOverseerClosing) {
    toastError('This shift is no longer assigned to you. The pump status was refreshed.');
    return;
  }
  if (!can('pumpSession.end', { stationId, pumpId: pump.id, activeUid: session.activeUid })) {
    toastError(denyReason('pumpSession.end', { stationId, pumpId: pump.id, activeUid: session.activeUid }));
    return;
  }

  const rateLocked = !can('rate.update', { stationId });
  const missingRate = rateLocked && !rate;
  const opening = Number(session.opening);
  const actualStaffName = session.activeName || userDisplayName(me);
  const actualStaffUid = session.activeUid || me?.uid;
  const operations = await getOperationsSettings(stationId).catch(() => ({}));
  const expenseCategories = operations.expenseCategories || ['Tea', 'Cleaning', 'Maintenance', 'Oil', 'Miscellaneous'];

  document.getElementById('modal-title').textContent = `End shift — ${pump.name}${isOverseerClosing ? ` (for ${actualStaffName})` : ''}`;
  document.getElementById('modal-body').innerHTML = `
    <form id="clock-out-form" novalidate>
      <datalist id="expense-category-list">${expenseCategories.map(value => `<option value="${h(value)}"></option>`).join('')}</datalist>
      <div class="session-reference" role="status">
        <strong>Started ${h(formatTimeAgo(session.clockInAt) || formatDateTime(session.clockInAt) || 'just now')}</strong>
        <span>Opening reading: ${Number.isFinite(opening) ? opening.toFixed(2) : '—'} ${isOverseerClosing ? `· Staff: ${h(actualStaffName)}` : ''}</span>
      </div>
      <div class="field"><label for="clock-out-closing">Closing reading</label>
        <input type="number" id="clock-out-closing" step="0.01" min="0" inputmode="decimal" placeholder="0.00" required /></div>
      <div class="field"><label for="clock-out-rate">Rate (₹/L)</label>
        <input type="number" id="clock-out-rate" step="0.01" min="0" inputmode="decimal" value="${rate?.rate ?? ''}"
               ${rateLocked ? 'readonly aria-readonly="true" class="input-locked"' : ''} required />
        <small class="hint">${rateLocked
          ? (rate ? `Rate is managed by your admin — ${formatCurrency(rate.rate)}/L.` : 'No configured rate is available.')
          : rate ? `Current configured rate: ${formatCurrency(rate.rate)}/L.` : 'Enter the rate used for this shift.'}</small>
      </div>
      <div class="computed-row"><span class="label">Volume</span><output class="value" id="clock-out-volume">0.0 L</output></div>
      <div class="computed-row"><span class="label">Sale amount</span><output class="value green" id="clock-out-sales">₹0.00</output></div>
      <div class="form-row"><div class="field"><label for="testing-fuel">Testing fuel (L)</label><input id="testing-fuel" type="number" min="0" step="0.01" inputmode="decimal" value="0" /></div><div class="field"><label for="credits-total">Credits given</label><input id="credits-total" type="number" min="0" step="0.01" inputmode="decimal" value="0" /></div></div>
      <div class="field"><label for="digital-payments-total">Digital payments</label><input id="digital-payments-total" type="number" min="0" step="0.01" inputmode="decimal" value="0" /><small class="hint">Record the total received by UPI, card, wallet, or another configured method.</small></div>

      <!-- Notes & Expenses -->
      <hr class="form-divider" />
      <div class="field">
        <label for="clock-out-notes">Notes <span class="optional">(optional)</span></label>
        <textarea id="clock-out-notes" rows="3" placeholder="Anything worth flagging about this shift?" maxlength="500"></textarea>
      </div>
      <div class="field">
        <label>Expenses <span class="optional">(optional)</span></label>
        <div id="expense-rows">
          <div class="expense-row" data-index="0">
            <input type="text" class="expense-item" list="expense-category-list" placeholder="Category or custom item" maxlength="60" />
            <input type="number" class="expense-cost" step="0.01" min="0" placeholder="₹0.00" inputmode="decimal" />
            <button type="button" class="btn btn-secondary btn-small expense-remove" hidden>✕ Remove</button>
          </div>
        </div>
        <button type="button" id="add-expense-btn" class="btn btn-secondary btn-small mt-8">+ Add expense</button>
      </div>
      <div class="computed-row"><span class="label">Total expenses</span><output class="value" id="clock-out-expenses-total">₹0.00</output></div>
      <div class="computed-row"><span class="label">Cash to hand over</span><output class="value green" id="clock-out-cash-due">₹0.00</output></div>
      <p id="cash-warning" class="form-error hidden" role="alert">⚠️ Expenses exceed sales — check the entries.</p>

      <p class="form-error ${missingRate ? '' : 'hidden'}" id="clock-out-error" role="alert">${missingRate
        ? 'No rate configured — a manager or admin must set one first.' : ''}</p>
      <button type="submit" class="btn btn-danger btn-full mt-16" ${missingRate ? 'disabled' : ''}>End shift</button>
    </form>`;
  openModal('generic-modal');

  // Read helpers
  const read = id => Number(document.getElementById(id).value);
  const readText = id => (document.getElementById(id)?.value || '').trim();

  function computeExpenses() {
    let total = 0;
    document.querySelectorAll('.expense-cost').forEach(input => {
      const val = parseFloat(input.value);
      if (Number.isFinite(val) && val >= 0) total += val;
    });
    return total;
  }

  const compute = () => {
    const closing = read('clock-out-closing');
    const rateValue = read('clock-out-rate');
    const volume = Number.isFinite(closing) && Number.isFinite(opening) ? Math.max(0, closing - opening) : 0;
    const sales = volume * (Number.isFinite(rateValue) ? rateValue : 0);
    document.getElementById('clock-out-volume').textContent = formatVolume(volume);
    document.getElementById('clock-out-sales').textContent = formatCurrency(sales);

    // Expenses and cash due
    const expensesTotal = computeExpenses();
    const creditsTotal = Math.max(0, read('credits-total') || 0);
    const digitalPaymentsTotal = Math.max(0, read('digital-payments-total') || 0);
    const cashDue = Math.max(0, sales - expensesTotal - creditsTotal - digitalPaymentsTotal);
    document.getElementById('clock-out-expenses-total').textContent = formatCurrency(expensesTotal);
    document.getElementById('clock-out-cash-due').textContent = formatCurrency(cashDue);
    const warning = document.getElementById('cash-warning');
    if (expensesTotal > sales && sales > 0) {
      warning.classList.remove('hidden');
    } else {
      warning.classList.add('hidden');
    }
  };

  // Wire expense add/remove
  function addExpenseRow() {
    const container = document.getElementById('expense-rows');
    const index = container.children.length;
    const row = document.createElement('div');
    row.className = 'expense-row';
    row.dataset.index = index;
    row.innerHTML = `
      <input type="text" class="expense-item" list="expense-category-list" placeholder="Category or custom item" maxlength="60" />
      <input type="number" class="expense-cost" step="0.01" min="0" placeholder="₹0.00" inputmode="decimal" />
      <button type="button" class="btn btn-secondary btn-small expense-remove">✕ Remove</button>`;
    container.appendChild(row);
    row.querySelector('.expense-cost').addEventListener('input', compute);
    row.querySelector('.expense-item').addEventListener('input', compute);
    row.querySelector('.expense-remove').addEventListener('click', () => {
      row.remove();
      compute();
    });
    compute();
  }

  document.getElementById('add-expense-btn').addEventListener('click', addExpenseRow);

  // Wire initial expense fields
  document.querySelectorAll('.expense-cost').forEach(el => el.addEventListener('input', compute));
  document.querySelectorAll('.expense-item').forEach(el => el.addEventListener('input', compute));

  const removalBtns = document.querySelectorAll('.expense-remove');
  if (removalBtns.length === 1) removalBtns[0].hidden = true; // hide remove on initial lone row

  ['clock-out-closing', 'clock-out-rate', 'testing-fuel', 'credits-total', 'digital-payments-total'].forEach(id => document.getElementById(id).addEventListener('input', compute));

  document.getElementById('clock-out-form').addEventListener('submit', async e => {
    e.preventDefault();
    const form = e.currentTarget;
    const button = form.querySelector('button[type="submit"]');
    const error = document.getElementById('clock-out-error');
    const fail = message => { error.textContent = message; error.classList.remove('hidden'); };
    const closingRaw = document.getElementById('clock-out-closing').value;
    const closing = Number(closingRaw);
    const rateValue = Number(document.getElementById('clock-out-rate').value);
    if (closingRaw === '' || !Number.isFinite(closing) || closing < 0) return fail('Enter a valid closing reading.');
    if (!Number.isFinite(opening) || opening < 0) return fail('The opening reading is missing. Ask an admin to force-release this pump.');
    if (closing < opening) return fail('Closing reading cannot be lower than the opening reading.');
    if (closing === opening) return fail('Opening and closing readings are identical — volume would be zero.');
    if (missingRate || !Number.isFinite(rateValue) || rateValue <= 0) return fail('Enter a rate greater than zero.');
    const finalRate = rateLocked ? Number(rate.rate) : rateValue;
    setBusy(button, true, 'Saving…');

    // Collect expense data
    const expenseItems = [];
    document.querySelectorAll('.expense-row').forEach(row => {
      const item = (row.querySelector('.expense-item')?.value || '').trim();
      const cost = parseFloat(row.querySelector('.expense-cost')?.value);
      if (item && Number.isFinite(cost) && cost >= 0) {
        expenseItems.push({ item, cost });
      }
    });
    const notes = readText('clock-out-notes');
    const expensesTotal = computeExpenses();
    const testingFuel = Math.max(0, Number(document.getElementById('testing-fuel').value) || 0);
    const creditsTotal = Math.max(0, Number(document.getElementById('credits-total').value) || 0);
    const digitalPaymentsTotal = Math.max(0, Number(document.getElementById('digital-payments-total').value) || 0);
    const volume = Number.isFinite(opening) ? Math.max(0, closing - opening) : 0;
    const sales = volume * finalRate;
    const cashDue = Math.max(0, sales - expensesTotal - creditsTotal - digitalPaymentsTotal);

    // Part D: if a manager/admin is closing on behalf of staff, auto-approve
    const shiftStatus = isOverseerClosing ? 'approved' : 'pending';
    const reviewedBy = isOverseerClosing ? me.uid : null;
    const reviewedAt = isOverseerClosing ? serverTimestamp() : null;

    const sessionRef = doc(getDb(), 'stations', stationId, 'pumpSessions', pump.id);
    const meNow = getCurrentUserData();
    try {
      await runTransaction(getDb(), async transaction => {
        const snapshot = await transaction.get(sessionRef);
        const current = snapshot.exists() ? snapshot.data() : null;
        if (!current || current.status !== 'active' || current.activeUid !== actualStaffUid) {
          const released = new Error('This pump session changed before it could be ended.');
          released.code = 'session-released';
          throw released;
        }
        // E1: Include pumpName and product explicitly so sessionFieldsOk() passes
        const clockInDate = current.clockInAt && typeof current.clockInAt.toDate === 'function'
          ? current.clockInAt.toDate() : null;
        const hoursWorked = clockInDate
          ? Math.round(Math.max(0, Date.now() - clockInDate.getTime()) / 3600000 * 100) / 100
          : 0;
        const shiftRef = doc(collection(getDb(), 'stations', stationId, 'shifts'));
        transaction.set(shiftRef, {
          pumpId: pump.id,
          pumpName: pump.name || current.pumpName || 'Pump',
          product: pump.product || current.product || '',
          date: current.date,
          shiftLabel: current.shiftLabel,
          opening: Number(current.opening),
          closing,
          volume,
          rate: finalRate,
          sales,
          createdBy: meNow.uid,
          // Part B: attribute shift to the original session owner, not the manager
          staffId: actualStaffUid,
          staffUid: actualStaffUid,
          staffName: actualStaffName,
          clockInAt: current.clockInAt || null,
          clockOutAt: serverTimestamp(),
          hoursWorked,
          createdAt: serverTimestamp(),
          // Part C: new fields
          notes: notes || '',
          expenses: expenseItems,
          expensesTotal,
          testingFuel,
          creditsTotal,
          digitalPaymentsTotal,
          cashDue,
          // Part D: approval status
          status: shiftStatus,
          ...(reviewedBy ? { approvedBy: reviewedBy } : {}),
          ...(reviewedAt ? { approvedAt: reviewedAt } : {}),
        });
        // E1: Include pumpName and product explicitly in the idle-session write
        transaction.update(sessionRef, {
          status: 'idle',
          activeUid: null,
          activeName: null,
          clockInAt: null,
          opening: null,
          date: null,
          shiftLabel: null,
          pumpName: current.pumpName || pump.name || 'Pump',
          product: current.product || pump.product || '',
          updatedAt: serverTimestamp(),
          updatedBy: meNow.uid,
        });
      });
      recordAudit(stationId, 'Shift Closed', { type: 'pump', id: pump.id, name: pump.name, employeeId: actualStaffUid }, isOverseerClosing ? 'Closed on behalf of employee.' : '').catch(() => {});
      invalidateStation(stationId);
      closeModal('generic-modal');
      toastSuccess(`Shift Ended — ${formatVolume(volume)} · ${formatCurrency(sales)}`);
      window.dispatchEvent(new CustomEvent('pumplog:dataChanged', { detail: { stationId } }));
    } catch (err) {
      const permissionDenied = err?.code === 'permission-denied'
        || String(err?.message || '').includes('Missing or insufficient permissions');
      if (err.code === 'session-released') {
        fail("This shift isn't showing as yours anymore. Refresh the page and try again.");
      } else if (permissionDenied) {
        fail(denyReason('pumpSession.end', {
          stationId, pumpId: pump.id, activeUid: session?.activeUid,
        }));
      } else {
        fail(formatFirebaseError(err));
      }
      setBusy(button, false);
    }
  });
}

/** Preload today's assignment grants before the first screen is painted. */
export async function primeMyDailyPumps(stationId) {
  const me = getCurrentUserData();
  if (!stationId || !me || isStationOverseer()) return;
  try {
    const assignments = await getAssignments(stationId, getTodayDate());
    setMyDailyPumps(pumpIdsForUser(assignments, me.uid), getTodayDate());
  } catch {
    setMyDailyPumps([], null);
  }
}
