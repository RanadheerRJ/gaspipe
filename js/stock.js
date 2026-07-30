/* PumpLog — Fuel stock (inventory) tracking — Spark plan, no Functions
 *
 * Each station keeps a `stations/{id}/stock/current` document that tracks
 * per-product fuel levels and a `stations/{id}/stockLog` subcollection for
 * each adjustment (delivery/dip/test). The dashboard surfaces a small
 * "Stock on hand" card; Config → Fuel stock lets managers edit levels and
 * log deliveries. No backend or composite indexes required.
 */

import {
  getDb, doc, collection, getDoc, getDocs, setDoc, addDoc, query, orderBy, limit,
  serverTimestamp,
} from './firebase.js';
import { getCurrentUserData, can, formatFirebaseError } from './auth.js';
import {
  h, openModal, closeModal, emptyState, toastSuccess, toastError, setBusy,
  formatVolume, formatDate, formatDateTime, ICONS,
} from './components.js';
import { invalidateStation } from './store.js';

const CACHE_TTL = 30_000;
const cache = new Map();

function key(stationId) { return `stock:${stationId}`; }

export function invalidateStock(stationId = null) {
  if (!stationId) cache.clear();
  else cache.delete(key(stationId));
}

export async function getStock(stationId) {
  if (!stationId) return { levels: {}, updatedAt: null };
  const k = key(stationId);
  const hit = cache.get(k);
  if (hit && Date.now() - hit.at < CACHE_TTL) return hit.value;
  const snap = await getDoc(doc(getDb(), 'stations', stationId, 'stock', 'current'));
  const data = snap.exists() ? snap.data() : {};
  const value = {
    levels: data.levels && typeof data.levels === 'object' ? data.levels : {},
    updatedAt: data.updatedAt || null,
    updatedBy: data.updatedBy || null,
  };
  cache.set(k, { value, at: Date.now() });
  return value;
}

