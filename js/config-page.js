/* PumpLog — Config page (Rates, Pumps, Stations, Team) */

import {
  getDb, collection, doc, addDoc, updateDoc, deleteDoc, serverTimestamp,
} from './firebase.js';
import {
  getCurrentUserData, isSuperAdmin, isStationAdmin,
  can, denyReason, assignableRoles, ROLES, ROLE_BADGE,
  createUserAsAdmin, updateUserAsAdmin, deleteUserAsAdmin, formatFirebaseError,
} from './auth.js';
import {
  getAllStations, getStationsByIds, getRates, getPumps, getAllUsers, getUsersCreatedBy,
  invalidateStation, invalidateStations, invalidateUsers,
} from './store.js';
import {
  h, formatCurrency, formatDate, getTodayDate,
  openModal, closeModal, emptyState, toast, confirmDialog, setBusy, showSkeleton,
} from './components.js';

let currentStationId = null;
let stationsCache = [];

export function initConfig() {}

const rerender = () => renderConfig(currentStationId);

// ── Render ──────────────────────────────────────────────────────────────
export async function renderConfig(stationId) {
  currentStationId = stationId;
  const content = document.getElementById('page-content');
  const me = getCurrentUserData();

  if (!can('config.view')) {
    content.innerHTML = emptyState('🔒', 'You do not have permission to view settings.');
    return;
  }

  showSkeleton(4);

  try {
    // Load every section in parallel instead of sequentially.
    const [rates, pumps, stations, users] = await Promise.all([
      stationId ? getRates(stationId) : [],
      stationId ? getPumps(stationId) : [],
      isSuperAdmin() ? getAllStations() : getStationsByIds(me.stationIds || []),
      isSuperAdmin() ? getAllUsers() : getUsersCreatedBy(me.uid),
    ]);
    stationsCache = stations;

    const sections = [
      renderRatesSection(stationId, rates),
      renderPumpsSection(stationId, pumps),
      isSuperAdmin() ? renderStationsSection(stations) : '',
      renderTeamSection(users, me),
    ].filter(Boolean).join('');

    content.innerHTML = `<h2 class="page-title">Settings</h2>${sections}`;
    wireHandlers(rates, pumps, stations, users);
  } catch (err) {
    console.error('Config render error:', err);
    content.innerHTML = emptyState('⚠️', formatFirebaseError(err));
  }
}

// ── Rates ───────────────────────────────────────────────────────────────
function renderRatesSection(stationId, rates) {
  const mayEdit = can('rate.update', { stationId });
  const addBtn = can('rate.create', { stationId })
    ? '<button id="add-rate-btn" class="btn btn-primary btn-small">+ Add rate</button>'
    : '';

  if (!stationId) {
    return section('Rates', '', emptyState('🏪', 'Select a station from the top bar to manage its rates.'));
  }

  if (rates.length === 0) {
    return section('Rates', addBtn, emptyState('💰', 'No rates yet. Add one to start tracking sales.'));
  }

  const items = rates.map(r => configItem({
    title: `${h(r.product)} — ${formatCurrency(r.rate)}/L`,
    meta: `Effective ${formatDate(r.effectiveDate)}`,
    actions: mayEdit ? [
      { cls: 'edit-rate', id: r.id, icon: '✏️', label: `Edit ${r.product} rate` },
      { cls: 'delete-rate', id: r.id, icon: '🗑️', label: `Delete ${r.product} rate` },
    ] : [],
  })).join('');

  return section('Rates', addBtn, items);
}

// ── Pumps ───────────────────────────────────────────────────────────────
function renderPumpsSection(stationId, pumps) {
  if (!stationId) return '';
  const mayEdit = can('pump.update', { stationId });
  const addBtn = can('pump.create', { stationId })
    ? '<button id="add-pump-btn-cfg" class="btn btn-primary btn-small">+ Add pump</button>'
    : '';

  if (pumps.length === 0) {
    return section('Pumps', addBtn, emptyState('⛽', 'No pumps configured for this station.'));
  }

  const items = pumps.map(p => configItem({
    title: h(p.name),
    meta: h(p.product || 'No product set'),
    actions: mayEdit ? [
      { cls: 'edit-pump', id: p.id, icon: '✏️', label: `Edit ${p.name}` },
      { cls: 'delete-pump', id: p.id, icon: '🗑️', label: `Delete ${p.name}` },
    ] : [],
  })).join('');

  return section('Pumps', addBtn, items);
}

