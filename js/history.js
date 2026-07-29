/* PumpLog — History / reports
 *
 * Part D: Shift approval workflow. Managers/admins can approve pending shifts
 * individually or in bulk (per day, per pump). History shows pending/approved/
 * rejected badges, and a status filter is available.
 */

import { getDb, doc, updateDoc, deleteDoc, writeBatch, serverTimestamp } from './firebase.js';
import { can, ifCan, getCurrentUserData, denyReason, formatFirebaseError } from './auth.js';
import { getPumps, getShifts, invalidateStation } from './store.js';
import {
  h, formatCurrency, formatVolume, formatDate, formatDateTime, getTodayDate,
  openModal, closeModal, emptyState, toastSuccess, toastError,
  confirmDelete, confirmSave, setBusy, showSkeleton,
  rangeStart, debounce, knownHours, ICONS,
} from './components.js';

let currentStationId = null;
let allShifts = [];
let currentRange = 'today';
let filteredShifts = [];
let currentStatusFilter = '';

export function initHistory() {}

function statusBadge(status) {
  if (status === 'pending') return '<span class="tag tag-pending">⏳ Pending</span>';
  if (status === 'approved') return '<span class="tag tag-approved">✅ Approved</span>';
  if (status === 'rejected') return '<span class="tag tag-rejected">❌ Rejected</span>';
  return '';
}

export async function renderHistory(stationId, range = 'today') {
  currentStationId = stationId;
  currentRange = range;
  const content = document.getElementById('page-content');

  if (!stationId) {
    content.innerHTML = emptyState('📋', 'Select a station to view its history.');
    return;
  }

  showSkeleton(4);

  try {
    const [pumps, shifts] = await Promise.all([
      getPumps(stationId),
      getShifts(stationId, { from: rangeStart(range) }),
    ]);
    allShifts = shifts;

    const mayApprove = can('shift.update', { stationId });

    content.innerHTML = `
      <div class="page-head">
        <h2 class="page-title">Shift history</h2>
        <button id="export-csv-btn" class="btn btn-secondary btn-small" ${shifts.length ? '' : 'disabled'}>
          Export CSV
        </button>
      </div>

      <div class="filter-bar" role="group" aria-label="Filter shift records">
        <div class="filter-field">
          <label for="filter-pump">Pump</label>
          <select id="filter-pump">
            <option value="">All pumps</option>
            ${pumps.map(p => `<option value="${h(p.id)}">${h(p.name)}</option>`).join('')}
          </select>
        </div>
        <div class="filter-field">
          <label for="filter-shift">Shift</label>
          <select id="filter-shift">
            <option value="">All shifts</option>
            <option value="1">Shift 1</option>
            <option value="2">Shift 2</option>
            <option value="3">Shift 3</option>
          </select>
        </div>
        ${ifCan('shift.update', { stationId }, `
        <div class="filter-field">
          <label for="filter-status">Approval</label>
          <select id="filter-status">
            <option value="">Show all</option>
            <option value="pending">⏳ Waiting</option>
            <option value="approved">✅ Approved</option>
            <option value="rejected">❌ Rejected</option>
          </select>
        </div>`)}
        <div class="filter-field">
          <label for="filter-search">Search</label>
          <input type="search" id="filter-search" placeholder="Pump or product" />
        </div>
      </div>

      <p id="history-summary" class="section-hint" aria-live="polite"></p>
      <div id="history-list"></div>
    `;

    const applyFilters = () => {
      const pumpId = document.getElementById('filter-pump').value;
      const shiftLabel = document.getElementById('filter-shift').value;
      const statusFilter = document.getElementById('filter-status')?.value || '';
      const term = document.getElementById('filter-search').value.trim().toLowerCase();

      currentStatusFilter = statusFilter;

      // Filtering happens in memory — instant, and no composite index needed.
      const filtered = allShifts.filter(s =>
        (!pumpId || s.pumpId === pumpId) &&
        (!shiftLabel || s.shiftLabel === shiftLabel) &&
        (!statusFilter || s.status === statusFilter) &&
        (!term ||
          (s.pumpName || '').toLowerCase().includes(term) ||
          (s.product || '').toLowerCase().includes(term))
      );
      paint(filtered);
    };

    document.getElementById('filter-pump').addEventListener('change', applyFilters);
    document.getElementById('filter-shift').addEventListener('change', applyFilters);
    document.getElementById('filter-status')?.addEventListener('change', applyFilters);
    document.getElementById('filter-search').addEventListener('input', debounce(applyFilters, 200));
    document.getElementById('export-csv-btn').addEventListener('click', () => exportCSV(filteredShifts));

    paint(allShifts);
  } catch (err) {
    content.innerHTML = emptyState('⚠️', formatFirebaseError(err));
  }
}

