/* PumpLog — Config page (Profile, Station Security, Rates, Pumps, Stations, Team) */

import {
  getDb, collection, doc, addDoc, updateDoc, deleteDoc, getDocs, query, limit,
  serverTimestamp, writeBatch,
} from './firebase.js';
import {
  getCurrentUserData, isSuperAdmin,
  can, ifCan, denyReason, assignableRoles, ROLES, ROLE_BADGE, formatFirebaseError,
} from './auth.js';
import {
  getAllStations, getStationsByIds, getRates, getPumps, getPumpSessions,
  getManageableUsers,
  invalidateStation, invalidateStations, invalidateUsers,
} from './store.js';
import {
  h, formatCurrency, formatDate, formatDateTime, getTodayDate,
  openModal, closeModal, emptyState, toast, toastSuccess, toastError,
  confirmDialog, confirmSave, confirmDelete, setBusy, showSkeleton, debounce, ICONS,
} from './components.js';
import {
  DEFAULT_SECURITY, normalizeSecurity, getSecuritySettings, saveSecuritySettings,
  mergeSecurity, validateCloudPinPolicy,
  PIN_COMPLEXITY_OPTIONS, isValidEmail,
} from './station-settings.js';
import {
  createUserAccount, updateUserAccount, removeUserAccount,
} from './staff-auth.js';
import { openProfileModal, avatarHTML } from './profile.js';

let currentStationId = null;
let stationsCache = [];
let teamCache = [];
let teamSearch = '';

export function initConfig() {}

const rerender = () => renderConfig(currentStationId);
const byId = id => document.getElementById(id);
const onClick = (id, fn) => byId(id)?.addEventListener('click', fn);
const onEach = (sel, fn) => document.querySelectorAll(sel).forEach(el =>
  el.addEventListener('click', () => fn(el.dataset.id, el)));

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
    const [rates, pumps, sessions, stations, users, security] = await Promise.all([
      stationId ? getRates(stationId) : [],
      stationId ? getPumps(stationId) : [],
      stationId ? getPumpSessions(stationId) : [],
      isSuperAdmin() ? getAllStations() : getStationsByIds(me.stationIds || []),
      getManageableUsers(me.stationIds || []),
      stationId ? getSecuritySettings(stationId) : { ...DEFAULT_SECURITY },
    ]);
    stationsCache = stations;
    teamCache = users;

    // Config is intentionally a shared page, but every topic has its own
    // permission gate. Passing config.view never exposes unrelated controls.
    const selectedStation = stations.find(station => station.id === stationId) || null;
    const sections = [
      renderProfileSection(me, stations, pumps),
      ifCan('stationSecurity.update', { stationId }, renderStationSecuritySection(stationId, security)),
      ifCan('rate.update', { stationId }, renderRatesSection(stationId, rates)),
      ifCan('pump.update', { stationId }, renderPumpsSection(stationId, pumps, sessions)),
      ifCan('station.create', {}, renderStationsSection(stations)),
      ifCan('station.reset', { stationId }, renderStationDataSection(selectedStation)),
      ifCan('team.view', {}, renderTeamSection(users, me)),
      renderSecuritySection(),
    ].filter(Boolean).join('');

    content.innerHTML = `<h2 class="page-title">Settings</h2>${sections}`;
    wireHandlers(rates, pumps, sessions, stations, users);
  } catch (err) {
    content.innerHTML = emptyState('⚠️', formatFirebaseError(err));
  }
}

// ── Profile ─────────────────────────────────────────────────────────────
function renderProfileSection(me, stations, pumps) {
  const stationText = isSuperAdmin()
    ? 'All stations'
    : (stations || []).filter(station => (me.stationIds || []).includes(station.id)).map(station => station.name).join(', ') || 'No stations assigned';
  const pumpText = me.role === 'staff'
    ? (me.pumpIds?.length
        ? `${me.pumpIds.length} usual pump${me.pumpIds.length === 1 ? '' : 's'} · plus today’s staff board`
        : 'Set on the Who’s where page')
    : `${(pumps || []).length || 'All'} pumps visible at this station`;
  return section('Profile', '', `<div class="profile-card-grid">
    <div class="profile-card-identity">${avatarHTML(me, 'medium')}<div><strong>${h(me.fullName || me.email || 'PumpLog user')}</strong><small>${h(me.email || (me.username ? `@${me.username}` : ''))}</small></div></div>
    <dl class="profile-settings-list"><dt>Role</dt><dd><span class="role-badge">${ROLE_BADGE[me.role] || '⚪'} ${h(ROLES[me.role] || me.role || 'Staff')}</span></dd>
      <dt>Assigned stations</dt><dd>${h(stationText)}</dd><dt>Pump access</dt><dd>${h(pumpText)}</dd></dl>
    <div class="profile-account-actions"><button type="button" id="config-open-profile" class="btn btn-primary btn-full">${ICONS.user} Profile &amp; security</button></div>
  </div>`);
}

