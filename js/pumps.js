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
  getCurrentUserData, isSuperAdmin, isStationAdmin, isManager, isStationOverseer,
  can, canManageStation, denyReason, formatFirebaseError,
  hasPumpRestriction, canUsePump, filterMyPumps, userDisplayName,
} from './auth.js';
import { updateUserAccount } from './staff-auth.js';
import {
  getPumps, getCurrentRateMap, getPumpSessions, getStaffForStation, watchPumpSessions,
  getShifts, invalidateStation, invalidateUsers,
} from './store.js';
import {
  h, formatCurrency, formatVolume, formatDateTime, formatTimeAgo,
  getTodayDate, openModal, closeModal, emptyState, toast, toastSuccess, toastError,
  confirmSave, confirmDialog, setBusy, showSkeleton,
} from './components.js';

let currentStationId = null;
let pumpContext = null;
let sessionUnsub = null;

export function initPumps() {}

export function stopPumpsLive() {
  if (sessionUnsub) {
    try { sessionUnsub(); } catch { /* already closed */ }
  }
  sessionUnsub = null;
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

function actionFor(pump, session, mayLog) {
  if (isStationOverseer()) {
    if (!session) return { label: 'Start shift →', disabled: false, mode: 'manager-start', secondaryLabel: 'Assign to staff instead' };
    // Manager/admins can end someone else's shift (not just force-release)
    return { label: session.activeUid === getCurrentUserData()?.uid ? 'End shift →' : 'End shift for staff →', disabled: false, mode: 'manager-end' };
  }
  if (!mayLog) return { label: 'View only', disabled: true, mode: 'none' };
  if (!session) return { label: 'Start shift →', disabled: false, mode: 'start' };
  if (isMine(session)) return { label: 'End shift →', disabled: false, mode: 'end' };
  return {
    label: session.activeName ? `In use by ${session.activeName} →` : 'In use — try again shortly',
    disabled: true,
    mode: 'none',
  };
}

function pumpCardHTML(pump, rateMap, sessions, stationId, staff = []) {
  const session = sessionFor(pump.id, sessions);
  const state = sessionLabel(session);
  const mayLog = !isStationOverseer() && can('shift.create', { stationId })
    && (canUsePump(pump.id) || isMine(session));
  const action = actionFor(pump, session, mayLog);
  const assigned = isStationOverseer()
    ? staff.filter(user => (user.pumpIds || []).includes(pump.id))
    : [];
  const assignmentLine = isStationOverseer()
    ? `<span class="pump-assignment-line">${assigned.length ? `Assigned to ${assigned.map(user => h(userDisplayName(user))).join(', ')}` : 'No staff assigned to this pump'}</span>`
    : '';
  const rate = rateMap[pump.product];
  const detail = session
    ? `Started ${h(formatTimeAgo(session.clockInAt) || formatDateTime(session.clockInAt) || 'just now')}`
    : rate
      ? `${h(formatCurrency(rate.rate))}/L configured rate`
      : 'No rate configured';
  const disabledTitle = !mayLog && !isStationOverseer()
    ? denyReason('shift.create', { stationId })
    : action.disabled
      ? 'This pump is locked by another staff member.'
      : '';

  // For overseers, show both a primary action button and a secondary "⋮" menu
  const isOverseer = isStationOverseer();
  const secondaryMenu = isOverseer && session && session.activeUid !== getCurrentUserData()?.uid
    ? `<div class="pump-menu" style="position:relative;display:inline-block;">
        <button type="button" class="icon-btn pump-menu-trigger" data-pump-id="${h(pump.id)}" aria-label="More actions" title="More actions">⋮</button>
        <div class="pump-menu-dropdown" hidden>
          <button type="button" class="pump-menu-item" data-action="force-release" data-pump-id="${h(pump.id)}">Force release (no shift record)</button>
          <button type="button" class="pump-menu-item" data-action="assign" data-pump-id="${h(pump.id)}">Assign to staff</button>
        </div>
      </div>`
    : '';

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
      <div class="pump-card-actions">
        <button type="button" class="btn pump-action ${action.mode === 'end' || action.mode === 'manager-end' ? 'btn-danger' : 'btn-primary'}"
                data-pump-id="${h(pump.id)}" data-mode="${h(action.mode)}"
                ${action.disabled ? 'disabled' : ''}
                ${disabledTitle ? `title="${h(disabledTitle)}"` : ''}>
          ${h(action.label)}
        </button>
        ${secondaryMenu}
      </div>
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
      if (mode === 'assign') openPumpAssignmentForm(stationId, pump, staff);
    });
  });
  // Menu triggers
  board.querySelectorAll('.pump-menu-trigger').forEach(trigger => {
    trigger.addEventListener('click', e => {
      e.stopPropagation();
      const dropdown = trigger.parentElement.querySelector('.pump-menu-dropdown');
      if (dropdown) dropdown.hidden = !dropdown.hidden;
    });
  });
  // Close menus on outside click
  document.addEventListener('click', () => {
    document.querySelectorAll('.pump-menu-dropdown:not([hidden])').forEach(d => { d.hidden = true; });
  }, { once: false });
  // Menu item actions
  board.querySelectorAll('.pump-menu-item').forEach(item => {
    item.addEventListener('click', e => {
      e.stopPropagation();
      const pump = pumps.find(p => p.id === item.dataset.pumpId);
      if (!pump) return;
      const session = sessionFor(pump.id, sessions);
      if (item.dataset.action === 'assign') openPumpAssignmentForm(stationId, pump, staff);
      if (item.dataset.action === 'force-release') {
        import('./config-page.js').then(mod => mod.forceReleasePump ? null : null).catch(() => {});
        // Use the existing force-release logic inline
        forceReleasePumpAtStation(stationId, pump, session);
      }
    });
  });
}

