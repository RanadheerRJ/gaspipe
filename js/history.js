/* PumpLog — History / Reports Page */

import {
  collection,
  doc,
  getDoc,
  getDocs,
  addDoc,
  updateDoc,
  deleteDoc,
  query,
  orderBy,
  where,
  limit,
  serverTimestamp,
} from './firebase.js';
import { getCurrentUserData, isSuperAdmin, isStationAdmin, isStaff } from './auth.js';
import {
  formatCurrency, formatVolume, formatDate, formatDateTime, getTodayDate,
  openModal, closeModal, showGenericModal, emptyState
} from './components.js';

let db = null;
let currentStationId = null;

export function initHistory(firestore) {
  db = firestore;
}

// ── Render ──────────────────────────────────────────────────────────────
export async function renderHistory(stationId) {
  currentStationId = stationId;
  if (!stationId) {
    document.getElementById('page-content').innerHTML = emptyState('📋', 'Select a station to view history.');
    return;
  }

  const userData = getCurrentUserData();
  const canEdit = isSuperAdmin() || isStationAdmin();

  try {
    // Fetch pumps for filter
    const pumpsSnap = await getDocs(query(collection(db, 'stations', stationId, 'pumps'), orderBy('name')));
    const pumps = [];
    pumpsSnap.forEach(d => pumps.push({ id: d.id, name: d.data().name }));

    // Fetch shifts
    const shiftsQ = query(
      collection(db, 'stations', stationId, 'shifts'),
      orderBy('date', 'desc'),
      orderBy('createdAt', 'desc'),
      limit(200)
    );
    const shiftsSnap = await getDocs(shiftsQ);
    const shifts = [];
    shiftsSnap.forEach(d => shifts.push({ id: d.id, ...d.data() }));

    // Build filter HTML
    let filterHTML = `
      <div class="filter-bar">
        <input type="date" id="filter-date-from" />
        <input type="date" id="filter-date-to" />
        <select id="filter-pump">
          <option value="">All Pumps</option>
          ${pumps.map(p => `<option value="${p.id}">${p.name}</option>`).join('')}
        </select>
        <select id="filter-shift">
          <option value="">All Shifts</option>
          <option value="1">Shift 1</option>
          <option value="2">Shift 2</option>
          <option value="3">Shift 3</option>
        </select>
        <button id="export-csv-btn" class="btn btn-secondary btn-small" style="flex:0;">CSV</button>
      </div>
    `;

    let html = `
      <div class="flex items-center justify-between mb-16">
        <div class="section-title" style="margin-bottom:0;">Shift History</div>
      </div>
      ${filterHTML}
      <div id="history-list">
    `;

    if (shifts.length === 0) {
      html += emptyState('📋', 'No shift records yet.');
    } else {
      // Group by date
      const grouped = {};
      shifts.forEach(s => {
        const key = s.date || 'unknown';
        if (!grouped[key]) grouped[key] = [];
        grouped[key].push(s);
      });

      const sortedDates = Object.keys(grouped).sort((a, b) => b.localeCompare(a));

      sortedDates.forEach(date => {
        const dayShifts = grouped[date];
        let dayTotal = 0;
        dayShifts.forEach(s => { dayTotal += Number(s.sales) || 0; });

        html += `<div class="date-group" data-date="${date}">
          <div class="date-header">
            <span>${formatDate(date)}</span>
            <span>${formatCurrency(dayTotal)}</span>
          </div>
        `;

        dayShifts.forEach(s => {
          const shiftBadge = s.shiftLabel ? `S${s.shiftLabel}` : '?';
          html += `
            <div class="shift-record" data-id="${s.id}">
              <div class="pump-name">${s.pumpName || 'Pump'}</div>
              <div class="shift-badge">${shiftBadge}</div>
              <div class="shift-details">
                ${formatVolume(s.volume)} · ${formatCurrency(s.rate, '₹')}/L
              </div>
              <div class="shift-amount">${formatCurrency(s.sales)}</div>
              ${canEdit ? `
                <div class="shift-actions">
                  <button class="icon-btn edit-shift" data-id="${s.id}" title="Edit">✏️</button>
                  <button class="icon-btn delete-shift" data-id="${s.id}" title="Delete">🗑️</button>
                </div>
              ` : ''}
            </div>
          `;
        });

        html += `</div>`;
      });
    }

    html += `</div>`;
    document.getElementById('page-content').innerHTML = html;

    // ── Filter logic ──────────────────────────────────────────────
    async function renderFilteredShifts(from, to, pumpId, shiftLabel) {
      const constraints = [orderBy('date', 'desc'), orderBy('createdAt', 'desc'), limit(200)];
      if (from) constraints.unshift(where('date', '>=', from));
      if (to) {
        const toDate = to;
        constraints.unshift(where('date', '<=', toDate));
      }
      if (pumpId) constraints.unshift(where('pumpId', '==', pumpId));
      if (shiftLabel) constraints.unshift(where('shiftLabel', '==', shiftLabel));

      try {
        const q = query(collection(db, 'stations', stationId, 'shifts'), ...constraints);
        const snap = await getDocs(q);
        const filtered = [];
        snap.forEach(d => filtered.push({ id: d.id, ...d.data() }));

        renderShiftList(filtered, canEdit);
      } catch (err) {
        // If composite index not ready, fall back to client-side filtering
        console.warn('Filter query failed, using client-side filter:', err);
        applyClientSideFilter(from, to, pumpId, shiftLabel);
      }
    }

    function applyClientSideFilter(from, to, pumpId, shiftLabel) {
      // Re-render from the full shifts list with client-side filtering
      let filtered = [...shifts];
      if (from) filtered = filtered.filter(s => s.date >= from);
      if (to) filtered = filtered.filter(s => s.date <= to);
      if (pumpId) filtered = filtered.filter(s => s.pumpId === pumpId);
      if (shiftLabel) filtered = filtered.filter(s => s.shiftLabel === shiftLabel);
      renderShiftList(filtered, canEdit);
    }

    function renderShiftList(list, canEdit) {
      const container = document.getElementById('history-list');
      if (list.length === 0) {
        container.innerHTML = emptyState('📋', 'No records match your filters.');
        return;
      }

      const grouped = {};
      list.forEach(s => {
        const key = s.date || 'unknown';
        if (!grouped[key]) grouped[key] = [];
        grouped[key].push(s);
      });
      const sortedDates = Object.keys(grouped).sort((a, b) => b.localeCompare(a));

      let html = '';
      sortedDates.forEach(date => {
        const dayShifts = grouped[date];
        let dayTotal = 0;
        dayShifts.forEach(s => { dayTotal += Number(s.sales) || 0; });

        html += `<div class="date-group" data-date="${date}">
          <div class="date-header">
            <span>${formatDate(date)}</span>
            <span>${formatCurrency(dayTotal)}</span>
          </div>
        `;

        dayShifts.forEach(s => {
          const shiftBadge = s.shiftLabel ? `S${s.shiftLabel}` : '?';
          html += `
            <div class="shift-record" data-id="${s.id}">
              <div class="pump-name">${s.pumpName || 'Pump'}</div>
              <div class="shift-badge">${shiftBadge}</div>
              <div class="shift-details">
                ${formatVolume(s.volume)} · ${formatCurrency(s.rate, '₹')}/L
              </div>
              <div class="shift-amount">${formatCurrency(s.sales)}</div>
              ${canEdit ? `
                <div class="shift-actions">
                  <button class="icon-btn edit-shift" data-id="${s.id}" title="Edit">✏️</button>
                  <button class="icon-btn delete-shift" data-id="${s.id}" title="Delete">🗑️</button>
                </div>
              ` : ''}
            </div>
          `;
        });

        html += `</div>`;
      });

      container.innerHTML = html;

      // Attach edit/delete handlers
      document.querySelectorAll('.edit-shift').forEach(btn => {
        btn.addEventListener('click', () => {
          const shiftData = list.find(s => s.id === btn.dataset.id);
          if (shiftData) showEditShiftForm(shiftData, stationId);
        });
      });

      document.querySelectorAll('.delete-shift').forEach(btn => {
        btn.addEventListener('click', async () => {
          if (confirm('Delete this shift record?')) {
            await deleteDoc(doc(db, 'stations', stationId, 'shifts', btn.dataset.id));
            renderHistory(stationId);
          }
        });
      });
    }

    // Initial attach of edit/delete handlers (for un-filtered view)
    document.querySelectorAll('.edit-shift').forEach(btn => {
      btn.addEventListener('click', () => {
        const shiftData = shifts.find(s => s.id === btn.dataset.id);
        if (shiftData) showEditShiftForm(shiftData, stationId);
      });
    });

    document.querySelectorAll('.delete-shift').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (confirm('Delete this shift record?')) {
          await deleteDoc(doc(db, 'stations', stationId, 'shifts', btn.dataset.id));
          renderHistory(stationId);
        }
      });
    });

    // Filter event listeners (debounced)
    ['filter-date-from', 'filter-date-to', 'filter-pump', 'filter-shift'].forEach(id => {
      document.getElementById(id)?.addEventListener('change', () => {
        const from = document.getElementById('filter-date-from').value;
        const to = document.getElementById('filter-date-to').value;
        const pump = document.getElementById('filter-pump').value;
        const shift = document.getElementById('filter-shift').value;
        renderFilteredShifts(from, to, pump, shift);
      });
    });

    // CSV Export
    document.getElementById('export-csv-btn')?.addEventListener('click', () => {
      exportCSV(shifts);
    });

  } catch (err) {
    console.error('History render error:', err);
    document.getElementById('page-content').innerHTML = emptyState('⚠️', 'Error loading history.');
  }
}