// ── List rendering ──────────────────────────────────────────────────────
function paint(list) {
  filteredShifts = list;
  const container = document.getElementById('history-list');
  const summary = document.getElementById('history-summary');
  if (!container) return;

  const total = list.reduce((sum, s) => sum + (Number(s.sales) || 0), 0);
  const volume = list.reduce((sum, s) => sum + (Number(s.volume) || 0), 0);
  const unknownHours = list.filter(s => knownHours(s) == null).length;
  const hours = list.reduce((sum, s) => sum + (knownHours(s) ?? 0), 0);
  if (summary) {
    summary.textContent = list.length
      ? `${list.length} record${list.length === 1 ? '' : 's'} · ${formatVolume(volume)} · ${formatCurrency(total)} · Hours: ${unknownHours ? '—' : `${hours.toFixed(2)} h`}${unknownHours ? ` (${unknownHours} older)` : ''}`
      : '';
  }

  if (list.length === 0) {
    container.innerHTML = emptyState('📋', 'No shift records match the current filters.');
    return;
  }

  const mayEdit = can('shift.update', { stationId: currentStationId });
  const mayDelete = can('shift.delete', { stationId: currentStationId });
  const mayApprove = can('shift.update', { stationId: currentStationId });

  const byDate = new Map();
  for (const s of list) {
    const key = s.date || 'Unknown date';
    if (!byDate.has(key)) byDate.set(key, []);
    byDate.get(key).push(s);
  }

  container.innerHTML = [...byDate.entries()]
    .sort((a, b) => b[0].localeCompare(a[0]))
    .map(([date, rows]) => {
      const dayTotal = rows.reduce((sum, s) => sum + (Number(s.sales) || 0), 0);
      const pendingCount = rows.filter(s => s.status === 'pending').length;
      const bulkApproveBtn = mayApprove && pendingCount > 0
        ? `<button class="btn btn-small btn-secondary bulk-approve-day" data-date="${h(date)}" title="Approve all ${pendingCount} pending shift${pendingCount === 1 ? '' : 's'} for ${h(formatDate(date) || date)}">
            ✅ Approve all (${pendingCount})
          </button>`
        : '';
      return `
        <section class="date-group">
          <h3 class="date-header">
            <span>${h(formatDate(date) || date)}</span>
            <span>${formatCurrency(dayTotal)} ${bulkApproveBtn}</span>
          </h3>
          ${rows.map(s => {
            const badge = statusBadge(s.status);
            const approvedNote = s.status === 'approved' && s.approvedBy
              ? `<small class="approved-by-note">Approved ${s.approvedAt ? formatDateTime(s.approvedAt) : ''}</small>`
              : '';
            return `
            <div class="shift-record ${s.status === 'pending' ? 'shift-pending' : ''} ${s.status === 'rejected' ? 'shift-rejected' : ''}">
              <span class="shift-badge">S${h(s.shiftLabel || '?')}</span>
              <span class="shift-main">
                <span class="pump-name">${h(s.pumpName || 'Pump')} ${badge} ${approvedNote}</span>
                <span class="shift-details">${formatVolume(s.volume)} · ${formatCurrency(s.rate)}/L · Hours: ${knownHours(s) == null ? '—' : h(Number(s.hoursWorked).toFixed(2) + ' h')}${s.clockInAt ? ` · In ${h(formatDateTime(s.clockInAt))}` : ''}</span>
                ${s.notes ? `<span class="shift-notes">📝 ${h(s.notes)}</span>` : ''}
                ${s.expensesTotal > 0 ? `<span class="shift-expenses">💰 Expenses: ${formatCurrency(s.expensesTotal)}${s.cashDue != null ? ` · Cash due: ${formatCurrency(s.cashDue)}` : ''}</span>` : ''}
              </span>
              <span class="shift-amount">${formatCurrency(s.sales)}</span>
              ${(mayEdit || mayDelete || (mayApprove && s.status === 'pending')) ? `<span class="shift-actions">
                ${s.status === 'pending' ? ifCan('shift.update', { stationId: currentStationId }, `<button class="btn btn-secondary btn-small approve-shift" data-id="${h(s.id)}">✅ Approve</button>`) : ''}
                ${ifCan('shift.update', { stationId: currentStationId }, `<button class="btn btn-secondary btn-small edit-shift" data-id="${h(s.id)}">✏️ Edit</button>`)}
                ${ifCan('shift.delete', { stationId: currentStationId }, `<button class="btn btn-secondary btn-small delete-shift danger-text" data-id="${h(s.id)}">🗑️ Delete</button>`)}
              </span>` : ''}
            </div>`;
          }).join('')}
        </section>
      `;
    }).join('');

  // Wire approve single
  container.querySelectorAll('.approve-shift').forEach(btn =>
    btn.addEventListener('click', () => {
      const s = allShifts.find(x => x.id === btn.dataset.id);
      if (s) approveShift(s, btn);
    }));

  // Wire bulk approve day
  container.querySelectorAll('.bulk-approve-day').forEach(btn =>
    btn.addEventListener('click', () => {
      const date = btn.dataset.date;
      const pending = allShifts.filter(s => s.date === date && s.status === 'pending');
      if (pending.length) bulkApproveShifts(pending, `all pending shifts for ${formatDate(date) || date}`);
    }));

  container.querySelectorAll('.edit-shift').forEach(btn =>
    btn.addEventListener('click', () => {
      const s = allShifts.find(x => x.id === btn.dataset.id);
      if (s) showEditShiftForm(s);
    }));

  container.querySelectorAll('.delete-shift').forEach(btn =>
    btn.addEventListener('click', () => {
      const s = allShifts.find(x => x.id === btn.dataset.id);
      if (s) removeShift(s);
    }));
}

