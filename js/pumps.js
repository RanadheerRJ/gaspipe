/* PumpLog — Pumps page
 *
 * This is the staff-first screen. A pump has one live session document which
 * acts as its lock; the transaction in start/endShift is the final authority,
 * not the button state a device happened to render.
 */

import {
  getDb, collection, doc, runTransaction, serverTimestamp,
} from './firebase.js';
import {
  getCurrentUserData, can, denyReason, formatFirebaseError,
  hasPumpRestriction, canUsePump, filterMyPumps,
} from './auth.js';
import {
  getPumps, getCurrentRateMap, getPumpSessions, watchPumpSessions,
  invalidateStation,
} from './store.js';
import {
  h, formatCurrency, formatVolume, formatDateTime, formatTimeAgo,
  getTodayDate, openModal, closeModal, emptyState, toast, setBusy, showSkeleton,
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
  const admin = ['superadmin', 'stationadmin'].includes(getCurrentUserData()?.role);
  return {
    text: admin && session.activeName ? `In use by ${session.activeName}` : 'In use — try again shortly',
    cls: 'other',
    icon: '🔒',
  };
}

function actionFor(pump, session, mayLog) {
  if (!mayLog) return { label: 'View only', disabled: true, mode: 'none' };
  if (!session) return { label: 'Start shift →', disabled: false, mode: 'start' };
  if (isMine(session)) return { label: 'End shift →', disabled: false, mode: 'end' };
  const admin = ['superadmin', 'stationadmin'].includes(getCurrentUserData()?.role);
  return {
    label: admin && session.activeName ? `In use by ${session.activeName} →` : 'In use — try again shortly',
    disabled: true,
    mode: 'none',
  };
}