// ── Station Security (sign-in methods, App Lock, credential policies) ───
function renderStationSecuritySection(stationId, security) {
  if (!stationId) {
    return section('Station Security', '', emptyState('🛡️', 'Select a station from the top bar to manage its security settings.'));
  }
  const s = normalizeSecurity(security);

  const toggle = (name, label, hint, checked) => `
    <label class="toggle-row">
      <span class="toggle-text">${h(label)}${hint ? `<small>${h(hint)}</small>` : ''}</span>
      <input type="checkbox" class="toggle-input" role="switch" name="${name}" ${checked ? 'checked' : ''} />
    </label>`;

  const number = (name, label, value, min, max, hint = '') => `
    <div class="field"><label for="sec-${name}">${h(label)}</label>
      <input type="number" id="sec-${name}" name="${name}" value="${value}" min="${min}" max="${max}" inputmode="numeric" />
      ${hint ? `<small class="hint">${h(hint)}</small>` : ''}</div>`;

  const select = (name, label, options, value) => `
    <div class="field"><label for="sec-${name}">${h(label)}</label>
      <select id="sec-${name}" name="${name}">${options.map(([v, l]) =>
        `<option value="${v}" ${v === value ? 'selected' : ''}>${h(l)}</option>`).join('')}</select></div>`;

  const body = `
    <div class="settings-group">
      <h4 class="settings-group-title">🔑 Sign-in method</h4>
      <p class="section-hint">Free mode keeps sign-in simple: email + Cloud PIN using Firebase Authentication. No Cloud Functions or pay-as-you-go APIs are used.</p>
      ${toggle('enablePinLogin', 'Enable Cloud PIN Login', 'Allow email + Cloud PIN sign-in for this station.', s.enablePinLogin)}
    </div>
    <div class="settings-group">
      <h4 class="settings-group-title">📱 App Lock (device-level)</h4>
      <p class="section-hint">App Lock is device-specific and never synced. Staff set their local PIN once per device.</p>
      ${toggle('appLockEnabled', 'Enable App Lock', 'Require a local App Lock PIN on devices.', s.appLockEnabled)}
      ${toggle('appLockOnRefresh', 'Auto-lock on refresh', 'Lock immediately after a browser refresh.', s.appLockOnRefresh)}
      ${toggle('appLockOnPwaReopen', 'Auto-lock on PWA reopen', 'Lock when the installed app is closed and reopened.', s.appLockOnPwaReopen)}
      ${toggle('appLockOnInactivity', 'Auto-lock after inactivity', 'Lock when nobody interacts with the app.', s.appLockOnInactivity)}
      ${number('appLockTimeoutMinutes', 'Auto-lock timeout (minutes)', s.appLockTimeoutMinutes, 1, 120, 'Applies to inactivity and backgrounded tabs.')}
    </div>
    <div class="settings-group">
      <h4 class="settings-group-title">🛡️ Cloud PIN policy</h4>
      <div class="form-row">
        ${number('minPinLength', 'Minimum Cloud PIN length', s.minPinLength, 4, 8, 'Between 4 and 8 digits.')}
        ${select('pinComplexity', 'Cloud PIN complexity', PIN_COMPLEXITY_OPTIONS, s.pinComplexity)}
      </div>
      ${number('pinRotationDays', 'Force Cloud PIN rotation after (days)', s.pinRotationDays, 0, 365, '0 = never force rotation. The new PIN is required at the next sign-in.')}
    </div>
    ${ifCan('stationSecurity.update', { stationId }, `<button type="button" id="save-station-security" class="btn btn-primary btn-full mt-16">${ICONS.save} Save security settings</button>`)}`;

  return section('Station Security', '', body);
}

function wireStationSecurity(stationId) {
  onClick('save-station-security', async event => {
    if (!can('stationSecurity.update', { stationId })) {
      toastError(denyReason('stationSecurity.update', { stationId }));
      return;
    }
    const button = event.currentTarget;
    const read = name => {
      const el = document.querySelector(`[name="${name}"]`);
      if (!el) return undefined;
      if (el.type === 'checkbox') return el.checked;
      if (el.type === 'number') return Number(el.value);
      return el.value;
    };
    const patch = normalizeSecurity({
      enableEmailLogin: read('enableEmailLogin'),
      enableUsernameLogin: false,
      enablePasswordLogin: false,
      enablePinLogin: read('enablePinLogin'),
      appLockEnabled: read('appLockEnabled'),
      appLockOnRefresh: read('appLockOnRefresh'),
      appLockOnPwaReopen: read('appLockOnPwaReopen'),
      appLockOnInactivity: read('appLockOnInactivity'),
      appLockTimeoutMinutes: read('appLockTimeoutMinutes'),
      minPasswordLength: DEFAULT_SECURITY.minPasswordLength,
      minPinLength: read('minPinLength'),
      passwordComplexity: DEFAULT_SECURITY.passwordComplexity,
      pinComplexity: read('pinComplexity'),
      pinRotationDays: read('pinRotationDays'),
    });
    if (!patch.enableEmailLogin || !patch.enablePinLogin) {
      toastError('Validation failed — email + Cloud PIN sign-in must stay enabled in free mode.');
      return;
    }
    const station = stationsCache.find(s => s.id === stationId);
    const ok = await confirmSave(`the security settings for ${station?.name || 'this station'}`);
    if (!ok) return;
    setBusy(button, true, 'Saving…');
    try {
      await saveSecuritySettings(stationId, patch);
      toastSuccess('Security Settings Saved');
      rerender();
    } catch (err) {
      toastError(formatFirebaseError(err));
      setBusy(button, false);
    }
  });
}

// ── Rates ───────────────────────────────────────────────────────────────
function renderRatesSection(stationId, rates) {
  const addBtn = ifCan('rate.create', { stationId },
    `<button id="add-rate-btn" class="btn btn-primary btn-small">${ICONS.add} Add rate</button>`);

  if (!stationId) {
    return section('Rates', '', emptyState('🏪', 'Select a station from the top bar to manage its rates.'));
  }

  if (rates.length === 0) {
    return section('Rates', addBtn, emptyState('💰', 'No rates yet. Add one to start tracking sales.'));
  }

  // E3: Dedupe to latest rate per product (rates already sorted by effectiveDate desc)
  const latestPerProduct = new Map();
  for (const r of rates) {
    if (!latestPerProduct.has(r.product)) {
      latestPerProduct.set(r.product, r);
    }
  }
  const displayRates = [...latestPerProduct.values()];

  const items = displayRates.map(r => configItem({
    title: `${h(r.product)} — ${formatCurrency(r.rate)}/L`,
    meta: `Effective ${formatDate(r.effectiveDate)}`,
    actions: [
      { action: 'rate.update', ctx: { stationId }, cls: 'edit-rate', id: r.id, icon: ICONS.edit, text: 'Edit', label: `Edit ${r.product} rate` },
      { action: 'rate.delete', ctx: { stationId }, cls: 'delete-rate', id: r.id, icon: ICONS.delete, text: 'Delete', label: `Delete ${r.product} rate` },
    ],
  })).join('');

  return section('Rates', addBtn, items);
}

// ── Pumps ───────────────────────────────────────────────────────────────
function renderPumpsSection(stationId, pumps, sessions = []) {
  if (!stationId) return '';
  const addBtn = ifCan('pump.create', { stationId },
    `<button id="add-pump-btn-cfg" class="btn btn-primary btn-small">${ICONS.add} Add pump</button>`);

  if (pumps.length === 0) {
    return section('Pumps', addBtn, emptyState('⛽', 'No pumps configured for this station.'));
  }

  const items = pumps.map(p => {
    const session = sessions.find(s => s.id === p.id && s.status === 'active');
    const actions = [
      { action: 'pump.update', ctx: { stationId }, cls: 'edit-pump', id: p.id, icon: ICONS.edit, text: 'Edit', label: `Edit ${p.name}` },
      { action: 'pump.delete', ctx: { stationId }, cls: 'delete-pump', id: p.id, icon: ICONS.delete, text: 'Delete', label: `Delete ${p.name}` },
    ];
    if (session) {
      actions.push({ action: 'pumpSession.forceRelease', ctx: { stationId }, cls: 'force-release', id: p.id, icon: ICONS.unlock, text: 'Release', label: `Release ${p.name} without saving` });
    }
    const active = session
      ? ` · Active since ${formatDateTime(session.clockInAt) || 'just now'} · ${h(session.activeName || 'Staff member')}`
      : '';
    const initReading = p.initialReading != null ? ` · Init: ${Number(p.initialReading).toFixed(2)}` : '';
    return configItem({ title: h(p.name), meta: `${h(p.product || 'No product set')}${initReading}${active}`, actions });
  }).join('');

  return section('Pumps', addBtn, items);
}