// ── Approve single shift ───────────────────────────────────────────────
async function approveShift(shift, button = null) {
  if (!can('shift.update', { stationId: currentStationId })) {
    toastError(denyReason('shift.update'));
    return;
  }
  const ok = await confirmSave(`${shift.staffName || 'this staff member'}’s shift on ${shift.pumpName || 'this pump'}`);
  if (!ok) return;
  setBusy(button, true, 'Approving…');
  try {
    const me = getCurrentUserData();
    await updateDoc(doc(getDb(), 'stations', currentStationId, 'shifts', shift.id), {
      status: 'approved',
      approvedBy: me?.uid || 'unknown',
      approvedAt: serverTimestamp(),
    });
    invalidateStation(currentStationId);
    toastSuccess(`Shift approved — ${formatCurrency(shift.sales)}`);
    renderHistory(currentStationId, currentRange);
  } catch (err) {
    toastError(formatFirebaseError(err));
    setBusy(button, false);
  }
}

// ── Bulk approve shifts ────────────────────────────────────────────────
async function bulkApproveShifts(shifts, label) {
  if (!shifts.length) return;
  const ok = await confirmSave(`approving ${shifts.length} pending shift${shifts.length === 1 ? '' : 's'} (${label})`);
  if (!ok) return;
  try {
    const db = getDb();
    const batch = writeBatch(db);
    const me = getCurrentUserData();
    shifts.forEach(s => {
      const ref = doc(db, 'stations', currentStationId, 'shifts', s.id);
      batch.update(ref, {
        status: 'approved',
        approvedBy: me?.uid || 'unknown',
        approvedAt: serverTimestamp(),
      });
    });
    await batch.commit();
    invalidateStation(currentStationId);
    toastSuccess(`Approved ${shifts.length} shift${shifts.length === 1 ? '' : 's'}`);
    renderHistory(currentStationId, currentRange);
  } catch (err) {
    toastError(formatFirebaseError(err));
  }
}

