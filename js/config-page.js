/* PumpLog — Config page (Rates, Pumps, Stations, Team) */

import {
  getDb, collection, doc, addDoc, updateDoc, deleteDoc, getDocs, query, limit,
  serverTimestamp, writeBatch,
} from './firebase.js';
import {
  getCurrentUserData, isSuperAdmin, isStationAdmin,
  can, denyReason, assignableRoles, ROLES, ROLE_BADGE,
  createUserAsAdmin, updateUserAsAdmin, deleteUserAsAdmin, doSignOut, formatFirebaseError,
} from './auth.js';
import {
  getAllStations, getStationsByIds, getRates, getPumps, getPumpSessions, getAllUsers, getUsersCreatedBy,
  invalidateStation, invalidateStations, invalidateUsers,
} from './store.js';
import {
  h, formatCurrency, formatDate, formatDateTime, getTodayDate,
  openModal, closeModal, emptyState, toast, confirmDialog, setBusy, showSkeleton,
} from './components.js';
import { createStaff, checkUsername, resetStaffPin, prepareLegacyUsers, disableStaff, createAdminInvite } from './staff-auth.js';
import { openChangePinForm } from './profile.js';

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
    const [rates, pumps, sessions, stations, users] = await Promise.all([
      stationId ? getRates(stationId) : [],
      stationId ? getPumps(stationId) : [],
      stationId ? getPumpSessions(stationId) : [],
      isSuperAdmin() ? getAllStations() : getStationsByIds(me.stationIds || []),
      isSuperAdmin() ? getAllUsers() : getUsersCreatedBy(me.uid),
    ]);
    stationsCache = stations;

    const sections = [
      renderProfileSection(me, stations, pumps),
      renderRatesSection(stationId, rates),
      renderPumpsSection(stationId, pumps, sessions),
      renderStationsSection(stations),
      renderTeamSection(users, me),
      renderSecuritySection(),
    ].filter(Boolean).join('');

    content.innerHTML = `<h2 class="page-title">Settings</h2>${sections}`;
    wireHandlers(rates, pumps, sessions, stations, users);
  } catch (err) {
    console.error('Config render error:', err);
    content.innerHTML = emptyState('⚠️', formatFirebaseError(err));
  }
}

