/* PumpLog — Pumps Page (manage nozzles + shift entry) */

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
import { getCurrentUserData, isSuperAdmin, isStationAdmin } from './auth.js';
import {
  formatCurrency, formatVolume, formatDateTime, getTodayDate,
  openModal, closeModal, showGenericModal, emptyState
} from './components.js';

let db = null;
let currentStationId = null;

export function initPumps(firestore) {
  db = firestore;
}

// ── Render ──────────────────────────────────────────────────────────────
export async function renderPumps(stationId) {
  currentStationId = stationId;
  if (!stationId) {
    document.getElementById('page-content').innerHTML = emptyState('⛽', 'Select a station first.');
    return;
  }

  const userData = getCurrentUserData();
  const canEdit = isSuperAdmin() || isStationAdmin();

  try {
    const pumpsQ = query(
      collection(db, 'stations', stationId, 'pumps'),
      orderBy('name')
    );
    const snap = await getDocs(pumpsQ);
    const pumps = [];
    snap.forEach(d => pumps.push({ id: d.id, ...d.data() }));

    let html = `
      <div class="flex items-center justify-between mb-16">
        <div class="section-title" style="margin-bottom:0;">Pumps / Nozzles</div>
        ${canEdit ? '<button id="add-pump-btn" class="btn btn-primary btn-small">+ Add Pump</button>' : ''}
      </div>
    `;

    if (pumps.length === 0) {
      html += emptyState('⛽', 'No pumps yet. Add your first pump!');
    } else {
      pumps.forEach(p => {
        html += `
          <div class="card-row" data-pump-id="${p.id}" data-pump-name="${p.name}" data-pump-product="${p.product || ''}">
            <div class="card-row-left">⛽</div>
            <div class="card-row-body">
              <div class="card-row-title">${p.name}</div>
              <div class="card-row-meta">${p.product || 'No product set'}</div>
            </div>
            <div class="card-row-right">
              <div style="font-size:12px;color:var(--text-muted);">Tap to log shift</div>
            </div>
          </div>
        `;
      });
    }

    document.getElementById('page-content').innerHTML = html;

    // Attach click handlers
    document.querySelectorAll('.card-row[data-pump-id]').forEach(el => {
      el.addEventListener('click', () => {
        openShiftForm(el.dataset.pumpId, el.dataset.pumpName, el.dataset.pumpProduct);
      });
    });

    document.getElementById('add-pump-btn')?.addEventListener('click', () => {
      showAddPumpForm();
    });

  } catch (err) {
    console.error('Pumps render error:', err);
    document.getElementById('page-content').innerHTML = emptyState('⚠️', 'Error loading pumps.');
  }
}