// ── Edit ────────────────────────────────────────────────────────────────
function showEditShiftForm(shift) {
  if (!can('shift.update', { stationId: currentStationId })) {
    toastError(denyReason('shift.update'));
    return;
  }

  document.getElementById('modal-title').textContent = 'Edit shift record';
  document.getElementById('modal-body').innerHTML = `
    <form id="edit-shift-form" novalidate>
      <div class="field">
        <label for="edit-pump-name">Pump</label>
        <input type="text" id="edit-pump-name" value="${h(shift.pumpName || '')}" disabled />
      </div>
      <div class="form-row">
        <div class="field">
          <label for="edit-shift-date">Date</label>
          <input type="date" id="edit-shift-date" value="${h(shift.date || '')}" max="${getTodayDate()}" required />
        </div>
        <div class="field">
          <label for="edit-shift-label">Shift</label>
          <select id="edit-shift-label" required>
            ${['1', '2', '3'].map(v =>
              `<option value="${v}" ${shift.shiftLabel === v ? 'selected' : ''}>Shift ${v}</option>`).join('')}
          </select>
        </div>
      </div>
      <div class="form-row">
        <div class="field">
          <label for="edit-shift-opening">Opening</label>
          <input type="number" id="edit-shift-opening" step="0.01" min="0" inputmode="decimal"
                 value="${Number(shift.opening) || 0}" required />
        </div>
        <div class="field">
          <label for="edit-shift-closing">Closing</label>
          <input type="number" id="edit-shift-closing" step="0.01" min="0" inputmode="decimal"
                 value="${Number(shift.closing) || 0}" required />
        </div>
      </div>
      <div class="field">
        <label for="edit-shift-rate">Rate (₹/L)</label>
        <input type="number" id="edit-shift-rate" step="0.01" min="0" inputmode="decimal"
               value="${Number(shift.rate) || 0}" required />
      </div>

      <div class="computed-row">
        <span class="label">Volume</span>
        <output class="value" id="edit-computed-volume">${formatVolume(shift.volume)}</output>
      </div>
      <div class="computed-row">
        <span class="label">Sale amount</span>
        <output class="value green" id="edit-computed-sales">${formatCurrency(shift.sales)}</output>
      </div>

      <p class="form-error hidden" id="edit-shift-error" role="alert"></p>
      <button type="submit" class="btn btn-primary btn-full mt-16">Save ${ICONS.save}</button>
    </form>
  `;
  openModal('generic-modal');

  const $ = id => document.getElementById(id);
  const read = id => parseFloat($(id).value) || 0;

  function compute() {
    const volume = Math.max(0, read('edit-shift-closing') - read('edit-shift-opening'));
    $('edit-computed-volume').textContent = formatVolume(volume);
    $('edit-computed-sales').textContent = formatCurrency(volume * read('edit-shift-rate'));
  }
  ['edit-shift-opening', 'edit-shift-closing', 'edit-shift-rate'].forEach(id =>
    $(id).addEventListener('input', compute));

  $('edit-shift-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.currentTarget.querySelector('button[type="submit"]');
    const err = $('edit-shift-error');
    const fail = (msg) => { err.textContent = msg; err.classList.remove('hidden'); };

    const opening = read('edit-shift-opening');
    const closing = read('edit-shift-closing');
    const rate = read('edit-shift-rate');
    const date = $('edit-shift-date').value;

    if (!date) return fail('Choose a date.');
    if (closing < opening) return fail('Closing reading cannot be lower than the opening reading.');
    if (rate <= 0) return fail('Enter a rate greater than zero.');

    err.classList.add('hidden');
    if (!(await confirmSave('this shift record'))) return;
    setBusy(btn, true, 'Saving…');
    const volume = closing - opening;

    try {
      await updateDoc(doc(getDb(), 'stations', currentStationId, 'shifts', shift.id), {
        date,
        shiftLabel: $('edit-shift-label').value,
        opening, closing, volume, rate,
        sales: volume * rate,
        updatedAt: serverTimestamp(),
      });
      invalidateStation(currentStationId);
      closeModal('generic-modal');
      toastSuccess('Changes Saved');
      renderHistory(currentStationId, currentRange);
    } catch (e2) {
      fail(`❌ ${formatFirebaseError(e2)}`);
      setBusy(btn, false);
    }
  });
}

// ── Delete ──────────────────────────────────────────────────────────────
async function removeShift(shift) {
  if (!can('shift.delete', { stationId: currentStationId })) {
    toastError(denyReason('shift.delete'));
    return;
  }

  const ok = await confirmDelete(`${shift.pumpName || 'Pump'} · Shift ${shift.shiftLabel || '?'} on ${formatDate(shift.date)} (${formatCurrency(shift.sales)}) will be permanently deleted.`);
  if (!ok) return;

  try {
    await deleteDoc(doc(getDb(), 'stations', currentStationId, 'shifts', shift.id));
    invalidateStation(currentStationId);
    toastSuccess('Shift Record Deleted');
    renderHistory(currentStationId, currentRange);
  } catch (err) {
    toastError(formatFirebaseError(err));
  }
}

// ── CSV export ──────────────────────────────────────────────────────────
function exportCSV(shifts) {
  if (!shifts.length) return;

  const headers = ['Date', 'Pump', 'Product', 'Shift', 'Opening', 'Closing', 'Volume (L)', 'Rate', 'Sales', 'Status', 'Recorded'];
  const cell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;

  const csv = [
    headers.map(cell).join(','),
    ...shifts.map(s => [
      s.date, s.pumpName, s.product, s.shiftLabel,
      s.opening, s.closing,
      (Number(s.volume) || 0).toFixed(2),
      (Number(s.rate) || 0).toFixed(2),
      (Number(s.sales) || 0).toFixed(2),
      s.status || '',
      formatDateTime(s.createdAt),
    ].map(cell).join(',')),
  ].join('\\r\\n');

  // BOM keeps ₹ and other non-ASCII characters readable in Excel.
  const blob = new Blob(['\\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `pumplog-shifts-${getTodayDate()}.csv`;
  a.click();
  URL.revokeObjectURL(url);
  toastSuccess(`Exported ${shifts.length} record${shifts.length === 1 ? '' : 's'}`);
}