// ── Stations (Super Admin) ──────────────────────────────────────────────
function renderStationsSection(stations) {
  const addBtn = ifCan('station.create', {},
    `<button id="add-station-btn" class="btn btn-primary btn-small">${ICONS.add} Create station</button>`);

  if (stations.length === 0) {
    return section('Stations', addBtn, emptyState('🏪', 'No stations yet. Create your first one.'));
  }

  const items = stations.map(s => {
    const actions = [
      { action: 'station.update', ctx: {}, cls: 'edit-station', id: s.id, icon: ICONS.edit, text: 'Edit', label: `Edit ${s.name}` },
      { action: 'station.delete', ctx: {}, cls: 'delete-station', id: s.id, icon: ICONS.delete, text: 'Delete', label: `Delete ${s.name}` },
    ];
    return configItem({
      title: h(s.name),
      meta: h(s.address || 'No address'),
      actions,
    });
  }).join('');

  return section('Stations', addBtn, items);
}

// ── Station data reset (all station overseers) ──────────────────────────
function renderStationDataSection(station) {
  if (!station) return '';
  const action = ifCan('station.reset', { stationId: station.id }, `
    <button type="button" class="btn btn-danger btn-full reset-station" data-id="${h(station.id)}">
      ♻️ Reset shift history and live locks
    </button>`);
  return section('Station data', '', `
    <p class="section-hint">Use this only when you need a clean start. Pumps, rates, and team members are kept.</p>
    ${action}`);
}

// ── Team ────────────────────────────────────────────────────────────────
function statusTag(user) {
  const status = user.status || 'active';
  if (status === 'disabled') return '<span class="tag tag-off">Inactive</span>';
  if (status === 'invited') return '<span class="tag tag-invited">Invited</span>';
  return '<span class="tag tag-on">Active</span>';
}

function renderTeamSection(users, me) {
  const addBtn = ifCan('user.create', {},
    `<button id="add-team-btn" class="btn btn-primary btn-small">${ICONS.add} Add team member</button>`);

  const hint = isSuperAdmin()
    ? 'Every PumpLog account. You cannot change your own role here.'
    : 'People at your stations. Controls only appear for accounts you are allowed to manage.';

  const searchBar = users.length > 4 ? `
    <div class="field search-field">
      <label for="team-search" class="sr-only">Search team</label>
      <div class="input-affix search-affix">
        <input type="search" id="team-search" placeholder="Search by name, username, or email" value="${h(teamSearch)}" />
        <span class="affix-btn affix-static" aria-hidden="true">${ICONS.search}</span>
      </div>
    </div>` : '';

  const term = teamSearch.trim().toLowerCase();
  const visible = term
    ? users.filter(u => [u.fullName, u.email, u.username, u.employeeId].some(v => (v || '').toLowerCase().includes(term)))
    : users;

  const listBody = users.length === 0
    ? emptyState('👥', 'No team members yet.')
    : visible.length === 0
      ? emptyState(ICONS.search, 'No team members match your search.')
      : visible.map(user => teamItemHTML(user, me)).join('');

  return section('Team', addBtn, `<p class="section-hint">${h(hint)}</p>${searchBar}<div id="team-list">${listBody}</div>`);
}

function repaintTeamList(me) {
  const host = byId('team-list');
  if (!host) return;
  const term = teamSearch.trim().toLowerCase();
  const visible = term
    ? teamCache.filter(u => [u.fullName, u.email, u.username, u.employeeId].some(v => (v || '').toLowerCase().includes(term)))
    : teamCache;
  host.innerHTML = visible.length
    ? visible.map(user => teamItemHTML(user, me)).join('')
    : emptyState(ICONS.search, 'No team members match your search.');
  wireTeamActions(visible);
}

function teamItemHTML(u, me) {
  const isMe = u.id === me.uid;
  const stationIds = u.stationIds || [];
  const nameOf = id => stationsCache.find(s => s.id === id)?.name || 'Unknown station';
  const stationText = u.role === 'superadmin'
    ? 'All stations'
    : stationIds.length === 0
      ? 'No stations assigned'
      : stationIds.map(nameOf).join(', ');
  const pumpText = u.role === 'staff'
    ? (u.pumpIds?.length ? `${u.pumpIds.length} pump${u.pumpIds.length === 1 ? '' : 's'}` : 'all pumps')
    : null;

  const targetCtx = { target: u };
  const actions = [
    { action: 'user.update', ctx: targetCtx, cls: 'edit-user', id: u.id, icon: ICONS.edit, text: 'Edit', label: `Edit ${u.fullName || u.email}` },
    u.status === 'disabled'
      ? { action: 'user.update', ctx: targetCtx, cls: 'activate-user', id: u.id, icon: '▶️', text: 'Activate', label: `Activate ${u.fullName || u.email}` }
      : { action: 'user.delete', ctx: targetCtx, cls: 'remove-user', id: u.id, icon: ICONS.delete, text: 'Remove access', label: `Remove access for ${u.fullName || u.email}` },
  ];
  const actionButtons = actions.map(a => ifCan(a.action, a.ctx, `
    <button class="btn btn-secondary btn-small item-action-btn ${a.cls}" data-id="${h(a.id)}" aria-label="${h(a.label)}">${a.icon} <span>${h(a.text || a.label)}</span></button>`)).join('');

  return `<div class="config-item team-item">
    ${avatarHTML(u, 'small')}
    <div class="item-info">
      <div class="item-title">${h(u.fullName || u.email || u.username || 'Unnamed user')}${isMe ? ' <span class="tag tag-you">You</span>' : ''} ${statusTag(u)}${u.pwaLoginAllowed === false ? ' <span class="tag tag-off">PWA off</span>' : ''}</div>
      <div class="item-meta">${ROLE_BADGE[u.role] || '⚪'} ${h(ROLES[u.role] || u.role)}${u.username ? ` · @${h(u.username)}` : ''}${u.email ? ` · ${h(u.email)}` : ''}${u.employeeId ? ` · ID ${h(u.employeeId)}` : ''} · ${h(stationText)}${pumpText ? ` · ${h(pumpText)}` : ''}</div>
    </div>
    ${actionButtons ? `<div class="item-actions">${actionButtons}</div>` : ''}
  </div>`;
}