// ── Profile ─────────────────────────────────────────────────────────────
function renderProfileSection(me, stations, pumps) {
  const stationText = isSuperAdmin()
    ? 'All stations'
    : (stations || []).filter(station => (me.stationIds || []).includes(station.id)).map(station => station.name).join(', ') || 'No stations assigned';
  const pumpText = me.role === 'staff'
    ? (me.pumpIds?.length ? `${me.pumpIds.length} assigned pump${me.pumpIds.length === 1 ? '' : 's'}` : 'All pumps at assigned stations')
    : `${(pumps || []).length || 'All'} pumps visible at this station`;
  const displayName = me.displayName || me.email || 'PumpLog user';
  return section('Profile', '', `<div class="profile-card-grid">
    <div class="profile-card-identity"><span class="profile-avatar" aria-hidden="true">👤</span><div><strong>${h(displayName)}</strong><small>${h(me.email || 'No email')}</small></div></div>
    <dl class="profile-settings-list"><dt>Role</dt><dd><span class="role-badge">${ROLE_BADGE[me.role] || '⚪'} ${h(ROLES[me.role] || me.role || 'Staff')}</span></dd>
      <dt>Assigned stations</dt><dd>${h(stationText)}</dd><dt>Pump access</dt><dd>${h(pumpText)}</dd></dl>
    <p class="profile-readonly-note">This information is read-only here. Station and pump access changes are managed by an administrator.</p>
    <div class="profile-account-actions"><button type="button" id="config-change-pin" class="btn btn-secondary btn-full">Change PIN</button><button type="button" id="config-signout" class="btn btn-secondary btn-full">Sign out</button></div>
  </div>`);
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
function renderPumpsSection(stationId, pumps, sessions = []) {
  if (!stationId) return '';
  const mayEdit = can('pump.update', { stationId });
  const addBtn = can('pump.create', { stationId })
    ? '<button id="add-pump-btn-cfg" class="btn btn-primary btn-small">+ Add pump</button>'
    : '';

  if (pumps.length === 0) {
    return section('Pumps', addBtn, emptyState('⛽', 'No pumps configured for this station.'));
  }

  const items = pumps.map(p => {
    const session = sessions.find(s => s.id === p.id && s.status === 'active');
    const actions = mayEdit ? [
      { cls: 'edit-pump', id: p.id, icon: '✏️', label: `Edit ${p.name}` },
      { cls: 'delete-pump', id: p.id, icon: '🗑️', label: `Delete ${p.name}` },
    ] : [];
    if (session && can('pumpSession.forceRelease', { stationId })) {
      actions.push({ cls: 'force-release', id: p.id, icon: '🔓', label: `Force release ${p.name}` });
    }
    const active = session
      ? ` · Active since ${formatDateTime(session.clockInAt) || 'just now'} · ${h(session.activeName || 'Staff member')}`
      : '';
    return configItem({ title: h(p.name), meta: `${h(p.product || 'No product set')}${active}`, actions });
  }).join('');

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

  const items = stations.map(s => {
    const actions = [];
    if (can('station.update')) actions.push({ cls: 'edit-station', id: s.id, icon: '✏️', label: `Edit ${s.name}` });
    if (can('station.delete')) actions.push({ cls: 'delete-station', id: s.id, icon: '🗑️', label: `Delete ${s.name}` });
    if (can('station.reset', { stationId: s.id })) {
      actions.push({ cls: 'reset-station', id: s.id, icon: '♻️', label: `Reset data for ${s.name}` });
    }
    return configItem({
      title: h(s.name),
      meta: `${h(s.address || 'No address')} · <span class="destructive-label">Reset removes shift history and live locks only</span>`,
      actions,
    });
  }).join('');

  return section('Stations', addBtn, `<p class="section-hint">Reset station data keeps pumps, rates, and team assignments.</p>${items}`);
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
      actions.push({ cls: 'edit-user', id: u.id, icon: '✏️', label: `Edit ${u.email || u.fullName}` });
      if (u.role === 'staff') actions.push({ cls: 'reset-pin-user', id: u.id, icon: '🔑', label: `Reset PIN for ${u.email || u.fullName}` });
    } else if (!isMe) {
      actions.push({ cls: '', id: u.id, icon: '✏️', label: 'Edit unavailable', disabled: true, title: denyReason('user.update', { target: u }) });
    }
    if (mayDelete) {
      actions.push(u.username
        ? { cls: 'disable-user', id: u.id, icon: '⛔', label: `Disable ${u.fullName || u.username}` }
        : { cls: 'delete-user', id: u.id, icon: '🗑️', label: `Remove ${u.email || u.fullName}` });
    } else if (!isMe) {
      actions.push({ cls: '', id: u.id, icon: '🗑️', label: 'Remove unavailable', disabled: true, title: denyReason('user.delete', { target: u }) });
    }

    return configItem({
      title: `${h(u.fullName || u.email || u.username || 'Unnamed user')}${isMe ? ' <span class="tag tag-you">You</span>' : ''}`,
      meta: `${ROLE_BADGE[u.role] || '⚪'} ${h(ROLES[u.role] || u.role)}${u.username ? ` · @${h(u.username)}` : ''} · ${h(stationText)}${pumpText ? ` · ${h(pumpText)}` : ''}`,
      actions,
    });
  }).join('');

  return section('Team', addBtn, `<p class="section-hint">${h(hint)}</p>${items}`);
}

// ── Markup helpers ──────────────────────────────────────────────────────
const SECTION_META = {
  Profile: { icon: '👤', description: 'Your account, role, station, and pump access.' },
  Rates: { icon: '₹', description: 'Set the prices used to calculate each shift.' },
  Pumps: { icon: '⛽', description: 'Manage pumps, products, and stuck session locks.' },
  Stations: { icon: '🏪', description: 'Manage stations or safely reset station data.' },
  Team: { icon: '👥', description: 'Manage staff, roles, stations, and pump assignments.' },
  Security: { icon: '🔒', description: 'Understand how Firebase and live pump locks protect access.' },
};

function section(title, actionHTML, bodyHTML) {
  const meta = SECTION_META[title] || { icon: '⚙️', description: 'Manage PumpLog settings.' };
  const key = title.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const open = title === 'Profile';
  return `<section class="config-section ${open ? 'is-open' : ''}" data-config-section="${h(key)}">
    <button type="button" class="config-accordion-toggle" aria-expanded="${open}" aria-controls="config-body-${h(key)}">
      <span class="config-topic-icon" aria-hidden="true">${meta.icon}</span>
      <span class="config-topic-copy"><strong>${h(title)}</strong><small>${h(meta.description)}</small></span>
      <span class="config-topic-chevron" aria-hidden="true">⌄</span>
    </button>
    <div id="config-body-${h(key)}" class="config-section-body" ${open ? '' : 'hidden'}>
      ${actionHTML ? `<div class="config-section-actions">${actionHTML}</div>` : ''}
      ${bodyHTML}
    </div>
  </section>`;
}