// ── Stations (Super Admin) ──────────────────────────────────────────────
function renderStationsSection(stations) {
  const addBtn = can('station.create')
    ? '<button id="add-station-btn" class="btn btn-primary btn-small">+ Create station</button>'
    : '';

  if (stations.length === 0) {
    return section('Stations', addBtn, emptyState('🏪', 'No stations yet. Create your first one.'));
  }

  const items = stations.map(s => configItem({
    title: h(s.name),
    meta: h(s.address || 'No address'),
    actions: [
      { cls: 'edit-station', id: s.id, icon: '✏️', label: `Edit ${s.name}` },
      { cls: 'delete-station', id: s.id, icon: '🗑️', label: `Delete ${s.name}` },
    ],
  })).join('');

  return section('Stations', addBtn, items);
}

// ── Team ────────────────────────────────────────────────────────────────
function renderTeamSection(users, me) {
  const addBtn = can('user.create')
    ? `<button id="add-team-btn" class="btn btn-primary btn-small">+ Add ${isSuperAdmin() ? 'user' : 'staff'}</button>`
    : '';

  const hint = isSuperAdmin()
    ? 'Every PumpLog account. You cannot change your own role here.'
    : 'Staff accounts you created for your stations.';

  if (users.length === 0) {
    return section('Team', addBtn, emptyState('👥', 'No team members yet.'));
  }

  const nameOf = id => stationsCache.find(s => s.id === id)?.name || 'Unknown station';

  const items = users.map(u => {
    const stationIds = u.stationIds || [];
    const isMe = u.id === me.uid;
    const mayEdit = can('user.update', { target: u });
    const mayDelete = can('user.delete', { target: u });

    const stationText = u.role === 'superadmin'
      ? 'All stations'
      : stationIds.length === 0
        ? 'No stations assigned'
        : stationIds.map(nameOf).join(', ');

    const pumpText = u.role === 'staff'
      ? (u.pumpIds?.length
          ? `${u.pumpIds.length} pump${u.pumpIds.length === 1 ? '' : 's'} assigned`
          : 'all pumps')
      : null;

    const actions = [];
    if (mayEdit) {
      actions.push({ cls: 'edit-user', id: u.id, icon: '✏️', label: `Edit ${u.email}` });
    } else if (!isMe) {
      actions.push({ cls: '', id: u.id, icon: '✏️', label: 'Edit unavailable', disabled: true, title: denyReason('user.update', { target: u }) });
    }
    if (mayDelete) {
      actions.push({ cls: 'delete-user', id: u.id, icon: '🗑️', label: `Remove ${u.email}` });
    } else if (!isMe) {
      actions.push({ cls: '', id: u.id, icon: '🗑️', label: 'Remove unavailable', disabled: true, title: denyReason('user.delete', { target: u }) });
    }

    return configItem({
      title: `${h(u.email)}${isMe ? ' <span class="tag tag-you">You</span>' : ''}`,
      meta: `${ROLE_BADGE[u.role] || '⚪'} ${h(ROLES[u.role] || u.role)} · ${h(stationText)}${pumpText ? ` · ${h(pumpText)}` : ''}`,
      actions,
    });
  }).join('');

  return section('Team', addBtn, `<p class="section-hint">${h(hint)}</p>${items}`);
}

// ── Markup helpers ──────────────────────────────────────────────────────
function section(title, actionHTML, bodyHTML) {
  return `<section class="config-section">
    <h3>${h(title)}${actionHTML}</h3>
    ${bodyHTML}
  </section>`;
}

function configItem({ title, meta, actions = [] }) {
  const buttons = actions.map(a => `
    <button class="icon-btn ${a.cls}" data-id="${h(a.id)}"
            aria-label="${h(a.label)}" title="${h(a.title || a.label)}"
            ${a.disabled ? 'disabled' : ''}>${a.icon}</button>
  `).join('');

  return `<div class="config-item">
    <div class="item-info">
      <div class="item-title">${title}</div>
      <div class="item-meta">${meta}</div>
    </div>
    ${buttons ? `<div class="item-actions">${buttons}</div>` : ''}
  </div>`;
}