// ── Security info ───────────────────────────────────────────────────────
function renderSecuritySection() {
  return section('Security', '', `<div class="security-grid">
    <article class="security-card"><span class="security-card-icon" aria-hidden="true">🔐</span><div><strong>Firebase Auth sign-in</strong><p>Each person stays signed in on their device until they choose Sign out. Firebase Auth and Firestore rules remain the authority.</p></div></article>
    <article class="security-card"><span class="security-card-icon" aria-hidden="true">🔒</span><div><strong>One pump, one active shift</strong><p>A live Firestore transaction locks a pump to one staff member. Clock-out releases it atomically with the saved shift record.</p></div></article>
    <article class="security-card"><span class="security-card-icon" aria-hidden="true">🛡️</span><div><strong>Role-based access</strong><p>Staff see their assigned pumps and records. Station Admins manage their stations. Super Admins manage every station. UI checks never replace server rules.</p></div></article>
    <article class="security-card"><span class="security-card-icon" aria-hidden="true">📱</span><div><strong>App Lock is local</strong><p>App Lock PINs and security answers never leave the device. Cloud PIN sign-in uses Firebase Authentication directly, without Cloud Functions or paid APIs.</p></div></article>
  </div><p class="security-note">For recovery, managers can force-release an active lock from the Pumps section. This discards the unfinished reading and does not create a shift.</p>`);
}

// ── Markup helpers ──────────────────────────────────────────────────────
const SECTION_META = {
  Profile: { icon: '👤', description: 'Your account, role, station, and security settings.' },
  'Station Security': { icon: '🛡️', description: 'Sign-in methods, App Lock, and credential policies for this station.' },
  Rates: { icon: '₹', description: 'Set the prices used to calculate each shift.' },
  Pumps: { icon: '⛽', description: 'Manage pumps, products, and pumps that still show active.' },
  Stations: { icon: '🏪', description: 'Create, rename, or remove stations.' },
  'Station data': { icon: '♻️', description: 'Clear shift history and stuck pump locks for this station.' },
  Team: { icon: '👥', description: 'Create and manage people and their station access.' },
  Security: { icon: '🔒', description: 'How Firebase protects PumpLog accounts and data.' },
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

function configItem({ title, meta, actions = [] }) {
  const buttons = actions.map(a => ifCan(a.action, a.ctx, `
    <button class="btn btn-secondary btn-small item-action-btn ${a.cls}" data-id="${h(a.id)}"
            aria-label="${h(a.label)}">${a.icon} <span>${h(a.text || a.label)}</span></button>
  `)).join('');

  return `<div class="config-item">
    <div class="item-info">
      <div class="item-title">${title}</div>
      <div class="item-meta">${meta}</div>
    </div>
    ${buttons ? `<div class="item-actions">${buttons}</div>` : ''}
  </div>`;
}

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
  wireConfigAccordion();
  wireStationSecurity(currentStationId);
  onClick('config-open-profile', () => openProfileModal({ stations }));

  onClick('add-rate-btn', () => showRateForm(null));
  onEach('.edit-rate', id => showRateForm(rates.find(r => r.id === id)));
  onEach('.delete-rate', id => deleteRate(rates.find(r => r.id === id)));

  onClick('add-pump-btn-cfg', () => showPumpForm(null));
  onEach('.edit-pump', id => showPumpForm(pumps.find(p => p.id === id)));
  onEach('.delete-pump', id => deletePump(pumps.find(p => p.id === id)));
  onEach('.force-release', (id, button) => forceReleasePump(pumps.find(p => p.id === id), sessions.find(s => s.id === id), button));

  onClick('add-station-btn', () => showStationForm(null));
  onEach('.edit-station', id => showStationForm(stations.find(s => s.id === id)));
  onEach('.delete-station', id => deleteStation(stations.find(s => s.id === id)));
  onEach('.reset-station', (id, button) => resetStationData(stations.find(s => s.id === id), button));

  onClick('add-team-btn', async event => {
    setBusy(event.currentTarget, true, 'Loading…');
    try { await showUserForm(null); }
    catch (err) { toastError(formatFirebaseError(err)); }
    finally { setBusy(event.currentTarget, false); }
  });
  wireTeamActions(users);

  const searchInput = byId('team-search');
  if (searchInput) {
    searchInput.addEventListener('input', debounce(() => {
      teamSearch = searchInput.value;
      repaintTeamList(getCurrentUserData());
    }, 160));
  }
}