// ── Shift Entry Form ────────────────────────────────────────────────────
async function openShiftForm(pumpId, pumpName, pumpProduct) {
  // Fetch current rates for this station
  const ratesQ = query(
    collection(db, 'stations', currentStationId, 'rates'),
    orderBy('effectiveDate', 'desc')
  );
  const ratesSnap = await getDocs(ratesQ);
  const rates = [];
  ratesSnap.forEach(d => rates.push({ id: d.id, ...d.data() }));

  // Group rates by product, latest effective
  const rateMap = {};
  rates.forEach(r => {
    if (!rateMap[r.product] || r.effectiveDate > rateMap[r.product].effectiveDate) {
      rateMap[r.product] = r;
    }
  });

  const today = getTodayDate();

  const bodyHTML = `
    <form id="shift-form">
      <input type="hidden" id="shift-pump-id" value="${pumpId}" />
      <div class="field">
        <label>Nozzle / Pump</label>
        <input type="text" value="${pumpName}" disabled style="background:var(--border);" />
      </div>
      <div class="field">
        <label>Product</label>
        <input type="text" id="shift-product" value="${pumpProduct || ''}" disabled style="background:var(--border);" />
      </div>
      <div class="form-row">
        <div class="field">
          <label for="shift-date">Date</label>
          <input type="date" id="shift-date" value="${today}" required />
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
          <label for="shift-opening">Opening Reading</label>
          <input type="number" id="shift-opening" step="0.01" min="0" placeholder="0.0" required />
        </div>
        <div class="field">
          <label for="shift-closing">Closing Reading</label>
          <input type="number" id="shift-closing" step="0.01" min="0" placeholder="0.0" required />
        </div>
      </div>
      <div class="field">
        <label for="shift-rate">Applicable Rate (₹/L)</label>
        <input type="number" id="shift-rate" step="0.01" min="0" placeholder="Auto from latest rate" />
        <small style="color:var(--text-muted);font-size:11px;">
          Latest rate for ${pumpProduct || 'this product'}: ${pumpProduct && rateMap[pumpProduct] ? formatCurrency(rateMap[pumpProduct].rate) : 'N/A'}
        </small>
      </div>

      <div class="computed-row">
        <span class="label">Volume</span>
        <span class="value" id="computed-volume">0.0 L</span>
      </div>
      <div class="computed-row">
        <span class="label">Sale Amount</span>
        <span class="value green" id="computed-sales">₹0.00</span>
      </div>

      <button type="submit" class="btn btn-primary btn-full mt-16">Save Shift Record</button>
    </form>
  `;

  document.getElementById('modal-title').textContent = `Log Reading — ${pumpName}`;
  document.getElementById('modal-body').innerHTML = bodyHTML;
  openModal('generic-modal');

  // Auto-fill rate if we have one
  const rateField = document.getElementById('shift-rate');
  if (pumpProduct && rateMap[pumpProduct]) {
    rateField.value = rateMap[pumpProduct].rate;
  }

  // Live computation
  function compute() {
    const opening = parseFloat(document.getElementById('shift-opening').value) || 0;
    const closing = parseFloat(document.getElementById('shift-closing').value) || 0;
    const rate = parseFloat(document.getElementById('shift-rate').value) || 0;
    const volume = Math.max(0, closing - opening);
    const sales = volume * rate;

    document.getElementById('computed-volume').textContent = formatVolume(volume);
    document.getElementById('computed-sales').textContent = formatCurrency(sales);
  }

  ['shift-opening', 'shift-closing', 'shift-rate'].forEach(id => {
    document.getElementById(id).addEventListener('input', compute);
  });

  // Submit
  document.getElementById('shift-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const opening = parseFloat(document.getElementById('shift-opening').value) || 0;
    const closing = parseFloat(document.getElementById('shift-closing').value) || 0;
    const volume = Math.max(0, closing - opening);
    const rate = parseFloat(document.getElementById('shift-rate').value) || 0;
    const sales = volume * rate;

    const data = {
      pumpId,
      pumpName,
      product: pumpProduct || '',
      date: document.getElementById('shift-date').value,
      shiftLabel: document.getElementById('shift-label').value,
      opening,
      closing,
      volume,
      rate,
      sales,
      createdBy: getCurrentUserData()?.uid || 'unknown',
      createdAt: serverTimestamp(),
    };

    try {
      await addDoc(collection(db, 'stations', currentStationId, 'shifts'), data);
      closeModal('generic-modal');
      renderPumps(currentStationId);
    } catch (err) {
      console.error('Shift save error:', err);
      alert('Failed to save shift record.');
    }
  });
}

// ── Add Pump Form ───────────────────────────────────────────────────────
function showAddPumpForm() {
  const bodyHTML = `
    <form id="pump-form">
      <div class="field">
        <label for="pump-name">Pump / Nozzle Name</label>
        <input type="text" id="pump-name" placeholder="e.g. Pump 1, Nozzle A" required />
      </div>
      <div class="field">
        <label for="pump-product">Product</label>
        <select id="pump-product" required>
          <option value="">Select product…</option>
          <option value="MS">MS (Motor Spirit / Petrol)</option>
          <option value="HSD">HSD (High Speed Diesel)</option>
          <option value="CNG">CNG</option>
          <option value="LPG">LPG</option>
          <option value="Other">Other</option>
        </select>
      </div>
      <div class="form-row" style="grid-template-columns:1fr 1fr;gap:8px;margin-top:16px;">
        <button type="submit" class="btn btn-primary btn-full">Save</button>
        <button type="button" class="btn btn-secondary btn-full" id="pump-cancel">Cancel</button>
      </div>
    </form>
  `;

  document.getElementById('modal-title').textContent = 'Add Pump';
  document.getElementById('modal-body').innerHTML = bodyHTML;
  openModal('generic-modal');

  document.getElementById('pump-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = document.getElementById('pump-name').value.trim();
    const product = document.getElementById('pump-product').value;

    if (!name || !product) return;

    try {
      await addDoc(collection(db, 'stations', currentStationId, 'pumps'), { name, product });
      closeModal('generic-modal');
      renderPumps(currentStationId);
    } catch (err) {
      console.error('Add pump error:', err);
      alert('Failed to add pump.');
    }
  });

  document.getElementById('pump-cancel').addEventListener('click', () => closeModal('generic-modal'));
}