const byId = id => document.getElementById(id);
const onClick = (id, fn) => byId(id)?.addEventListener('click', fn);
const onEach = (sel, fn) => document.querySelectorAll(sel).forEach(el =>
  el.addEventListener('click', () => fn(el.dataset.id, el)));

// ── Wiring ──────────────────────────────────────────────────────────────
function wireHandlers(rates, pumps, stations, users) {
  const sid = currentStationId;

  onClick('add-rate-btn', () => showRateForm(null));
  onEach('.edit-rate', id => showRateForm(rates.find(r => r.id === id)));
  onEach('.delete-rate', id => deleteRate(rates.find(r => r.id === id)));

  onClick('add-pump-btn-cfg', () => showPumpForm(null));
  onEach('.edit-pump', id => showPumpForm(pumps.find(p => p.id === id)));
  onEach('.delete-pump', id => deletePump(pumps.find(p => p.id === id)));

  onClick('add-station-btn', () => showStationForm(null));
  onEach('.edit-station', id => showStationForm(stations.find(s => s.id === id)));
  onEach('.delete-station', id => deleteStation(stations.find(s => s.id === id)));

  onClick('add-team-btn', () => showUserForm(null));
  onEach('.edit-user', id => showUserForm(users.find(u => u.id === id)));
  onEach('.delete-user', id => removeUser(users.find(u => u.id === id)));

  void sid;
}

// ── Rate form ───────────────────────────────────────────────────────────
const PRODUCTS = [
  ['MS', 'MS (Petrol)'],
  ['HSD', 'HSD (Diesel)'],
  ['CNG', 'CNG'],
  ['LPG', 'LPG'],
  ['Other', 'Other'],
];

function productOptions(selected) {
  return PRODUCTS.map(([v, label]) =>
    `<option value="${v}" ${selected === v ? 'selected' : ''}>${label}</option>`
  ).join('');
}

function showRateForm(rate) {
  const isEdit = !!rate;
  const action = isEdit ? 'rate.update' : 'rate.create';

  // Guard the two conditions that produced the old "failed to add rate" error.
  if (!currentStationId) {
    toast('Select a station before adding a rate.', 'error');
    return;
  }
  if (!can(action, { stationId: currentStationId })) {
    toast(denyReason(action), 'error');
    return;
  }

  showFormModal(isEdit ? 'Edit rate' : 'Add rate', `
    <form id="rate-form" novalidate>
      <div class="field">
        <label for="rate-product">Product</label>
        <select id="rate-product" required>
          <option value="">Select product…</option>
          ${productOptions(rate?.product)}
        </select>
      </div>
      <div class="field">
        <label for="rate-value">Rate (₹ per litre)</label>
        <input type="number" id="rate-value" step="0.01" min="0" inputmode="decimal"
               placeholder="0.00" value="${rate?.rate ?? ''}" required />
      </div>
      <div class="field">
        <label for="rate-date">Effective date</label>
        <input type="date" id="rate-date" value="${h(rate?.effectiveDate || getTodayDate())}" required />
      </div>
      <p class="form-error hidden" id="rate-form-error" role="alert"></p>
      <button type="submit" class="btn btn-primary btn-full">${isEdit ? 'Save changes' : 'Add rate'}</button>
    </form>
  `);

  byId('rate-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.currentTarget.querySelector('button[type="submit"]');
    const err = byId('rate-form-error');

    const product = byId('rate-product').value;
    const rateValue = parseFloat(byId('rate-value').value);
    const effectiveDate = byId('rate-date').value;

    // Validate up front so a bad value never reaches Firestore.
    if (!product) return showFieldError(err, 'Choose a product.');
    if (!Number.isFinite(rateValue) || rateValue <= 0) return showFieldError(err, 'Enter a rate greater than zero.');
    if (!effectiveDate) return showFieldError(err, 'Choose an effective date.');

    err.classList.add('hidden');
    setBusy(btn, true, 'Saving…');

    try {
      const payload = { product, rate: rateValue, effectiveDate };
      const db = getDb();

      if (isEdit) {
        await updateDoc(doc(db, 'stations', currentStationId, 'rates', rate.id), {
          ...payload, updatedAt: serverTimestamp(),
        });
      } else {
        // createdAt/createdBy are required by firestore.rules for new rates.
        await addDoc(collection(db, 'stations', currentStationId, 'rates'), {
          ...payload,
          createdBy: getCurrentUserData()?.uid || 'unknown',
          createdAt: serverTimestamp(),
        });
      }

      invalidateStation(currentStationId);
      closeModal('generic-modal');
      toast(isEdit ? 'Rate updated.' : 'Rate added.', 'success');
      rerender();
    } catch (e2) {
      console.error('Rate save error:', e2);
      showFieldError(err, formatFirebaseError(e2));
      setBusy(btn, false);
    }
  });
}