function wireTeamActions(users) {
  onEach('.edit-user', async (id, button) => {
    setBusy(button, true, 'Loading…');
    try { await showUserForm(users.find(u => u.id === id)); }
    catch (err) { toastError(formatFirebaseError(err)); }
    finally { setBusy(button, false); }
  });
  onEach('.activate-user', (id, button) => activateUser(users.find(u => u.id === id), button));
  onEach('.remove-user', (id, button) => removeUser(users.find(u => u.id === id), button));
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

  if (!currentStationId) {
    toastError('Select a station before adding a rate.');
    return;
  }
  if (!can(action, { stationId: currentStationId })) {
    toastError(denyReason(action));
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
      <button type="submit" class="btn btn-primary btn-full">${isEdit ? `Save ${ICONS.save}` : `${ICONS.add} Add rate`}</button>
    </form>
  `);

  byId('rate-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.currentTarget.querySelector('button[type="submit"]');
    const err = byId('rate-form-error');

    const product = byId('rate-product').value;
    const rateValue = parseFloat(byId('rate-value').value);
    const effectiveDate = byId('rate-date').value;

    if (!product) return showFieldError(err, '❌ Choose a product.');
    if (!Number.isFinite(rateValue) || rateValue <= 0) return showFieldError(err, '❌ Enter a rate greater than zero.');
    if (!effectiveDate) return showFieldError(err, '❌ Choose an effective date.');

    err.classList.add('hidden');
    if (isEdit && !(await confirmSave(`the ${product} rate`))) return;
    setBusy(btn, true, 'Saving…');

    try {
      const payload = { product, rate: rateValue, effectiveDate };
      const db = getDb();

      if (isEdit) {
        await updateDoc(doc(db, 'stations', currentStationId, 'rates', rate.id), {
          ...payload, updatedAt: serverTimestamp(),
        });
      } else {
        await addDoc(collection(db, 'stations', currentStationId, 'rates'), {
          ...payload,
          createdBy: getCurrentUserData()?.uid || 'unknown',
          createdAt: serverTimestamp(),
        });
      }

      invalidateStation(currentStationId);
      closeModal('generic-modal');
      toastSuccess(isEdit ? 'Changes Saved' : 'Rate Added');
      rerender();
    } catch (e2) {
      showFieldError(err, `❌ ${formatFirebaseError(e2)}`);
      setBusy(btn, false);
    }
  });
}

async function deleteRate(rate) {
  if (!rate || !can('rate.delete', { stationId: currentStationId })) {
    toastError(denyReason('rate.delete'));
    return;
  }
  const ok = await confirmDelete(`${rate.product} at ${formatCurrency(rate.rate)}/L effective ${formatDate(rate.effectiveDate)} will be removed. Existing shift records keep their saved rate.`);
  if (!ok) return;

  try {
    await deleteDoc(doc(getDb(), 'stations', currentStationId, 'rates', rate.id));
    invalidateStation(currentStationId);
    toastSuccess('Rate Deleted');
    rerender();
  } catch (err) {
    toastError(formatFirebaseError(err));
  }
}

// ── Pump form ───────────────────────────────────────────────────────────
function showPumpForm(pump) {
  const isEdit = !!pump;
  const action = isEdit ? 'pump.update' : 'pump.create';
  if (!can(action, { stationId: currentStationId })) {
    toastError(denyReason(action));
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
      <!-- E2: Initial reading (optional, default 0) -->
      <div class="field">
        <label for="pump-initial-reading">Initial reading <span class="optional">(optional)</span></label>
        <input type="number" id="pump-initial-reading" step="0.01" min="0" inputmode="decimal"
               placeholder="0.00" value="${pump?.initialReading ?? ''}" />
        <small class="hint">Sets the opening reading for the pump's very first shift. After that, the last closing reading is used.</small>
      </div>
      <p class="form-error hidden" id="pump-form-error" role="alert"></p>
      <button type="submit" class="btn btn-primary btn-full">${isEdit ? `Save ${ICONS.save}` : `${ICONS.add} Add pump`}</button>
    </form>
  `);

  byId('pump-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.currentTarget.querySelector('button[type="submit"]');
    const err = byId('pump-form-error');
    const name = byId('pump-name').value.trim();
    const product = byId('pump-product').value;
    const initialReadingRaw = byId('pump-initial-reading')?.value;
    const initialReading = initialReadingRaw ? parseFloat(initialReadingRaw) : null;

    if (!name) return showFieldError(err, '❌ Enter a pump name.');
    if (!product) return showFieldError(err, '❌ Choose a product.');
    if (initialReading !== null && (!Number.isFinite(initialReading) || initialReading < 0)) {
      return showFieldError(err, '❌ Initial reading must be zero or greater.');
    }

    err.classList.add('hidden');
    if (isEdit && !(await confirmSave(`pump ${name}`))) return;
    setBusy(btn, true, 'Saving…');

    try {
      const db = getDb();
      const payload = { name, product };
      if (initialReading !== null) payload.initialReading = initialReading;
      if (isEdit) {
        await updateDoc(doc(db, 'stations', currentStationId, 'pumps', pump.id), {
          ...payload, updatedAt: serverTimestamp(),
        });
      } else {
        await addDoc(collection(db, 'stations', currentStationId, 'pumps'), {
          ...payload,
          createdBy: getCurrentUserData()?.uid || 'unknown',
          createdAt: serverTimestamp(),
        });
      }
      invalidateStation(currentStationId);
      closeModal('generic-modal');
      toastSuccess(isEdit ? 'Changes Saved' : 'Pump Added');
      rerender();
    } catch (e2) {
      showFieldError(err, `❌ ${formatFirebaseError(e2)}`);
      setBusy(btn, false);
    }
  });
}

async function deletePump(pump) {
  if (!pump || !can('pump.delete', { stationId: currentStationId })) {
    toastError(denyReason('pump.delete'));
    return;
  }
  const ok = await confirmDelete(`“${pump.name}” will be removed. Past shift records for this pump are kept.`);
  if (!ok) return;

  try {
    await deleteDoc(doc(getDb(), 'stations', currentStationId, 'pumps', pump.id));
    invalidateStation(currentStationId);
    toastSuccess('Pump Deleted');
    rerender();
  } catch (err) {
    toastError(formatFirebaseError(err));
  }
}