function renderSecuritySection() {
  const inviteButton = isSuperAdmin() ? '<button type="button" id="create-admin-invite" class="btn btn-primary btn-full mt-16">Invite Station Admin</button>' : '';
  return section('Security', '', `<div class="security-grid">
    <article class="security-card"><span class="security-card-icon" aria-hidden="true">🔐</span><div><strong>Firebase Auth sign-in</strong><p>Each person stays signed in on their device until they choose Sign out. Firebase Auth and Firestore rules remain the authority.</p></div></article>
    <article class="security-card"><span class="security-card-icon" aria-hidden="true">🔒</span><div><strong>One pump, one active shift</strong><p>A live Firestore transaction locks a pump to one staff member. Clock-out releases it atomically with the saved shift record.</p></div></article>
    <article class="security-card"><span class="security-card-icon" aria-hidden="true">🛡️</span><div><strong>Role-based access</strong><p>Staff see their assigned pumps and records. Station Admins manage their stations. Super Admins manage every station. UI checks never replace server rules.</p></div></article>
  </div><p class="security-note">For recovery, managers can force-release an active lock from the Pumps section. This discards the unfinished reading and does not create a shift.</p>
  ${inviteButton}<button type="button" id="prepare-legacy-users" class="btn btn-secondary btn-full mt-16">Prepare existing accounts for username + PIN</button>`);
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

function wireConfigAccordion() {
  document.querySelectorAll('[data-config-section] .config-accordion-toggle').forEach(toggle => {
    toggle.addEventListener('click', () => {
      const sectionEl = toggle.closest('[data-config-section]');
      const wasOpen = sectionEl.classList.contains('is-open');
      document.querySelectorAll('[data-config-section]').forEach(sectionEl2 => {
        sectionEl2.classList.remove('is-open');
        sectionEl2.querySelector('.config-accordion-toggle')?.setAttribute('aria-expanded', 'false');
        const body = sectionEl2.querySelector('.config-section-body');
        if (body) body.hidden = true;
      });
      if (!wasOpen) {
        sectionEl.classList.add('is-open');
        toggle.setAttribute('aria-expanded', 'true');
        const body = sectionEl.querySelector('.config-section-body');
        if (body) body.hidden = false;
      }
    });
  });
}

// ── Wiring ──────────────────────────────────────────────────────────────
function wireHandlers(rates, pumps, sessions, stations, users) {
  const sid = currentStationId;
  wireConfigAccordion();
  onClick('config-signout', async event => {
    setBusy(event.currentTarget, true, 'Signing out…');
    await doSignOut();
  });
  onClick('config-change-pin', () => openChangePinForm());
  onClick('prepare-legacy-users', () => prepareExistingAccounts());
  onClick('create-admin-invite', () => createStationAdminInvite());

  onClick('add-rate-btn', () => showRateForm(null));
  onEach('.edit-rate', id => showRateForm(rates.find(r => r.id === id)));
  onEach('.delete-rate', id => deleteRate(rates.find(r => r.id === id)));

  onClick('add-pump-btn-cfg', () => showPumpForm(null));
  onEach('.edit-pump', id => showPumpForm(pumps.find(p => p.id === id)));
  onEach('.delete-pump', id => deletePump(pumps.find(p => p.id === id)));
  onEach('.force-release', id => forceReleasePump(pumps.find(p => p.id === id), sessions.find(s => s.id === id)));

  onClick('add-station-btn', () => showStationForm(null));
  onEach('.edit-station', id => showStationForm(stations.find(s => s.id === id)));
  onEach('.delete-station', id => deleteStation(stations.find(s => s.id === id)));
  onEach('.reset-station', id => resetStationData(stations.find(s => s.id === id)));

  onClick('add-team-btn', () => showUserForm(null));
  onEach('.edit-user', id => showUserForm(users.find(u => u.id === id)));
  onEach('.reset-pin-user', id => resetStaffPinForUser(users.find(u => u.id === id)));
  onEach('.disable-user', id => disableStaffUser(users.find(u => u.id === id)));
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

// ── Live lock recovery ──────────────────────────────────────────────────
async function forceReleasePump(pump, session) {
  if (!pump || !session || !can('pumpSession.forceRelease', { stationId: currentStationId })) {
    toast(denyReason('pumpSession.forceRelease'), 'error');
    return;
  }
  const started = formatDateTime(session.clockInAt) || 'an unknown time';
  const startedBy = session.activeName || 'an unknown staff member';
  const ok = await confirmDialog({
    title: 'Force-release pump?',
    message: `Pump ${pump.name} has been active since ${started}, started by ${startedBy}. Force-release it without saving a shift record?`,
    confirmLabel: 'Force release',
    danger: true,
  });
  if (!ok) return;
  try {
    await updateDoc(doc(getDb(), 'stations', currentStationId, 'pumpSessions', pump.id), {
      status: 'idle', activeUid: null, activeName: null, clockInAt: null, opening: null,
      date: null, shiftLabel: null, updatedAt: serverTimestamp(),
      updatedBy: getCurrentUserData()?.uid || 'unknown',
    });
    invalidateStation(currentStationId);
    toast(`${pump.name} released. No shift record was saved.`, 'success');
    window.dispatchEvent(new CustomEvent('pumplog:dataChanged', { detail: { stationId: currentStationId } }));
  } catch (err) {
    console.error('Force release error:', err);
    toast(formatFirebaseError(err), 'error');
  }
}

// Firestore has no client-side delete-collection operation. Delete in small
// batches so this remains safe for a large station and does not touch config.
async function deleteSubcollection(stationId, name) {
  const path = collection(getDb(), 'stations', stationId, name);
  let deleted = 0;
  while (true) {
    const snap = await getDocs(query(path, limit(500)));
    if (snap.empty) break;
    const batch = writeBatch(getDb());
    snap.docs.forEach(item => batch.delete(item.ref));
    await batch.commit();
    deleted += snap.size;
    if (snap.size < 500) break;
  }
  return deleted;
}

async function resetStationData(station) {
  if (!station || !can('station.reset', { stationId: station.id })) {
    toast(denyReason('station.reset'), 'error');
    return;
  }
  const ok = await confirmDialog({
    title: `Reset ${station.name}?`,
    message: `This permanently deletes every shift record and pump session lock for ${station.name}. Pumps, rates, and team assignments will not be changed. This cannot be undone.`,
    confirmLabel: 'Reset station data',
    danger: true,
    confirmationText: station.name,
  });
  if (!ok) return;
  try {
    const [shifts, sessions] = await Promise.all([
      deleteSubcollection(station.id, 'shifts'),
      deleteSubcollection(station.id, 'pumpSessions'),
    ]);
    invalidateStation(station.id);
    toast(`Station reset — deleted ${shifts + sessions} data record${shifts + sessions === 1 ? '' : 's'}.`, 'success');
    window.dispatchEvent(new CustomEvent('pumplog:dataChanged', { detail: { stationId: station.id } }));
    rerender();
  } catch (err) {
    console.error('Station reset error:', err);
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
      <label>${user.role === 'staff' ? 'Full name' : 'Email'}</label>
      <input type="text" value="${h(user.role === 'staff' ? (user.fullName || user.username || '') : (user.email || ''))}" disabled />
      <small class="hint">Identity credentials are managed by the secure account flow.</small>
    </div>
  ` : `
    <div id="credential-fields"></div>
  `;
  const legacyCredentialFields = `
    <div class="field"><label for="new-email">Email</label>
      <input type="email" id="new-email" placeholder="admin@example.com" required autocomplete="off" autocapitalize="off" spellcheck="false" /></div>
    <div class="field"><label for="new-password">Temporary password</label>
      <input type="password" id="new-password" placeholder="At least 6 characters" minlength="6" required autocomplete="new-password" /></div>`;
  const staffCredentialFields = `
    <div class="field"><label for="new-full-name">Full name</label>
      <input type="text" id="new-full-name" placeholder="e.g. John Smith" maxlength="80" required autocomplete="name" /></div>
    <div class="field"><label for="new-username">Username</label>
      <input type="text" id="new-username" placeholder="john.smith" minlength="4" maxlength="6" pattern="[a-zA-Z0-9_.]+" required autocomplete="username" autocapitalize="off" spellcheck="false" />
      <small id="username-status" class="hint">4–6 characters: letters, numbers, underscore, or dot.</small></div>
    <div class="field"><label for="new-phone">Phone number <span class="optional">(optional)</span></label>
      <input type="tel" id="new-phone" placeholder="+1 555 123 4567" autocomplete="tel" inputmode="tel" /></div>`;

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
  const credentialHost = byId('credential-fields');
  let usernameCheckTimer = null;
  function wireUsernameCheck() {
    const input = byId('new-username');
    const status = byId('username-status');
    if (!input || !status) return;
    input.addEventListener('input', () => {
      const username = input.value.trim().toLowerCase();
      input.value = username;
      status.className = 'hint';
      status.textContent = username.length < 4 ? '4–6 characters: letters, numbers, underscore, or dot.' : 'Checking availability…';
      input.dataset.available = 'false';
      clearTimeout(usernameCheckTimer);
      if (username.length < 4) return;
      usernameCheckTimer = setTimeout(async () => {
        try {
          const result = await checkUsername(username);
          input.dataset.available = String(result.available);
          status.textContent = result.available ? '✓ Username available' : '✕ Username already exists';
          status.classList.toggle('validation-success', result.available);
          status.classList.toggle('validation-error', !result.available);
        } catch (error) {
          input.dataset.available = 'false';
          status.textContent = formatFirebaseError(error);
          status.classList.add('validation-error');
        }
      }, 280);
    });
  }
  function syncCredentialFields() {
    if (!credentialHost) return;
    const staffRole = roleSelect.value === 'staff';
    credentialHost.innerHTML = staffRole ? staffCredentialFields : legacyCredentialFields;
    if (staffRole) wireUsernameCheck();
  }
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
  roleSelect.addEventListener('change', syncCredentialFields);
  syncStationPicker();
  if (!isEdit) syncCredentialFields();

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
    if (!isEdit) {
      pumpFieldset.hidden = true;
      pumpList.innerHTML = '';
      pumpHint.textContent = 'Assign pumps after the staff member activates their account.';
      return;
    }
    pumpFieldset.hidden = false;
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
      } else if (role === 'staff') {
        const fullName = byId('new-full-name').value.trim();
        const username = byId('new-username').value.trim().toLowerCase();
        const phoneNumber = byId('new-phone').value.trim();
        if (!fullName) return failInline(err, btn, 'Enter the staff member’s full name.');
        if (!/^[a-z0-9_.]{4,6}$/.test(username)) return failInline(err, btn, 'Username must be 4–6 characters using letters, numbers, underscore, or dot.');
        const availability = await checkUsername(username);
        if (!availability.available) return failInline(err, btn, 'That username is already in use. Choose another.');
        const result = await createStaff({ fullName, username, phoneNumber, stationIds });
        invalidateUsers();
        closeModal('generic-modal');
        showStaffCreated(result);
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
      if (role !== 'staff') rerender();
    } catch (e2) {
      console.error('User save error:', e2);
      showFieldError(err, formatFirebaseError(e2));
      setBusy(btn, false);
    }
  });
}

async function createStationAdminInvite() {
  const ok = await confirmDialog({
    title: 'Invite a Station Admin?',
    message: 'A one-time 10-digit invite will be generated. Share it privately; the invite expires in 30 days and is usable once.',
    confirmLabel: 'Generate invite',
  });
  if (!ok) return;
  try {
    const result = await createAdminInvite(30);
    byId('modal-title').textContent = 'Station Admin invite created';
    byId('modal-body').innerHTML = `<div class="staff-created-success"><div class="success-check" aria-hidden="true">✓</div><h3>Share this code privately</h3><p class="muted-note">The new Station Admin will create their name, 4–6 character username, phone, and 4-digit PIN when they join.</p><div class="admin-invite-code"><output>${h(result.joiningCode)}</output><small>Expires in ${h(result.expiresInDays)} days · shown once</small></div><button type="button" id="copy-admin-invite" class="btn btn-primary btn-full">Copy 10-digit invite</button></div>`;
    openModal('generic-modal');
    byId('copy-admin-invite')?.addEventListener('click', async event => {
      try { await navigator.clipboard.writeText(result.joiningCode); setBusy(event.currentTarget, true, 'Copied'); setTimeout(() => setBusy(event.currentTarget, false), 1200); }
      catch { toast('Copy failed — write the invite down before closing.', 'error'); }
    });
  } catch (error) {
    toast(formatFirebaseError(error), 'error');
  }
}

async function prepareExistingAccounts() {
  const ok = await confirmDialog({
    title: 'Prepare existing accounts?',
    message: 'This generates usernames and one-time joining codes for existing accounts that do not yet have a secure PIN identity. Existing email/password access is not deleted.',
    confirmLabel: 'Prepare accounts',
  });
  if (!ok) return;
  try {
    const result = await prepareLegacyUsers();
    if (!result.migrated?.length) {
      toast('All visible accounts already have a username and PIN.', 'info');
      return;
    }
    byId('modal-title').textContent = 'Accounts prepared';
    byId('modal-body').innerHTML = `<div class="staff-created-success"><div class="success-check" aria-hidden="true">✓</div><h3>Share each joining code privately</h3><p class="muted-note">These codes are shown once. Each person creates a new 4-digit PIN when they join.</p><div class="migration-code-list">${result.migrated.map(item => `<div class="migration-code-row"><span><strong>${h(item.fullName)}</strong><small>${h(item.username)}</small></span><output>${h(item.joiningCode)}</output><button type="button" class="icon-btn copy-migration-code" data-code="${h(item.joiningCode)}" aria-label="Copy joining code for ${h(item.fullName)}">⧉</button></div>`).join('')}</div></div>`;
    openModal('generic-modal');
    document.querySelectorAll('.copy-migration-code').forEach(button => button.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(button.dataset.code); toast('Joining code copied.', 'success', 1800); }
      catch { toast('Copy failed — write the code down before closing.', 'error'); }
    }));
    invalidateUsers();
    rerender();
  } catch (error) {
    toast(formatFirebaseError(error), 'error');
  }
}

function showStaffCreated(result) {
  const reset = result.isReset === true;
  byId('modal-title').textContent = reset ? 'PIN reset code generated' : 'Staff created successfully';
  byId('modal-body').innerHTML = `<div class="staff-created-success">
    <div class="success-check" aria-hidden="true">✓</div><h3>Share this joining code with ${h(result.fullName || 'the staff member')}</h3>
    <p class="muted-note">The code is shown once. ${reset ? 'Their previous PIN no longer works.' : 'They will create their own 4-digit PIN when they join.'}</p>
    <dl class="staff-created-details"><dt>Name</dt><dd>${h(result.fullName)}</dd><dt>Username</dt><dd>${h(result.username)}</dd><dt>Joining code</dt><dd><output id="created-joining-code">${h(result.joiningCode)}</output></dd></dl>
    <div class="confirm-actions"><button type="button" id="copy-joining-code" class="btn btn-secondary btn-full">Copy code</button><button type="button" id="create-another-staff" class="btn btn-primary btn-full">Create another</button></div>
  </div>`;
  openModal('generic-modal');
  byId('copy-joining-code')?.addEventListener('click', async event => {
    try {
      await navigator.clipboard.writeText(result.joiningCode);
      setBusy(event.currentTarget, true, 'Copied');
      setTimeout(() => setBusy(event.currentTarget, false), 1200);
    } catch { toast('Copy failed — write the code down before closing.', 'error'); }
  });
  byId('create-another-staff')?.addEventListener('click', async () => {
    closeModal('generic-modal');
    await showUserForm(null);
  });
}

async function resetStaffPinForUser(user) {
  if (!user || !can('user.update', { target: user })) {
    toast(denyReason('user.update', { target: user }), 'error');
    return;
  }
  const ok = await confirmDialog({
    title: 'Reset PIN?',
    message: `Reset ${user.fullName || user.email || user.username || 'this staff member'}’s PIN? A new temporary joining code will be generated and their current PIN will stop working.`,
    confirmLabel: 'Reset PIN',
    danger: true,
  });
  if (!ok) return;
  try {
    const result = await resetStaffPin(user.id);
    showStaffCreated({ ...result, isReset: true, fullName: result.fullName || user.fullName || user.email });
    invalidateUsers();
  } catch (error) {
    console.error('PIN reset error:', error);
    toast(formatFirebaseError(error), 'error');
  }
}

async function disableStaffUser(user) {
  if (!user || !can('user.delete', { target: user })) {
    toast(denyReason('user.delete', { target: user }), 'error');
    return;
  }
  const ok = await confirmDialog({
    title: 'Disable staff account?',
    message: `${user.fullName || user.username || 'This staff member'} will be unable to sign in. Existing history and pump assignments will remain for audit purposes.`,
    confirmLabel: 'Disable account',
    danger: true,
  });
  if (!ok) return;
  try {
    await disableStaff(user.id);
    invalidateUsers();
    toast('Staff account disabled.', 'success');
    rerender();
  } catch (error) {
    console.error('Disable staff error:', error);
    toast(formatFirebaseError(error), 'error');
  }
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