async function deleteRate(rate) {
  if (!rate || !can('rate.delete', { stationId: currentStationId })) {
    toast(denyReason('rate.delete'), 'error');
    return;
  }
  const ok = await confirmDialog({
    title: 'Delete rate?',
    message: `${rate.product} at ${formatCurrency(rate.rate)}/L effective ${formatDate(rate.effectiveDate)} will be removed. Existing shift records keep the rate they were saved with.`,
    confirmLabel: 'Delete rate',
    danger: true,
  });
  if (!ok) return;

  try {
    await deleteDoc(doc(getDb(), 'stations', currentStationId, 'rates', rate.id));
    invalidateStation(currentStationId);
    toast('Rate deleted.', 'success');
    rerender();
  } catch (err) {
    console.error('Delete rate error:', err);
    toast(formatFirebaseError(err), 'error');
  }
}

// ── Pump form ───────────────────────────────────────────────────────────
function showPumpForm(pump) {
  const isEdit = !!pump;
  const action = isEdit ? 'pump.update' : 'pump.create';
  if (!can(action, { stationId: currentStationId })) {
    toast(denyReason(action), 'error');
    return;
  }

  showFormModal(isEdit ? 'Edit pump' : 'Add pump', `
    <form id="pump-form" novalidate>
      <div class="field">
        <label for="pump-name">Pump / nozzle name</label>
        <input type="text" id="pump-name" placeholder="e.g. Pump 1" value="${h(pump?.name || '')}" required />
      </div>
      <div class="field">
        <label for="pump-product">Product</label>
        <select id="pump-product" required>
          <option value="">Select product…</option>
          ${productOptions(pump?.product)}
        </select>
      </div>
      <p class="form-error hidden" id="pump-form-error" role="alert"></p>
      <button type="submit" class="btn btn-primary btn-full">${isEdit ? 'Save changes' : 'Add pump'}</button>
    </form>
  `);

  byId('pump-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.currentTarget.querySelector('button[type="submit"]');
    const err = byId('pump-form-error');
    const name = byId('pump-name').value.trim();
    const product = byId('pump-product').value;

    if (!name) return showFieldError(err, 'Enter a pump name.');
    if (!product) return showFieldError(err, 'Choose a product.');

    err.classList.add('hidden');
    setBusy(btn, true, 'Saving…');

    try {
      const db = getDb();
      if (isEdit) {
        await updateDoc(doc(db, 'stations', currentStationId, 'pumps', pump.id), {
          name, product, updatedAt: serverTimestamp(),
        });
      } else {
        await addDoc(collection(db, 'stations', currentStationId, 'pumps'), {
          name, product,
          createdBy: getCurrentUserData()?.uid || 'unknown',
          createdAt: serverTimestamp(),
        });
      }
      invalidateStation(currentStationId);
      closeModal('generic-modal');
      toast(isEdit ? 'Pump updated.' : 'Pump added.', 'success');
      rerender();
    } catch (e2) {
      console.error('Pump save error:', e2);
      showFieldError(err, formatFirebaseError(e2));
      setBusy(btn, false);
    }
  });
}

async function deletePump(pump) {
  if (!pump || !can('pump.delete', { stationId: currentStationId })) {
    toast(denyReason('pump.delete'), 'error');
    return;
  }
  const ok = await confirmDialog({
    title: 'Delete pump?',
    message: `“${pump.name}” will be removed. Past shift records for this pump are kept.`,
    confirmLabel: 'Delete pump',
    danger: true,
  });
  if (!ok) return;

  try {
    await deleteDoc(doc(getDb(), 'stations', currentStationId, 'pumps', pump.id));
    invalidateStation(currentStationId);
    toast('Pump deleted.', 'success');
    rerender();
  } catch (err) {
    console.error('Delete pump error:', err);
    toast(formatFirebaseError(err), 'error');
  }
}