export async function getStockLog(stationId, { max = 20 } = {}) {
  if (!stationId) return [];
  const snap = await getDocs(query(
    collection(getDb(), 'stations', stationId, 'stockLog'),
    orderBy('at', 'desc'),
    limit(max),
  ));
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

/** Save a new level and (optionally) a log entry atomically.
 *  type: 'delivery' | 'dip' | 'adjust' | 'test'
 */
export async function recordStockEntry({ stationId, product, type, amount, note = '', newLevel }) {
  if (!stationId) throw new Error('Select a station first.');
  const me = getCurrentUserData();
  if (!me) throw new Error('Sign in to update stock.');
  if (!can('stationSecurity.update', { stationId })) {
    const err = new Error('Only station managers can update fuel stock.');
    err.code = 'permission-denied';
    throw err;
  }
  const db = getDb();
  const current = await getStock(stationId);
  const nextLevels = { ...(current.levels || {}) };
  const prev = Number(nextLevels[product]) || 0;
  let loggedAmount = Number(amount) || 0;
  let levelAfter = prev;

  if (type === 'delivery') {
    levelAfter = prev + Math.max(0, loggedAmount);
  } else if (type === 'dip' || type === 'test') {
    // Dip reading sets the tank to the measured amount; log the difference.
    levelAfter = Math.max(0, Number(newLevel) || 0);
    loggedAmount = levelAfter - prev;
  } else if (type === 'adjust') {
    levelAfter = Math.max(0, Number(newLevel) || 0);
    loggedAmount = levelAfter - prev;
  }

  nextLevels[product] = levelAfter;
  await setDoc(doc(db, 'stations', stationId, 'stock', 'current'), {
    levels: nextLevels,
    updatedAt: serverTimestamp(),
    updatedBy: me.uid,
  });

  await addDoc(collection(db, 'stations', stationId, 'stockLog'), {
    product,
    type,
    amount: loggedAmount,
    previousLevel: prev,
    newLevel: levelAfter,
    note: String(note || '').slice(0, 200),
    staffName: me.fullName || me.email || 'Manager',
    at: serverTimestamp(),
    createdBy: me.uid,
  });

  invalidateStock(stationId);
  invalidateStation(stationId);
  return { newLevel: levelAfter };
}

// ── UI helpers ──────────────────────────────────────────────────────────
export function stockCardHTML(stock, pumps = [], mayManage = false) {
  const products = [...new Set((pumps || []).map(p => p.product).filter(Boolean))];
  const levels = stock?.levels || {};
  const rows = products.length
    ? products.map(product => {
        const level = Number(levels[product]) || 0;
        const warn = level > 0 && level < 500;
        const empty = level === 0;
        const cls = empty ? 'stock-empty' : warn ? 'stock-warn' : 'stock-ok';
        return `<div class="stock-row"><span class="stock-product">${h(product)}</span><strong class="stock-level ${cls}">${h(formatVolume(level))} L</strong></div>`;
      }).join('')
    : '<p class="muted-note">No products configured.</p>';

  const updated = stock?.updatedAt
    ? `<small>Updated ${h(formatDateTime(stock.updatedAt) || '')}</small>`
    : '<small>Not set yet — add an opening dip in Settings.</small>';

  return `<section class="stock-card" aria-labelledby="stock-card-title">
    <div class="stock-head">
      <span><span class="stock-icon" aria-hidden="true">⛽</span><span><strong id="stock-card-title">Fuel stock</strong>${updated}</span></span>
      ${mayManage ? '<button type="button" class="btn btn-secondary btn-small" id="open-stock-manager">Manage stock</button>' : ''}
    </div>
    <div class="stock-rows">${rows}</div>
  </section>`;
}

export function openStockManagerModal({ stationId, pumps, stock }) {
  if (!can('stationSecurity.update', { stationId })) {
    toastError('Only managers can update stock.');
    return;
  }
  const products = [...new Set((pumps || []).map(p => p.product).filter(Boolean))];
  if (!products.length) {
    toastError('Add pumps with a product first.');
    return;
  }
  const productOptions = products.map((p, i) =>
    `<option value="${h(p)}" ${i === 0 ? 'selected' : ''}>${h(p)}</option>`).join('');
  const currentLevels = stock?.levels || {};
  document.getElementById('modal-title').textContent = '⛽ Fuel stock';
  document.getElementById('modal-body').innerHTML = `
    <div class="stock-form-grid">
      <div class="field"><label for="stock-product">Product</label>
        <select id="stock-product">${productOptions}</select></div>
      <div class="field"><label for="stock-type">Action</label>
        <select id="stock-type">
          <option value="delivery">Fuel delivery (add litres)</option>
          <option value="dip">Dip reading (set exact level)</option>
          <option value="adjust">Manual adjustment</option>
          <option value="test">Test measure (calibration)</option>
        </select></div>
      <div class="field" id="stock-amount-field"><label for="stock-amount">Amount (L)</label>
        <input type="number" id="stock-amount" min="0" step="0.01" inputmode="decimal" placeholder="0" required />
        <small class="hint" id="stock-amount-hint">Litres delivered; added to the current tank level.</small></div>
      <div class="field hidden" id="stock-level-field"><label for="stock-new-level">Tank level after (L)</label>
        <input type="number" id="stock-new-level" min="0" step="0.01" inputmode="decimal" placeholder="0" />
        <small class="hint">Reading from the dipstick; becomes the new current level.</small></div>
      <div class="field" style="grid-column:1/-1"><label for="stock-note">Note <span class="optional">(optional)</span></label>
        <input type="text" id="stock-note" maxlength="200" placeholder="e.g. Tanker #1234, invoice 987" /></div>
    </div>
    <p class="muted-note" id="stock-current-line">Current level shown after selecting product.</p>
    <p id="stock-error" class="form-error hidden" role="alert"></p>
    <div class="confirm-actions">
      <button type="button" class="btn btn-secondary" data-close>Cancel</button>
      <button type="button" class="btn btn-primary" id="save-stock-entry">${ICONS.save} Save entry</button>
    </div>
    <h4 class="stock-log-title">Recent entries</h4>
    <div id="stock-log" class="stock-log"><p class="muted-note">Loading…</p></div>`;
  openModal('generic-modal');

  const productEl = document.getElementById('stock-product');
  const typeEl = document.getElementById('stock-type');
  const amountField = document.getElementById('stock-amount-field');
  const levelField = document.getElementById('stock-level-field');
  const amountHint = document.getElementById('stock-amount-hint');
  const amountInput = document.getElementById('stock-amount');
  const levelInput = document.getElementById('stock-new-level');
  const currentLine = document.getElementById('stock-current-line');
  const errEl = document.getElementById('stock-error');
  const saveBtn = document.getElementById('save-stock-entry');

  function refreshVisibleFields() {
    const usesLevel = ['dip', 'adjust', 'test'].includes(typeEl.value);
    amountField.classList.toggle('hidden', usesLevel);
    levelField.classList.toggle('hidden', !usesLevel);
    amountInput.required = !usesLevel;
    levelInput.required = usesLevel;
    amountHint.textContent = typeEl.value === 'delivery'
      ? 'Litres delivered; added to the current tank level.'
      : 'Signed change (positive adds, negative subtracts).';
    updateCurrentLine();
  }
  function updateCurrentLine() {
    const p = productEl.value;
    const cur = Number(currentLevels[p]) || 0;
    currentLine.textContent = `Current ${p} level: ${formatVolume(cur)} L.`;
  }
  productEl.addEventListener('change', updateCurrentLine);
  typeEl.addEventListener('change', refreshVisibleFields);
  refreshVisibleFields();

  async function loadLog() {
    const host = document.getElementById('stock-log');
    if (!host) return;
    try {
      const rows = await getStockLog(stationId, { max: 8 });
      if (!rows.length) { host.innerHTML = '<p class="muted-note">No entries yet.</p>'; return; }
      const typeLabel = { delivery: 'Delivery', dip: 'Dip', adjust: 'Adjustment', test: 'Test' };
      host.innerHTML = rows.map(r => `
        <div class="stock-log-row">
          <span class="stock-log-tag stock-tag-${h(r.type)}">${h(typeLabel[r.type] || r.type)}</span>
          <span class="stock-log-body">
            <strong>${h(r.product)}</strong> · ${r.amount >= 0 ? '+' : ''}${formatVolume(r.amount)} L → ${formatVolume(r.newLevel)} L
            ${r.note ? `<small>${h(r.note)}</small>` : ''}
          </span>
          <span class="stock-log-meta">${h(formatDateTime(r.at) || '')}<br/>${h(r.staffName || '')}</span>
        </div>`).join('');
    } catch (e) {
      host.innerHTML = `<p class="muted-note">Couldn't load log: ${h(formatFirebaseError(e))}</p>`;
    }
  }
  loadLog();

  saveBtn.addEventListener('click', async () => {
    errEl.classList.add('hidden');
    const product = productEl.value;
    const type = typeEl.value;
    const note = document.getElementById('stock-note').value.trim();
    const usesLevel = ['dip', 'adjust', 'test'].includes(type);
    const amountRaw = amountInput.value;
    const levelRaw = levelInput.value;
    const amount = usesLevel ? null : Number(amountRaw);
    const newLevel = usesLevel ? Number(levelRaw) : null;
    if (!usesLevel && (!Number.isFinite(amount) || amount <= 0 && type !== 'adjust')) {
      errEl.textContent = '❌ Enter a positive amount in litres.';
      errEl.classList.remove('hidden'); return;
    }
    if (usesLevel && (!Number.isFinite(newLevel) || newLevel < 0)) {
      errEl.textContent = '❌ Enter a non-negative tank level.';
      errEl.classList.remove('hidden'); return;
    }
    setBusy(saveBtn, true, 'Saving…');
    try {
      await recordStockEntry({ stationId, product, type, amount, note, newLevel });
      toastSuccess('Stock updated');
      closeModal('generic-modal');
      window.dispatchEvent(new CustomEvent('pumplog:dataChanged', { detail: { stationId } }));
    } catch (e) {
      errEl.textContent = `❌ ${formatFirebaseError(e)}`;
      errEl.classList.remove('hidden');
      setBusy(saveBtn, false);
    }
  });
}