// ── Live lock recovery ──────────────────────────────────────────────────
async function forceReleasePump(pump, session, button = null) {
  if (!pump || !session || !can('pumpSession.forceRelease', { stationId: currentStationId })) {
    toastError(denyReason('pumpSession.forceRelease'));
    return;
  }
  const started = formatDateTime(session.clockInAt) || 'an unknown time';
  const startedBy = session.activeName || 'an unknown staff member';
  const ok = await confirmDialog({
    title: `${ICONS.warning} Force-Release Pump`,
    message: `Pump ${pump.name} has been active since ${started}, started by ${startedBy}. Force-release it without saving a shift record?`,
    confirmLabel: `Force release ${ICONS.unlock}`,
    danger: true,
  });
  if (!ok) return;
  setBusy(button, true, 'Releasing…');
  try {
    // E1: Include pumpName and product explicitly so sessionFieldsOk() passes
    await updateDoc(doc(getDb(), 'stations', currentStationId, 'pumpSessions', pump.id), {
      status: 'idle', activeUid: null, activeName: null, clockInAt: null, opening: null,
      date: null, shiftLabel: null,
      pumpName: pump.name || 'Pump',
      product: pump.product || '',
      updatedAt: serverTimestamp(),
      updatedBy: getCurrentUserData()?.uid || 'unknown',
    });
    invalidateStation(currentStationId);
    toastSuccess(`${pump.name} released`);
    window.dispatchEvent(new CustomEvent('pumplog:dataChanged', { detail: { stationId: currentStationId } }));
  } catch (err) {
    toastError(formatFirebaseError(err));
    setBusy(button, false);
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

async function resetStationData(station, button = null) {
  if (!station || !can('station.reset', { stationId: station.id })) {
    toastError(denyReason('station.reset'));
    return;
  }
  const ok = await confirmDialog({
    title: `${ICONS.warning} Reset ${station.name}?`,
    message: `This permanently deletes every shift record and clears every active pump at ${station.name}. Pumps, rates, and team members will not be changed. This cannot be undone.`,
    confirmLabel: `Reset station data ${ICONS.delete}`,
    danger: true,
    confirmationText: station.name,
  });
  if (!ok) return;
  setBusy(button, true, 'Resetting…');
  try {
    const [shifts, sessions] = await Promise.all([
      deleteSubcollection(station.id, 'shifts'),
      deleteSubcollection(station.id, 'pumpSessions'),
    ]);
    invalidateStation(station.id);
    toastSuccess('Station Reset', 4000);
    toast(`Deleted ${shifts + sessions} data record${shifts + sessions === 1 ? '' : 's'}.`, 'info');
    window.dispatchEvent(new CustomEvent('pumplog:dataChanged', { detail: { stationId: station.id } })); 
    rerender();
  } catch (err) {
    toastError(formatFirebaseError(err));
    setBusy(button, false);
  }
}

// ── Station form ────────────────────────────────────────────────────────
function showStationForm(station) {
  const isEdit = !!station;
  const action = isEdit ? 'station.update' : 'station.create';
  if (!can(action)) {
    toastError(denyReason(action));
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
      <button type="submit" class="btn btn-primary btn-full">${isEdit ? `Save ${ICONS.save}` : `${ICONS.add} Create station`}</button>
    </form>
  `);

  byId('station-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.currentTarget.querySelector('button[type="submit"]');
    const err = byId('station-form-error');
    const name = byId('station-name').value.trim();
    const address = byId('station-address').value.trim();

    if (!name) return showFieldError(err, '❌ Enter a station name.');

    err.classList.add('hidden');
    if (isEdit && !(await confirmSave(`station ${name}`))) return;
    setBusy(btn, true, 'Saving…');

    try {
      const db = getDb();
      if (isEdit) {
        await updateDoc(doc(db, 'stations', station.id), { name, address, updatedAt: serverTimestamp() });
        invalidateStations();
        closeModal('generic-modal');
        toastSuccess('Changes Saved');
        window.dispatchEvent(new CustomEvent('pumplog:stationsChanged', { detail: { stationId: station.id } }));
      } else {
        const ref = await addDoc(collection(db, 'stations'), {
          name, address,
          createdBy: getCurrentUserData()?.uid || 'unknown',
          createdAt: serverTimestamp(),
        });
        invalidateStations();
        closeModal('generic-modal');
        toastSuccess('Station Created');
        window.dispatchEvent(new CustomEvent('pumplog:stationsChanged', { detail: { stationId: ref.id } }));
      }
    } catch (e2) {
      showFieldError(err, `❌ ${formatFirebaseError(e2)}`);
      setBusy(btn, false);
    }
  });
}

async function deleteStation(station) {
  if (!station || !can('station.delete')) {
    toastError(denyReason('station.delete'));
    return;
  }
  const ok = await confirmDelete(`“${station.name}” will be removed from the station list. Its rates, pumps and shift records stay in Firestore and are no longer reachable from the app.`);
  if (!ok) return;

  try {
    await deleteDoc(doc(getDb(), 'stations', station.id));
    invalidateStations();
    toastSuccess('Station Deleted');
    window.dispatchEvent(new CustomEvent('pumplog:stationsChanged', { detail: { stationId: null } }));
  } catch (err) {
    toastError(formatFirebaseError(err));
  }
}

// ═══════════════════════════════════════════════════════════════════════
//  User create / edit
// ═══════════════════════════════════════════════════════════════════════
async function showUserForm(user) {
  const isEdit = !!user;
  const me = getCurrentUserData();

  if (isEdit && !can('user.update', { target: user })) {
    toastError(denyReason('user.update', { target: user }));
    return;
  }
  if (!isEdit && !can('user.create')) {
    toastError(denyReason('user.create'));
    return;
  }

  const stations = isSuperAdmin() ? await getAllStations() : await getStationsByIds(me.stationIds || []);
  // Station Admins may create Managers, but Firestore only lets them edit an
  // existing Staff account as Staff. Never show a promotion option that the
  // server will reject. Managers likewise only create/edit Staff.
  const roles = isEdit && !isSuperAdmin() ? [user.role] : assignableRoles();
  const assigned = new Set(user?.stationIds || []);

  const roleList = isEdit && !roles.includes(user.role) ? [user.role, ...roles] : roles;
  const selectedRole = user?.role || 'staff';
  const roleOptions = roleList.map(r =>
    `<option value="${r}" ${selectedRole === r ? 'selected' : ''}>${ROLES[r] || r}</option>`
  ).join('');
  const roleField = roleList.length === 1
    ? `<input type="hidden" id="user-role" value="${h(roleList[0])}" />
       <dl class="profile-settings-list"><dt>Role</dt><dd>${h(ROLES[roleList[0]] || roleList[0])}</dd></dl>`
    : `<div class="field"><label for="user-role">Role</label><select id="user-role" required>${roleOptions}</select></div>`;

  const stationBoxes = stations.length
    ? stations.map(s => `
        <div class="checkbox-item">
          <input type="checkbox" id="assign-${h(s.id)}" value="${h(s.id)}" ${assigned.has(s.id) ? 'checked' : ''} />
          <label for="assign-${h(s.id)}">${h(s.name)}</label>
        </div>`).join('')
    : '<p class="muted-note">No stations available to assign yet.</p>';

  const identityFields = isEdit ? `
    <div class="form-row">
      <div class="field"><label for="user-first-name">First name</label>
        <input type="text" id="user-first-name" maxlength="50" autocomplete="off" value="${h(user.firstName || (user.fullName || '').split(' ')[0] || '')}" required /></div>
      <div class="field"><label for="user-last-name">Last name</label>
        <input type="text" id="user-last-name" maxlength="50" autocomplete="off" value="${h(user.lastName || (user.fullName || '').split(' ').slice(1).join(' ') || '')}" required /></div>
    </div>
    <div class="form-row">
      <div class="field"><label>Username</label>
        <input type="text" value="${h(user.username || '—')}" disabled />
        <small class="hint">Usernames cannot change after creation.</small></div>
      <div class="field"><label>Email</label>
        <input type="text" value="${h(user.email || '—')}" disabled />
        <small class="hint">Emails are managed by Firebase Authentication.</small></div>
    </div>
    <div class="form-row">
      <div class="field"><label for="user-phone">Phone <span class="optional">(optional)</span></label>
        <input type="tel" id="user-phone" autocomplete="off" inputmode="tel" value="${h(user.phoneNumber || '')}" /></div>
      <div class="field"><label for="user-employee-id">Employee ID <span class="optional">(optional)</span></label>
        <input type="text" id="user-employee-id" maxlength="40" autocomplete="off" value="${h(user.employeeId || '')}" /></div>
    </div>
    <div class="field"><label for="user-avatar">Avatar URL <span class="optional">(optional, https)</span></label>
      <input type="url" id="user-avatar" placeholder="https://…" autocomplete="off" value="${h(user.avatarUrl || '')}" /></div>
  ` : `
    <div class="form-row">
      <div class="field"><label for="user-first-name">First name</label>
        <input type="text" id="user-first-name" maxlength="50" autocomplete="off" required /></div>
      <div class="field"><label for="user-last-name">Last name</label>
        <input type="text" id="user-last-name" maxlength="50" autocomplete="off" required /></div>
    </div>
    <div class="form-row">
      <div class="field"><label for="user-email">Email</label>
        <input type="email" id="user-email" placeholder="name@example.com" autocomplete="off" autocapitalize="off" spellcheck="false" required /></div>
      <div class="field"><label for="user-temp-pin">Cloud PIN</label>
        <input type="text" id="user-temp-pin" inputmode="numeric" pattern="[0-9]{4,8}" maxlength="8" autocomplete="off" required />
        <small id="pin-policy-hint" class="hint"></small></div>
    </div>
    <div class="settings-group user-options">
      <label class="toggle-row"><span class="toggle-text">Active<small>Inactive accounts cannot sign in.</small></span><input type="checkbox" id="user-active" class="toggle-input" role="switch" checked /></label>
      <label class="toggle-row"><span class="toggle-text">Allow app sign-in on a phone</span><input type="checkbox" id="user-allow-pwa" class="toggle-input" role="switch" checked /></label>
    </div>
  `;

  const editOptions = isEdit ? `
    <div class="settings-group user-options">
      <label class="toggle-row"><span class="toggle-text">Allow app sign-in on a phone</span><input type="checkbox" id="user-allow-pwa" class="toggle-input" role="switch" ${user.pwaLoginAllowed === false ? '' : 'checked'} /></label>
    </div>` : '';

  showFormModal(isEdit ? `Edit — ${user.fullName || user.email || user.username}` : 'Add team member', `
    <form id="user-form" novalidate>
      ${identityFields}
      ${roleField}
      <fieldset class="field">
        <legend>Assign to stations</legend>
        <div class="checkbox-list" id="station-assign-list">${stationBoxes}</div>
        <small class="hint" id="role-station-hint"></small>
      </fieldset>
      <fieldset class="field" id="pump-assign-fieldset">
        <legend>Default pumps <span class="optional">(staff only, optional)</span></legend>
        <div class="pump-assign-list" id="pump-assign-list"></div>
        <small class="hint" id="pump-assign-hint"></small>
      </fieldset>
      ${editOptions}
      <p class="form-error hidden" id="user-form-error" role="alert"></p>
      <button type="submit" class="btn btn-primary btn-full">${isEdit ? `Save ${ICONS.save}` : `${ICONS.add} Create user`}</button>
    </form>
  `);

  const roleSelect = byId('user-role');
  const list = byId('station-assign-list');
  const hint = byId('role-station-hint');
  const checkedStationIds = () =>
    Array.from(list.querySelectorAll('input[type="checkbox"]:checked')).map(cb => cb.value);

  // ── Policy hints follow the ticked stations (strictest wins) ─────────
  const policyCache = new Map();
  async function policyForSelection() {
    const ids = checkedStationIds();
    if (!ids.length) return { ...DEFAULT_SECURITY };
    const missing = ids.filter(id => !policyCache.has(id));
    await Promise.all(missing.map(async id => policyCache.set(id, await getSecuritySettings(id).catch(() => ({ ...DEFAULT_SECURITY })))));
    return mergeSecurity(ids.map(id => policyCache.get(id)));
  }
  async function refreshPolicyHints() {
    const pinHint = byId('pin-policy-hint');
    if (!pinHint) return;
    const policy = await policyForSelection();
    pinHint.textContent = `${policy.minPinLength}–8 digits${policy.pinComplexity === 'standard' ? ', no repeats or sequences' : ''}.`;
  }

  function syncStationPicker() {
    const isSuper = roleSelect.value === 'superadmin';
    list.classList.toggle('is-disabled', isSuper);
    list.querySelectorAll('input').forEach(i => { i.disabled = isSuper; });
    hint.textContent = isSuper
      ? 'Super Admins have access to every station automatically.'
      : 'Staff and Station Admins see only the stations you tick.';
    refreshPolicyHints();
  }
  roleSelect.addEventListener('change', syncStationPicker);
  syncStationPicker();
  refreshPolicyHints();

  // ── Pump assignment picker ──────────────────────────────────────────
  const pumpFieldset = byId('pump-assign-fieldset');
  const pumpList = byId('pump-assign-list');
  const pumpHint = byId('pump-assign-hint');
  const selectedPumps = new Set(user?.pumpIds || []);
  const stationPumps = new Map();

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
      pumpHint.textContent = 'Assign pumps after the account is created.';
      return;
    }
    pumpFieldset.hidden = false;
    pumpFieldset.classList.toggle('is-disabled', !isStaffRole);
    if (!isStaffRole) {
      pumpList.innerHTML = '';
      pumpHint.textContent = 'Only staff need a usual pump list — admins and managers can work every pump.';
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

    pumpHint.textContent = 'Optional usual pumps. Use Who’s where for daily changes. Leave every box unticked to allow this person on any pump at their stations.';
    pumpList.querySelectorAll('input[type="checkbox"]').forEach(cb =>
      cb.addEventListener('change', () => {
        if (cb.checked) selectedPumps.add(cb.value);
        else selectedPumps.delete(cb.value);
      }));
  }

  list.addEventListener('change', (e) => {
    if (e.target.matches('input[type="checkbox"]')) {
      refreshPumpPicker();
      refreshPolicyHints();
    }
  });
  roleSelect.addEventListener('change', refreshPumpPicker);
  await refreshPumpPicker();

  // ── Submit ──────────────────────────────────────────────────────────
  byId('user-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.currentTarget.querySelector('button[type="submit"]');
    const err = byId('user-form-error');
    const failInline = message => { showFieldError(err, message); setBusy(btn, false); };
    const role = roleSelect.value;
    const stationIds = Array.from(
      list.querySelectorAll('input[type="checkbox"]:checked')
    ).map(cb => cb.value);
    const pumpIds = role === 'staff' ? [...selectedPumps] : [];
    const active = isEdit ? user.status !== 'disabled' : byId('user-active')?.checked !== false;
    const allowPwaLogin = byId('user-allow-pwa')?.checked !== false;

    if (role !== 'superadmin' && stationIds.length === 0) {
      return showFieldError(err, '❌ Assign at least one station, or the account will not see any data.');
    }

    const firstName = byId('user-first-name').value.trim();
    const lastName = byId('user-last-name').value.trim();
    if (!firstName || !lastName) return showFieldError(err, '❌ Enter both first and last name.');

    err.classList.add('hidden');

    if (isEdit) {
      const ok = await confirmSave(`${firstName} ${lastName}'s profile`);
      if (!ok) return;
      setBusy(btn, true, 'Saving…');
    } else {
      setBusy(btn, true, 'Creating account…');
    }

    try {
      if (isEdit) {
        await updateUserAccount(user.id, {
          firstName,
          lastName,
          phoneNumber: byId('user-phone').value.trim(),
          employeeId: byId('user-employee-id').value.trim(),
          avatarUrl: byId('user-avatar').value.trim(),
          role,
          stationIds: role === 'superadmin' ? [] : stationIds,
          pumpIds,
          active,
          allowPwaLogin,
        });
        invalidateUsers();
        closeModal('generic-modal');
        toastSuccess('User Updated');
        rerender();
      } else {
        const email = byId('user-email').value.trim().toLowerCase();
        const temporaryCloudPin = byId('user-temp-pin').value;

        if (!isValidEmail(email)) return failInline('❌ Validation failed — enter a valid email address.');
        const policy = await policyForSelection();
        const pinError = validateCloudPinPolicy(temporaryCloudPin, policy);
        if (pinError) return failInline(pinError);

        const result = await createUserAccount({
          firstName,
          lastName,
          email,
          role,
          stationIds: role === 'superadmin' ? [] : stationIds,
          pumpIds,
          temporaryCloudPin,
          mustChangePin: false,
          active,
          allowPwaLogin,
        });
        invalidateUsers();
        closeModal('generic-modal');
        toastSuccess('User Created');
        showUserCreated(result, { temporaryCloudPin });
        rerender();
      }
    } catch (e2) {
      showFieldError(err, `❌ ${formatFirebaseError(e2)}`);
      setBusy(btn, false);
    }
  });
}