// ── Station form ────────────────────────────────────────────────────────
function showStationForm(station) {
  const isEdit = !!station;
  const action = isEdit ? 'station.update' : 'station.create';
  if (!can(action)) {
    toast(denyReason(action), 'error');
    return;
  }

  showFormModal(isEdit ? 'Edit station' : 'Create station', `
    <form id="station-form" novalidate>
      <div class="field">
        <label for="station-name">Station name</label>
        <input type="text" id="station-name" placeholder="e.g. Highway Filling Station"
               value="${h(station?.name || '')}" required />
      </div>
      <div class="field">
        <label for="station-address">Address <span class="optional">(optional)</span></label>
        <input type="text" id="station-address" placeholder="City, area" value="${h(station?.address || '')}" />
      </div>
      <p class="form-error hidden" id="station-form-error" role="alert"></p>
      <button type="submit" class="btn btn-primary btn-full">${isEdit ? 'Save changes' : 'Create station'}</button>
    </form>
  `);

  byId('station-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.currentTarget.querySelector('button[type="submit"]');
    const err = byId('station-form-error');
    const name = byId('station-name').value.trim();
    const address = byId('station-address').value.trim();

    if (!name) return showFieldError(err, 'Enter a station name.');

    err.classList.add('hidden');
    setBusy(btn, true, 'Saving…');

    try {
      const db = getDb();
      if (isEdit) {
        await updateDoc(doc(db, 'stations', station.id), { name, address, updatedAt: serverTimestamp() });
        invalidateStations();
        closeModal('generic-modal');
        toast('Station updated.', 'success');
        window.dispatchEvent(new CustomEvent('pumplog:stationsChanged', { detail: { stationId: station.id } }));
      } else {
        const ref = await addDoc(collection(db, 'stations'), {
          name, address,
          createdBy: getCurrentUserData()?.uid || 'unknown',
          createdAt: serverTimestamp(),
        });
        invalidateStations();
        closeModal('generic-modal');
        toast('Station created.', 'success');
        window.dispatchEvent(new CustomEvent('pumplog:stationsChanged', { detail: { stationId: ref.id } }));
      }
    } catch (e2) {
      console.error('Station save error:', e2);
      showFieldError(err, formatFirebaseError(e2));
      setBusy(btn, false);
    }
  });
}

async function deleteStation(station) {
  if (!station || !can('station.delete')) {
    toast(denyReason('station.delete'), 'error');
    return;
  }
  const ok = await confirmDialog({
    title: 'Delete station?',
    message: `“${station.name}” will be removed from the station list. Its rates, pumps and shift records stay in Firestore and are no longer reachable from the app.`,
    confirmLabel: 'Delete station',
    danger: true,
  });
  if (!ok) return;

  try {
    await deleteDoc(doc(getDb(), 'stations', station.id));
    invalidateStations();
    toast('Station deleted.', 'success');
    window.dispatchEvent(new CustomEvent('pumplog:stationsChanged', { detail: { stationId: null } }));
  } catch (err) {
    console.error('Delete station error:', err);
    toast(formatFirebaseError(err), 'error');
  }
}

