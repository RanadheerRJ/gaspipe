/* PumpLog — Pumps page (nozzle list + shift entry) */

import { getDb, collection, addDoc, serverTimestamp } from './firebase.js';
import {
  getCurrentUserData, can, denyReason, formatFirebaseError,
  hasPumpRestriction, canUsePump, filterMyPumps,
} from './auth.js';
import { getPumps, getCurrentRateMap, invalidateStation } from './store.js';
import {
  h, formatCurrency, formatVolume, getTodayDate,
  openModal, closeModal, emptyState, toast, setBusy, showSkeleton,
} from './components.js';

let currentStationId = null;

export function initPumps() {}

export async function renderPumps(stationId) {
  currentStationId = stationId;
  const content = document.getElementById('page-content');

  if (!stationId) {
    content.innerHTML = emptyState('⛽', 'Select a station to see its pumps.');
    return;
  }

  showSkeleton(3);

  try {
    const [pumps, rateMap] = await Promise.all([
      getPumps(stationId),
      getCurrentRateMap(stationId),
    ]);

    const mayLog = can('shift.create', { stationId });
    const mayConfigure = can('pump.create', { stationId });

    if (pumps.length === 0) {
      content.innerHTML = `
        <h2 class="page-title">Pumps</h2>
        ${emptyState('⛽', mayConfigure
          ? 'No pumps yet. Add them from Config → Pumps.'
          : 'No pumps configured yet. Ask your station admin to add them.')}
      `;
      return;
    }

    // Staff see only the pumps an admin/manager assigned to them.
    const myPumps = filterMyPumps(pumps);

    if (myPumps.length === 0) {
      content.innerHTML = `
        <h2 class="page-title">Pumps</h2>
        ${emptyState('🔒', 'No pumps are assigned to you at this station. Ask your admin or manager to assign pumps from Config → Team.')}
      `;
      return;
    }

    const rows = myPumps.map(p => {
      const rate = rateMap[p.product];
      const rateText = rate ? `${formatCurrency(rate.rate)}/L` : 'No rate set';
      return `
        <li>
          <button class="card-row" data-pump-id="${h(p.id)}" ${mayLog ? '' : 'disabled'}
                  ${mayLog ? '' : `title="${h(denyReason('shift.create'))}"`}>
            <span class="card-row-left" aria-hidden="true">⛽</span>
            <span class="card-row-body">
              <span class="card-row-title">${h(p.name)}</span>
              <span class="card-row-meta">${h(p.product || 'No product')} · ${h(rateText)}</span>
            </span>
            <span class="card-row-right">${mayLog ? 'Log reading →' : 'View only'}</span>
          </button>
        </li>
      `;
    }).join('');

    const hint = hasPumpRestriction()
      ? `Showing the ${myPumps.length} pump${myPumps.length === 1 ? '' : 's'} assigned to you. Tap one to log a reading.`
      : mayLog ? 'Tap a pump to log a shift reading.' : 'You have read-only access.';

    content.innerHTML = `
      <h2 class="page-title">Pumps</h2>
      <p class="section-hint">${h(hint)}</p>
      <ul class="plain-list">${rows}</ul>
    `;

    if (mayLog) {
      content.querySelectorAll('.card-row[data-pump-id]').forEach(btn => {
        btn.addEventListener('click', () => {
          const pump = myPumps.find(p => p.id === btn.dataset.pumpId);
          if (pump) openShiftForm(stationId, pump, rateMap[pump.product]);
        });
      });
    }
  } catch (err) {
    console.error('Pumps render error:', err);
    content.innerHTML = emptyState('⚠️', formatFirebaseError(err));
  }
}