// ── Edit Shift Form ─────────────────────────────────────────────────────
async function showEditShiftForm(shiftData, stationId) {
  const bodyHTML = `
    <form id="edit-shift-form">
      <input type="hidden" id="edit-shift-id" value="${shiftData.id}" />
      <div class="field">
        <label>Pump</label>
        <input type="text" value="${shiftData.pumpName || ''}" disabled style="background:var(--border);" />
      </div>
      <div class="form-row">
        <div class="field">
          <label for="edit-shift-date">Date</label>
          <input type="date" id="edit-shift-date" value="${shiftData.date || ''}" required />
        </div>
        <div class="field">
          <label for="edit-shift-label">Shift</label>
          <select id="edit-shift-label" required>
            <option value="1" ${shiftData.shiftLabel === '1' ? 'selected' : ''}>Shift 1</option>
            <option value="2" ${shiftData.shiftLabel === '2' ? 'selected' : ''}>Shift 2</option>
            <option value="3" ${shiftData.shiftLabel === '3' ? 'selected' : ''}>Shift 3</option>
          </select>
        </div>
      </div>
      <div class="form-row">
        <div class="field">
          <label for="edit-shift-opening">Opening</label>
          <input type="number" id="edit-shift-opening" step="0.01" value="${shiftData.opening || 0}" required />
        </div>
        <div class="field">
          <label for="edit-shift-closing">Closing</label>
          <input type="number" id="edit-shift-closing" step="0.01" value="${shiftData.closing || 0}" required />
        </div>
      </div>
      <div class="field">
        <label for="edit-shift-rate">Rate (₹/L)</label>
        <input type="number" id="edit-shift-rate" step="0.01" value="${shiftData.rate || 0}" required />
      </div>

      <div class="computed-row">
        <span class="label">Volume</span>
        <span class="value" id="edit-computed-volume">${formatVolume(shiftData.volume)}</span>
      </div>
      <div class="computed-row">
        <span class="label">Sale Amount</span>
        <span class="value green" id="edit-computed-sales">${formatCurrency(shiftData.sales)}</span>
      </div>

      <button type="submit" class="btn btn-primary btn-full mt-16">Update Record</button>
    </form>
  `;

  document.getElementById('modal-title').textContent = 'Edit Shift Record';
  document.getElementById('modal-body').innerHTML = bodyHTML;
  openModal('generic-modal');

  function compute() {
    const opening = parseFloat(document.getElementById('edit-shift-opening').value) || 0;
    const closing = parseFloat(document.getElementById('edit-shift-closing').value) || 0;
    const rate = parseFloat(document.getElementById('edit-shift-rate').value) || 0;
    const volume = Math.max(0, closing - opening);
    const sales = volume * rate;
    document.getElementById('edit-computed-volume').textContent = formatVolume(volume);
    document.getElementById('edit-computed-sales').textContent = formatCurrency(sales);
  }

  ['edit-shift-opening', 'edit-shift-closing', 'edit-shift-rate'].forEach(id => {
    document.getElementById(id).addEventListener('input', compute);
  });

  document.getElementById('edit-shift-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const opening = parseFloat(document.getElementById('edit-shift-opening').value) || 0;
    const closing = parseFloat(document.getElementById('edit-shift-closing').value) || 0;
    const volume = Math.max(0, closing - opening);
    const rate = parseFloat(document.getElementById('edit-shift-rate').value) || 0;
    const sales = volume * rate;

    try {
      await updateDoc(doc(db, 'stations', stationId, 'shifts', shiftData.id), {
        date: document.getElementById('edit-shift-date').value,
        shiftLabel: document.getElementById('edit-shift-label').value,
        opening,
        closing,
        volume,
        rate,
        sales,
      });
      closeModal('generic-modal');
      renderHistory(stationId);
    } catch (err) {
      console.error('Update shift error:', err);
      alert('Failed to update record.');
    }
  });
}

// ── CSV Export ──────────────────────────────────────────────────────────
function exportCSV(shifts) {
  const headers = ['Date', 'Pump', 'Product', 'Shift', 'Opening', 'Closing', 'Volume (L)', 'Rate (₹/L)', 'Sales (₹)', 'Created'];
  const rows = shifts.map(s => [
    s.date || '',
    s.pumpName || '',
    s.product || '',
    s.shiftLabel || '',
    s.opening || 0,
    s.closing || 0,
    (s.volume || 0).toFixed(1),
    (s.rate || 0).toFixed(2),
    (s.sales || 0).toFixed(2),
    formatDateTime(s.createdAt),
  ]);

  const csvContent = [
    headers.join(','),
    ...rows.map(r => r.map(c => `"${c}"`).join(','))
  ].join('\n');

  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `pumplog-shifts-${currentStationId}-${getTodayDate()}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}