// ── User create / edit ──────────────────────────────────────────────────
async function showUserForm(user) {
  const isEdit = !!user;
  const me = getCurrentUserData();

  if (isEdit && !can('user.update', { target: user })) {
    toast(denyReason('user.update', { target: user }), 'error');
    return;
  }
  if (!isEdit && !can('user.create')) {
    toast(denyReason('user.create'), 'error');
    return;
  }

  // Super Admin may assign any station; Station Admin only their own.
  const stations = isSuperAdmin() ? await getAllStations() : await getStationsByIds(me.stationIds || []);
  const roles = assignableRoles();
  const assigned = new Set(user?.stationIds || []);

  // Keep the current role selectable even if it is not otherwise assignable.
  const roleList = isEdit && !roles.includes(user.role) ? [user.role, ...roles] : roles;
  const roleOptions = roleList.map(r =>
    `<option value="${r}" ${user?.role === r ? 'selected' : ''}>${ROLES[r] || r}</option>`
  ).join('');

  const stationBoxes = stations.length
    ? stations.map(s => `
        <div class="checkbox-item">
          <input type="checkbox" id="assign-${h(s.id)}" value="${h(s.id)}" ${assigned.has(s.id) ? 'checked' : ''} />
          <label for="assign-${h(s.id)}">${h(s.name)}</label>
        </div>`).join('')
    : '<p class="muted-note">No stations available to assign yet.</p>';

  const credentialFields = isEdit ? `
    <div class="field">
      <label>Email</label>
      <input type="email" value="${h(user.email)}" disabled />
      <small class="hint">Email changes are managed in Firebase Authentication.</small>
    </div>
  ` : `
    <div class="field">
      <label for="new-email">Email</label>
      <input type="email" id="new-email" placeholder="user@example.com" required
             autocomplete="off" autocapitalize="off" spellcheck="false" />
    </div>
    <div class="field">
      <label for="new-password">Temporary password</label>
      <input type="password" id="new-password" placeholder="At least 6 characters"
             minlength="6" required autocomplete="new-password" />
    </div>
  `;

  showFormModal(isEdit ? 'Edit team member' : 'Add team member', `
    <form id="user-form" novalidate>
      ${credentialFields}
      <div class="field">
        <label for="new-role">Role</label>
        <select id="new-role" required ${roleList.length <= 1 ? 'data-single="1"' : ''}>${roleOptions}</select>
      </div>
      <fieldset class="field">
        <legend>Assign to stations</legend>
        <div class="checkbox-list" id="station-assign-list">${stationBoxes}</div>
        <small class="hint" id="role-station-hint"></small>
      </fieldset>
      <fieldset class="field" id="pump-assign-fieldset">
        <legend>Assign pumps <span class="optional">(staff only, optional)</span></legend>
        <div class="pump-assign-list" id="pump-assign-list"></div>
        <small class="hint" id="pump-assign-hint"></small>
      </fieldset>
      <p class="form-error hidden" id="user-form-error" role="alert"></p>
      <button type="submit" class="btn btn-primary btn-full">${isEdit ? 'Save changes' : 'Create account'}</button>
    </form>
  `);

  // Super Admins implicitly see every station, so hide the picker for them.
  const roleSelect = byId('new-role');
  const hint = byId('role-station-hint');
  const list = byId('station-assign-list');
  function syncStationPicker() {
    const isSuper = roleSelect.value === 'superadmin';
    list.classList.toggle('is-disabled', isSuper);
    list.querySelectorAll('input').forEach(i => { i.disabled = isSuper; });
    hint.textContent = isSuper
      ? 'Super Admins have access to every station automatically.'
      : 'Staff and Station Admins see only the stations you tick.';
  }
  roleSelect.addEventListener('change', syncStationPicker);
  syncStationPicker();

  // ── Pump assignment picker ────────────────────────────────────────────
  // Ticked pumps are the ONLY pumps a staff member sees at login. Leaving
  // everything unticked means "all pumps at the assigned stations".
  const pumpFieldset = byId('pump-assign-fieldset');
  const pumpList = byId('pump-assign-list');
  const pumpHint = byId('pump-assign-hint');
  const selectedPumps = new Set(user?.pumpIds || []);
  const stationPumps = new Map(); // stationId -> pumps[] (loaded on demand)

  const checkedStationIds = () =>
    Array.from(list.querySelectorAll('input[type="checkbox"]:checked')).map(cb => cb.value);

  async function loadStationPumps(stationId) {
    if (!stationPumps.has(stationId)) {
      try { stationPumps.set(stationId, await getPumps(stationId)); }
      catch { stationPumps.set(stationId, []); }
    }
    return stationPumps.get(stationId);
  }

  async function refreshPumpPicker() {
    const isStaffRole = roleSelect.value === 'staff';
    pumpFieldset.classList.toggle('is-disabled', !isStaffRole);
    if (!isStaffRole) {
      pumpList.innerHTML = '';
      pumpHint.textContent = 'Only staff accounts use pump assignments — admins and managers see every pump.';
      return;
    }

    const ids = checkedStationIds();
    if (ids.length === 0) {
      pumpList.innerHTML = '';
      pumpHint.textContent = 'Tick a station above to choose which of its pumps this person can use.';
      return;
    }

    pumpHint.textContent = 'Loading pumps…';
    await Promise.all(ids.map(loadStationPumps));

    // Ticked pumps belonging to stations that were just unticked no longer apply.
    const validIds = new Set(ids.flatMap(id => (stationPumps.get(id) || []).map(p => p.id)));
    for (const pid of [...selectedPumps]) {
      if (!validIds.has(pid)) selectedPumps.delete(pid);
    }

    pumpList.innerHTML = ids.map(id => {
      const stationName = stations.find(s => s.id === id)?.name || 'Station';
      const pumps = stationPumps.get(id) || [];
      const boxes = pumps.map(p => `
        <div class="checkbox-item">
          <input type="checkbox" id="pump-${h(p.id)}" value="${h(p.id)}" ${selectedPumps.has(p.id) ? 'checked' : ''} />
          <label for="pump-${h(p.id)}">${h(p.name)}${p.product ? ` <span class="muted-note">${h(p.product)}</span>` : ''}</label>
        </div>`).join('');
      return `<div class="pump-group">
        <p class="pump-group-title">${h(stationName)}</p>
        ${boxes || '<p class="muted-note pump-group-empty">No pumps configured for this station yet.</p>'}
      </div>`;
    }).join('');

    pumpHint.textContent = 'This staff member will see only the ticked pumps when they log in. Leave all unticked to allow every pump at the assigned stations.';
    pumpList.querySelectorAll('input[type="checkbox"]').forEach(cb =>
      cb.addEventListener('change', () => {
        if (cb.checked) selectedPumps.add(cb.value);
        else selectedPumps.delete(cb.value);
      }));
  }

  list.addEventListener('change', (e) => {
    if (e.target.matches('input[type="checkbox"]')) refreshPumpPicker();
  });
  roleSelect.addEventListener('change', refreshPumpPicker);
  await refreshPumpPicker();

  byId('user-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.currentTarget.querySelector('button[type="submit"]');
    const err = byId('user-form-error');
    const role = roleSelect.value;
    const stationIds = Array.from(
      document.querySelectorAll('#station-assign-list input[type="checkbox"]:checked')
    ).map(cb => cb.value);
    // Pump assignments apply to staff only; everyone else sees every pump.
    const pumpIds = role === 'staff' ? [...selectedPumps] : [];

    if (role !== 'superadmin' && stationIds.length === 0) {
      return showFieldError(err, 'Assign at least one station, or the account will not see any data.');
    }

    err.classList.add('hidden');
    setBusy(btn, true, isEdit ? 'Saving…' : 'Creating account…');

    try {
      if (isEdit) {
        await updateUserAsAdmin(user, {
          role,
          stationIds: role === 'superadmin' ? [] : stationIds,
          pumpIds,
        });
        invalidateUsers();
        closeModal('generic-modal');
        toast(`${user.email} updated.`, 'success');
      } else {
        const email = byId('new-email').value.trim();
        const password = byId('new-password').value;
        if (!email) return failInline(err, btn, 'Enter an email address.');
        if (password.length < 6) return failInline(err, btn, 'Password must be at least 6 characters.');

        await createUserAsAdmin(email, password, role, role === 'superadmin' ? [] : stationIds, pumpIds);
        invalidateUsers();
        closeModal('generic-modal');
        toast(`Account created for ${email}.`, 'success');
      }
      rerender();
    } catch (e2) {
      console.error('User save error:', e2);
      showFieldError(err, formatFirebaseError(e2));
      setBusy(btn, false);
    }
  });
}

async function removeUser(user) {
  if (!user || !can('user.delete', { target: user })) {
    toast(denyReason('user.delete', { target: user }), 'error');
    return;
  }

  const ok = await confirmDialog({
    title: 'Remove access?',
    message: `${user.email} will immediately lose all access to PumpLog. Their sign-in credential stays in Firebase Authentication — delete it there too if you want the login removed completely.`,
    confirmLabel: 'Remove access',
    danger: true,
  });
  if (!ok) return;

  try {
    await deleteUserAsAdmin(user);
    invalidateUsers();
    toast(`${user.email} removed.`, 'success');
    rerender();
  } catch (err) {
    console.error('Delete user error:', err);
    toast(formatFirebaseError(err), 'error');
  }
}

// ── Small helpers ───────────────────────────────────────────────────────
function showFormModal(title, bodyHTML) {
  byId('modal-title').textContent = title;
  byId('modal-body').innerHTML = bodyHTML;
  openModal('generic-modal');
}

function showFieldError(el, message) {
  if (!el) return;
  el.textContent = message;
  el.classList.remove('hidden');
}

function failInline(err, btn, message) {
  showFieldError(err, message);
  setBusy(btn, false);
}