function pumpCardHTML(pump, rateMap, sessions, stationId) {
  const session = sessionFor(pump.id, sessions);
  const state = sessionLabel(session);
  const mayLog = can('shift.create', { stationId }) && canUsePump(pump.id);
  const action = actionFor(pump, session, mayLog);
  const rate = rateMap[pump.product];
  const detail = session
    ? `Started ${h(formatTimeAgo(session.clockInAt) || formatDateTime(session.clockInAt) || 'just now')}`
    : rate
      ? `${h(formatCurrency(rate.rate))}/L configured rate`
      : 'No rate configured';
  const disabledTitle = !mayLog
    ? denyReason('shift.create', { stationId })
    : action.disabled
      ? 'This pump is locked by another staff member.'
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
      <p class="pump-card-detail">${detail}</p>
      <button type="button" class="btn pump-action ${action.mode === 'end' ? 'btn-danger' : 'btn-primary'}"
              data-pump-id="${h(pump.id)}" data-mode="${h(action.mode)}"
              ${action.disabled ? 'disabled' : ''}
              ${disabledTitle ? `title="${h(disabledTitle)}"` : ''}>
        ${h(action.label)}
      </button>
    </article>
  </li>`;
}

function paintPumpBoard() {
  if (!pumpContext) return;
  const content = document.getElementById('page-content');
  const board = document.getElementById('pump-board');
  if (!board || !content || currentStationId !== pumpContext.stationId) return;

  const { stationId, pumps, rateMap, sessions } = pumpContext;
  board.innerHTML = pumps.map(p => pumpCardHTML(p, rateMap, sessions, stationId)).join('');
  board.querySelectorAll('.pump-action').forEach(button => {
    button.addEventListener('click', () => {
      const pump = pumps.find(p => p.id === button.dataset.pumpId);
      if (!pump) return;
      const session = sessionFor(pump.id, sessions);
      if (button.dataset.mode === 'start') openClockInForm(stationId, pump, rateMap[pump.product]);
      if (button.dataset.mode === 'end') openClockOutForm(stationId, pump, rateMap[pump.product], session);
    });
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

  try {
    const [pumps, rateMap, sessions] = await Promise.all([
      getPumps(stationId),
      getCurrentRateMap(stationId),
      getPumpSessions(stationId),
    ]);
    const mayConfigure = can('pump.create', { stationId });
    const myPumps = filterMyPumps(pumps);

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

    const mayLog = can('shift.create', { stationId });
    const hint = hasPumpRestriction()
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

    pumpContext = { stationId, pumps: myPumps, rateMap, sessions };
    paintPumpBoard();
    startSessionWatch(stationId);
  } catch (err) {
    console.error('Pumps render error:', err);
    content.innerHTML = emptyState('⚠️', formatFirebaseError(err));
  }
}

// Kept as the shared entry point for Dashboard's pump detail action.
export function openShiftForm(stationId, pump, rate, session = null) {
  if (session && isMine(session)) {
    openClockOutForm(stationId, pump, rate, session);
  } else {
    openClockInForm(stationId, pump, rate);
  }
}

function openClockInForm(stationId, pump, rate) {
  if (!can('pumpSession.start', { stationId, pumpId: pump.id }) || !canUsePump(pump.id)) {
    toast(canUsePump(pump.id) ? denyReason('shift.create', { stationId }) : 'This pump is not assigned to you.', 'error');
    return;
  }

  const rateLocked = !can('rate.update', { stationId });
  const missingRate = rateLocked && !rate;
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
          activeName: me.email || me.displayName || 'Staff member',
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
      toast(`Shift started on ${pump.name}.`, 'success');
      window.dispatchEvent(new CustomEvent('pumplog:dataChanged', { detail: { stationId } }));
    } catch (err) {
      console.error('Clock-in error:', err);
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

function openClockOutForm(stationId, pump, rate, session) {
  const me = getCurrentUserData();
  if (!session || session.activeUid !== me?.uid) {
    toast('This shift is no longer assigned to you. The pump status was refreshed.', 'error');
    return;
  }
  if (!can('pumpSession.end', { stationId, pumpId: pump.id }) || !canUsePump(pump.id)) {
    toast(denyReason('pumpSession.end', { stationId }), 'error');
    return;
  }

  const rateLocked = !can('rate.update', { stationId });
  const missingRate = rateLocked && !rate;
  const opening = Number(session.opening);
  document.getElementById('modal-title').textContent = `End shift — ${pump.name}`;
  document.getElementById('modal-body').innerHTML = `
    <form id="clock-out-form" novalidate>
      <div class="session-reference" role="status">
        <strong>Started ${h(formatTimeAgo(session.clockInAt) || formatDateTime(session.clockInAt) || 'just now')}</strong>
        <span>Opening reading: ${Number.isFinite(opening) ? opening.toFixed(2) : '—'}</span>
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
      <p class="form-error ${missingRate ? '' : 'hidden'}" id="clock-out-error" role="alert">${missingRate
        ? 'No rate configured — a manager or admin must set one first.' : ''}</p>
      <button type="submit" class="btn btn-danger btn-full mt-16" ${missingRate ? 'disabled' : ''}>End shift</button>
    </form>`;
  openModal('generic-modal');

  const read = id => Number(document.getElementById(id).value);
  const compute = () => {
    const closing = read('clock-out-closing');
    const rateValue = read('clock-out-rate');
    const volume = Number.isFinite(closing) && Number.isFinite(opening) ? Math.max(0, closing - opening) : 0;
    document.getElementById('clock-out-volume').textContent = formatVolume(volume);
    document.getElementById('clock-out-sales').textContent = formatCurrency(volume * (Number.isFinite(rateValue) ? rateValue : 0));
  };
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

    const sessionRef = doc(getDb(), 'stations', stationId, 'pumpSessions', pump.id);
    const meNow = getCurrentUserData();
    try {
      await runTransaction(getDb(), async transaction => {
        const snapshot = await transaction.get(sessionRef);
        const current = snapshot.exists() ? snapshot.data() : null;
        if (!current || current.status !== 'active' || current.activeUid !== meNow.uid) {
          const released = new Error('This pump session changed before it could be ended.');
          released.code = 'session-released';
          throw released;
        }
        const clockInDate = current.clockInAt && typeof current.clockInAt.toDate === 'function'
          ? current.clockInAt.toDate() : null;
        const hoursWorked = clockInDate
          ? Math.round(Math.max(0, Date.now() - clockInDate.getTime()) / 3600000 * 100) / 100
          : 0;
        const volume = closing - Number(current.opening);
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
          sales: volume * finalRate,
          createdBy: meNow.uid,
          staffUid: meNow.uid,
          staffName: meNow.email || meNow.displayName || 'Staff member',
          clockInAt: current.clockInAt || null,
          clockOutAt: serverTimestamp(),
          hoursWorked,
          createdAt: serverTimestamp(),
        });
        transaction.update(sessionRef, {
          status: 'idle',
          activeUid: null,
          activeName: null,
          clockInAt: null,
          opening: null,
          date: null,
          shiftLabel: null,
          updatedAt: serverTimestamp(),
          updatedBy: meNow.uid,
        });
      });
      invalidateStation(stationId);
      closeModal('generic-modal');
      const volume = closing - opening;
      toast(`Shift ended — ${formatVolume(volume)} · ${formatCurrency(volume * finalRate)}`, 'success');
      window.dispatchEvent(new CustomEvent('pumplog:dataChanged', { detail: { stationId } }));
    } catch (err) {
      console.error('Clock-out error:', err);
      if (err.code === 'session-released') fail('This pump session is no longer yours. It may have been force-released by an admin.');
      else fail(formatFirebaseError(err));
      setBusy(button, false);
    }
  });
}