function showUserCreated(result, credentials) {
  byId('modal-title').textContent = '✅ User Created';
  byId('modal-body').innerHTML = `<div class="staff-created-success">
    <div class="success-check" aria-hidden="true">✓</div>
    <h3>Share these credentials privately</h3>
    <p class="muted-note">${h(result.fullName)} signs in with email + Cloud PIN. This is the only time the Cloud PIN is shown.</p>
    <dl class="staff-created-details credentials-details">
      <dt>Name</dt><dd>${h(result.fullName)}</dd>
      <dt>Email</dt><dd>${h(result.email)}</dd>
      <dt>Role</dt><dd>${h(ROLES[result.role] || result.role)}</dd>
      <dt>Cloud PIN</dt><dd><output>${h(credentials.temporaryCloudPin)}</output></dd>
    </dl>
    <div class="confirm-actions">
      <button type="button" id="copy-user-credentials" class="btn btn-secondary btn-full">Copy credentials</button>
      <button type="button" id="create-another-user" class="btn btn-primary btn-full">${ICONS.add} Create another</button>
    </div>
  </div>`;
  openModal('generic-modal');

  byId('copy-user-credentials')?.addEventListener('click', async event => {
    const text = [
      `PumpLog account for ${result.fullName}`,
      `Sign in: ${result.email}`,
      `Cloud PIN: ${credentials.temporaryCloudPin}`,
    ].join('\n');
    try {
      await navigator.clipboard.writeText(text);
      setBusy(event.currentTarget, true, 'Copied ✅');
      setTimeout(() => setBusy(event.currentTarget, false), 1400);
    } catch {
      toastError('Copy failed — write the credentials down before closing.');
    }
  });
  byId('create-another-user')?.addEventListener('click', async event => {
    setBusy(event.currentTarget, true, 'Loading…');
    try {
      closeModal('generic-modal');
      await showUserForm(null);
    } catch (err) {
      toastError(formatFirebaseError(err));
      setBusy(event.currentTarget, false);
    }
  });
}