async function forceReleasePumpAtStation(stationId, pump, session) {
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
  }
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

  try {
    const [pumps, rateMap, sessions, staff] = await Promise.all([
      getPumps(stationId),
      getCurrentRateMap(stationId),
      getPumpSessions(stationId),
      isStationOverseer() ? getStaffForStation(stationId) : [],
    ]);
    const mayConfigure = can('pump.create', { stationId });
    const assignedPumps = filterMyPumps(pumps);
    const activeMineIds = new Set(sessions
      .filter(session => session.status === 'active' && session.activeUid === getCurrentUserData()?.uid)
      .map(session => session.id));
    // Keep an in-progress pump visible to its owner if a manager removes the
    // assignment mid-shift. The owner may still end it, but cannot start it
    // again after it becomes idle unless it is reassigned.
    const myPumps = pumps.filter(pump => assignedPumps.includes(pump) || activeMineIds.has(pump.id));

    if (pumps.length === 0) {
      content.innerHTML = `<h2 class="page-title">Pumps</h2>${emptyState('⛽', mayConfigure
        ? 'No pumps yet. Add them from Config → Pumps.'
        : 'No pumps configured yet. Ask your station admin to add them.')}`;
      return;
    }

    if (myPumps.length === 0) {
      content.innerHTML = `<h2 class="page-title">Pumps</h2>${emptyState('🔒',
        'No pumps are assigned to you at this station. Ask your admin or manager to assign pumps from Config → Team.')}`;
      return;
    }

    const mayLog = !isStationOverseer() && can('shift.create', { stationId });
    const hint = isStationOverseer()
      ? 'Live status is shared across devices. Start/end shifts on any pump, or assign staff from the pump menu.'
      : hasPumpRestriction()
        ? `Showing the ${myPumps.length} pump${myPumps.length === 1 ? '' : 's'} assigned to you.`
        : mayLog ? 'Choose a pump to start or end your shift. Live locks update on every device.' : 'You have read-only access.';

    content.innerHTML = `
      <div class="page-head">
        <div>
          <h2 class="page-title">Pumps</h2>
          <p class="section-hint">${h(hint)}</p>
        </div>
        <span class="live-badge" role="status"><span class="live-dot" aria-hidden="true"></span>LIVE LOCKS</span>
      </div>
      <p id="pump-live-note" class="section-hint" aria-live="polite"></p>
      <ul id="pump-board" class="pump-grid"></ul>
    `;

    pumpContext = { stationId, pumps: myPumps, rateMap, sessions, staff };
    paintPumpBoard();
    startSessionWatch(stationId);
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

async function openPumpAssignmentForm(stationId, pump, staff) {
  if (!isStationOverseer()) {
    toastError('Only Station Admins, Managers, and Super Admins can assign pumps.');
    return;
  }
  const activeSession = sessionFor(pump.id, pumpContext?.sessions || []);
  const activeUser = staff.find(user => user.id === activeSession?.activeUid);
  const assignedIds = new Set(staff.filter(user => (user.pumpIds || []).includes(pump.id)).map(user => user.id));
  const warning = activeSession
    ? `<p class="assignment-warning" role="status">⚠️ ${h(activeUser ? userDisplayName(activeUser) : activeSession.activeName || 'A staff member')} is currently active on this pump. Removing their assignment will not end the shift; the lock remains until clock-out or manager force-release.</p>`
    : '';
  const options = staff.length
    ? `<div class="checkbox-list">${staff.map(user => `<div class="checkbox-item"><input type="checkbox" id="assign-pump-${h(user.id)}" value="${h(user.id)}" ${assignedIds.has(user.id) ? 'checked' : ''} /><label for="assign-pump-${h(user.id)}">${h(userDisplayName(user))}</label></div>`).join('')}</div>`
    : '<p class="muted-note">No staff accounts are assigned to this station yet. Add staff from Config → Team first.</p>';
  document.getElementById('modal-title').textContent = `Assign ${pump.name}`;
  document.getElementById('modal-body').innerHTML = `<form id="pump-assignment-form" novalidate>
    <p class="modal-intro">Choose the staff members who can use ${h(pump.name)}. This updates their existing pump assignment list.</p>
    ${warning}${options}
    <p id="pump-assignment-error" class="form-error hidden" role="alert"></p>
    <button type="submit" class="btn btn-primary btn-full mt-16" ${staff.length ? '' : 'disabled'}>Save assignments</button>
  </form>`;
  openModal('generic-modal');
  document.getElementById('pump-assignment-form').addEventListener('submit', async event => {
    event.preventDefault();
    const form = event.currentTarget;
    const button = form.querySelector('button[type=\"submit\"]');
    const error = document.getElementById('pump-assignment-error');
    const selected = new Set(Array.from(form.querySelectorAll('input[type=\"checkbox\"]:checked')).map(input => input.value));
    error.classList.add('hidden');
    if (!(await confirmSave(`the pump assignments for ${pump.name}`))) return;
    setBusy(button, true, 'Saving…');
    try {
      await Promise.all(staff.map(async user => {
        const current = [...new Set(user.pumpIds || [])];
        const next = selected.has(user.id)
          ? [...new Set([...current, pump.id])]
          : current.filter(id => id !== pump.id);
        if (next.length === current.length && next.every((id, index) => id === current[index])) return;
        await updateUserAccount(user.id, { pumpIds: next });
      }));
      invalidateUsers();
      closeModal('generic-modal');
      toastSuccess('Changes Saved — pump assignments updated');
      await renderPumps(stationId);
    } catch (err) {
      error.textContent = `❌ ${formatFirebaseError(err)}`;
      error.classList.remove('hidden');
      setBusy(button, false);
    }
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
          <input type="date" id="clock-in-date" value="${getTodayDate()}" max="${getTodayDate()}" required /></div>
        <div class="field"><label for="clock-in-shift">Shift</label>
          <select id="clock-in-shift" required><option value="1">Shift 1</option><option value="2">Shift 2</option><option value="3">Shift 3</option></select></div>
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
function openClockOutForm(stationId, pump, rate, session) {
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
    toastError(denyReason('pumpSession.end', { stationId }));
    return;
  }

  const rateLocked = !can('rate.update', { stationId });
  const missingRate = rateLocked && !rate;
  const opening = Number(session.opening);
  const actualStaffName = session.activeName || userDisplayName(me);
  const actualStaffUid = session.activeUid || me?.uid;

  document.getElementById('modal-title').textContent = `End shift — ${pump.name}${isOverseerClosing ? ` (for ${actualStaffName})` : ''}`;
  document.getElementById('modal-body').innerHTML = `
    <form id="clock-out-form" novalidate>
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

      <!-- Part C: Notes & Expenses -->
      <hr class="form-divider" />
      <div class="field">
        <label for="clock-out-notes">Notes <span class="optional">(optional)</span></label>
        <textarea id="clock-out-notes" rows="3" placeholder="Anything worth flagging about this shift?" maxlength="500"></textarea>
      </div>
      <div class="field">
        <label>Expenses <span class="optional">(optional)</span></label>
        <div id="expense-rows">
          <div class="expense-row" data-index="0">
            <input type="text" class="expense-item" placeholder="Item" maxlength="60" />
            <input type="number" class="expense-cost" step="0.01" min="0" placeholder="₹0.00" inputmode="decimal" />
            <button type="button" class="icon-btn expense-remove" title="Remove expense" aria-label="Remove expense" hidden>✕</button>
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
    const cashDue = Math.max(0, sales - expensesTotal);
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
      <input type="text" class="expense-item" placeholder="Item" maxlength="60" />
      <input type="number" class="expense-cost" step="0.01" min="0" placeholder="₹0.00" inputmode="decimal" />
      <button type="button" class="icon-btn expense-remove" title="Remove expense" aria-label="Remove expense">✕</button>`;
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

  ['clock-out-closing', 'clock-out-rate'].forEach(id => document.getElementById(id).addEventListener('input', compute));

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
    const volume = closing - Number.isFinite(opening) ? Math.max(0, closing - opening) : 0;
    const sales = volume * finalRate;
    const cashDue = Math.max(0, sales - expensesTotal);

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
        if (!current || current.status !== 'active') {
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
      invalidateStation(stationId);
      closeModal('generic-modal');
      toastSuccess(`Shift Ended — ${formatVolume(volume)} · ${formatCurrency(sales)}`);
      window.dispatchEvent(new CustomEvent('pumplog:dataChanged', { detail: { stationId } }));
    } catch (err) {
      if (err.code === 'session-released') fail('This pump session is no longer yours. It may have been force-released by an admin.');
      else fail(formatFirebaseError(err));
      setBusy(button, false);
    }
  });
}