// ── Shift entry ─────────────────────────────────────────────────────────
// Exported so the dashboard live feed can open the same form for a pump.
export function openShiftForm(stationId, pump, rate) {
  if (!can('shift.create', { stationId })) {
    toast(denyReason('shift.create'), 'error');
    return;
  }
  if (!canUsePump(pump.id)) {
    toast('This pump is not assigned to you. Contact your admin or manager.', 'error');
    return;
  }

  // Rates are controlled by Managers/Admins only — staff log against the
  // configured rate and cannot override it.
  const rateLocked = !can('rate.update', { stationId });
  const missingRate = rateLocked && !rate;

  document.getElementById('modal-title').textContent = `Log reading — ${pump.name}`;
  document.getElementById('modal-body').innerHTML = `
    <form id="shift-form" novalidate>
      <div class="form-row">
        <div class="field">
          <label for="shift-date">Date</label>
          <input type="date" id="shift-date" value="${getTodayDate()}" max="${getTodayDate()}" required />
        </div>
        <div class="field">
          <label for="shift-label">Shift</label>
          <select id="shift-label" required>
            <option value="1">Shift 1</option>
            <option value="2">Shift 2</option>
            <option value="3">Shift 3</option>
          </select>
        </div>
      </div>
      <div class="form-row">
        <div class="field">
          <label for="shift-opening">Opening reading</label>
          <input type="number" id="shift-opening" step="0.01" min="0" inputmode="decimal" placeholder="0.00" required />
        </div>
        <div class="field">
          <label for="shift-closing">Closing reading</label>
          <input type="number" id="shift-closing" step="0.01" min="0" inputmode="decimal" placeholder="0.00" required />
        </div>
      </div>
      <div class="field">
        <label for="shift-rate">Rate (₹/L)</label>
        <input type="number" id="shift-rate" step="0.01" min="0" inputmode="decimal"
               value="${rate?.rate ?? ''}" placeholder="Enter rate" required
               ${rateLocked ? 'readonly aria-readonly="true" class="input-locked"' : ''} />
        <small class="hint">${rateLocked
          ? (rate
              ? `Rate is set by your manager/admin — currently ${formatCurrency(rate.rate)}/L for ${h(pump.product)}.`
              : `No rate configured for ${h(pump.product || 'this product')} yet. A manager or admin must add one before you can log readings.`)
          : (rate
              ? `Current ${h(pump.product)} rate: ${formatCurrency(rate.rate)}/L`
              : `No rate configured for ${h(pump.product || 'this product')} — enter one manually.`)}</small>
      </div>

      <div class="computed-row">
        <span class="label">Volume</span>
        <output class="value" id="computed-volume" for="shift-opening shift-closing">0.0 L</output>
      </div>
      <div class="computed-row">
        <span class="label">Sale amount</span>
        <output class="value green" id="computed-sales" for="shift-opening shift-closing shift-rate">₹0.00</output>
      </div>

      <p class="form-error ${missingRate ? '' : 'hidden'}" id="shift-form-error" role="alert">${missingRate
        ? 'No rate is configured for this product. Ask your manager or admin to set one in Config → Rates.' : ''}</p>
      <button type="submit" class="btn btn-primary btn-full mt-16" ${missingRate ? 'disabled' : ''}>Save shift record</button>
    </form>
  `;
  openModal('generic-modal');

  const $ = id => document.getElementById(id);
  const read = id => parseFloat($(id).value) || 0;

  function compute() {
    const volume = Math.max(0, read('shift-closing') - read('shift-opening'));
    $('computed-volume').textContent = formatVolume(volume);
    $('computed-sales').textContent = formatCurrency(volume * read('shift-rate'));
  }
  ['shift-opening', 'shift-closing', 'shift-rate'].forEach(id =>
    $(id).addEventListener('input', compute));

  $('shift-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.currentTarget.querySelector('button[type="submit"]');
    const err = $('shift-form-error');

    const opening = read('shift-opening');
    const closing = read('shift-closing');
    const rateValue = read('shift-rate');
    const date = $('shift-date').value;

    const fail = (msg) => { err.textContent = msg; err.classList.remove('hidden'); };

    if (rateLocked && !rate) return fail('No rate configured — a manager or admin must set one first.');
    if (!date) return fail('Choose a date.');
    if (closing < opening) return fail('Closing reading cannot be lower than the opening reading.');
    if (closing === opening) return fail('Opening and closing readings are identical — volume would be zero.');
    if (rateValue <= 0) return fail('Enter a rate greater than zero.');
    // Staff always bill at the configured rate, never at a typed-in value.
    const finalRate = rateLocked ? Number(rate.rate) : rateValue;

    err.classList.add('hidden');
    setBusy(btn, true, 'Saving…');

    const volume = closing - opening;

    try {
      await addDoc(collection(getDb(), 'stations', stationId, 'shifts'), {
        pumpId: pump.id,
        pumpName: pump.name,
        product: pump.product || '',
        date,
        shiftLabel: $('shift-label').value,
        opening, closing, volume,
        rate: finalRate,
        sales: volume * finalRate,
        createdBy: getCurrentUserData()?.uid || 'unknown',
        createdAt: serverTimestamp(),
      });

      invalidateStation(stationId);
      closeModal('generic-modal');
      toast(`Shift saved — ${formatVolume(volume)} · ${formatCurrency(volume * finalRate)}`, 'success');
      // The app shell re-renders whatever page is open (Pumps or Dashboard).
      window.dispatchEvent(new CustomEvent('pumplog:dataChanged', { detail: { stationId } }));
    } catch (e2) {
      console.error('Shift save error:', e2);
      fail(formatFirebaseError(e2));
      setBusy(btn, false);
    }
  });
}