// ── Credential resets for existing users ────────────────────────────────
async function showCredentialsForm() {
  toastError('Admin credential resets are disabled in free mode. Users can change their own Cloud PIN from Profile.');
}


async function activateUser(user, button = null) {
  if (!user || !can('user.update', { target: user })) {
    toastError(denyReason('user.update', { target: user }));
    return;
  }
  setBusy(button, true, 'Activating…');
  try {
    await updateUserAccount(user.id, { active: true });
    invalidateUsers();
    toastSuccess('User Activated');
    rerender();
  } catch (err) {
    toastError(formatFirebaseError(err));
    setBusy(button, false);
  }
}

async function removeUser(user, button = null) {
  if (!user || !can('user.delete', { target: user })) {
    toastError(denyReason('user.delete', { target: user }));
    return;
  }
  const name = user.fullName || user.email || user.username || 'this user';
  const ok = await confirmDialog({
    title: `${ICONS.warning} Remove app access?`,
    message: `${name} will not be able to use PumpLog. Their account will be kept inactive so past shifts stay complete, and you can reactivate it later.`,
    confirmLabel: `${ICONS.delete} Remove access`,
    danger: true,
  });
  if (!ok) return;

  setBusy(button, true, 'Removing…');
  try {
    await removeUserAccount(user.id);
    invalidateUsers();
    toastSuccess('User Access Removed');
    rerender();
  } catch (err) {
    toastError(formatFirebaseError(err));
    setBusy(button, false);
  }
}

// ── Station Admin invite ────────────────────────────────────────────────
async function createStationAdminInvite() {
  toastError('Invite codes are disabled in free mode. Create users from Config → Team with email + Cloud PIN.');
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
