/* PumpLog — Config Page (Rates, Stations, Team) */

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
  serverTimestamp,
} from './firebase.js';
import {
  getCurrentUserData,
  isSuperAdmin,
  isStationAdmin,
  hasRole,
  createUserAsAdmin,
} from './auth.js';
import {
  formatCurrency, formatDate, getTodayDate,
  openModal, closeModal, showGenericModal, emptyState
} from './components.js';

let db = null;
let currentStationId = null;

export function initConfig(firestore) {
  db = firestore;
}

// ── Render ──────────────────────────────────────────────────────────────
export async function renderConfig(stationId) {
  currentStationId = stationId;
  if (!stationId) {
    document.getElementById('page-content').innerHTML = emptyState('⚙️', 'Select a station to configure.');
    return;
  }

  const userData = getCurrentUserData();
  if (!hasRole('superadmin', 'stationadmin')) {
    document.getElementById('page-content').innerHTML = emptyState('🔒', 'You do not have permission to access this page.');
    return;
  }

  try {
    let html = '<h2 style="font-size:22px;font-weight:700;margin-bottom:20px;">Settings</h2>';

    // ── Rates Section ──────────────────────────────────────────────
    html += `<div class="config-section"><h3>Rates <button id="add-rate-btn" class="btn btn-primary btn-small">+ Add Rate</button></h3>`;
    const ratesQ = query(
      collection(db, 'stations', stationId, 'rates'),
      orderBy('effectiveDate', 'desc')
    );
    const ratesSnap = await getDocs(ratesQ);
    const rates = [];
    ratesSnap.forEach(d => rates.push({ id: d.id, ...d.data() }));

    if (rates.length === 0) {
      html += emptyState('💰', 'No rates configured. Add a rate to start tracking sales.');
    } else {
      rates.forEach(r => {
        html += `
          <div class="config-item" data-rate-id="${r.id}">
            <div class="item-info">
              <div class="item-title">${r.product} — ${formatCurrency(r.rate)}/L</div>
              <div class="item-meta">Effective: ${formatDate(r.effectiveDate)}</div>
            </div>
            <div class="item-actions">
              <button class="icon-btn edit-rate" data-id="${r.id}" title="Edit">✏️</button>
              <button class="icon-btn delete-rate" data-id="${r.id}" title="Delete">🗑️</button>
            </div>
          </div>
        `;
      });
    }
    html += `</div>`;

    // ── Stations Section (Super Admin only) ────────────────────────
    if (isSuperAdmin()) {
      html += `<div class="config-section"><h3>Stations <button id="add-station-btn" class="btn btn-primary btn-small">+ Create Station</button></h3>`;
      const stationsSnap = await getDocs(collection(db, 'stations'));
      const stations = [];
      stationsSnap.forEach(d => stations.push({ id: d.id, ...d.data() }));

      if (stations.length === 0) {
        html += emptyState('🏪', 'No stations yet.');
      } else {
        stations.forEach(s => {
          html += `
            <div class="config-item">
              <div class="item-info">
                <div class="item-title">${s.name}</div>
                <div class="item-meta">${s.address || ''}</div>
              </div>
              <div class="item-actions">
                <button class="icon-btn delete-station" data-id="${s.id}" title="Delete">🗑️</button>
              </div>
            </div>
          `;
        });
      }
      html += `</div>`;

      // ── Team Section (Super Admin — create Station Admins) ──────
      html += `<div class="config-section"><h3>Team <button id="add-team-btn" class="btn btn-primary btn-small">+ Add User</button></h3>`;
      const usersSnap = await getDocs(collection(db, 'users'));
      const users = [];
      usersSnap.forEach(d => users.push({ id: d.id, ...d.data() }));

      if (users.length === 0) {
        html += emptyState('👥', 'No users yet.');
      } else {
        users.forEach(u => {
          const roleBadge = u.role === 'superadmin' ? '🔶 Super Admin' : u.role === 'stationadmin' ? '🔷 Station Admin' : '⚪ Staff';
          html += `
            <div class="config-item">
              <div class="item-info">
                <div class="item-title">${u.email}</div>
                <div class="item-meta">${roleBadge} · ${(u.stationIds || []).length} station(s)</div>
              </div>
            </div>
          `;
        });
      }
      html += `</div>`;
    }

    // ── Team Section (Station Admin — create Staff) ───────────────
    if (isStationAdmin()) {
      html += `<div class="config-section"><h3>Team <button id="add-team-btn" class="btn btn-primary btn-small">+ Add Staff</button></h3>`;
      html += `<p style="font-size:13px;color:var(--text-secondary);margin-bottom:12px;">Create staff logins for your stations.</p>`;

      // Show existing staff for this admin's stations
      const adminStationIds = userData.stationIds || [];
      if (adminStationIds.length > 0) {
        const staffQ = query(
          collection(db, 'users'),
          where('role', '==', 'staff'),
          where('createdBy', '==', userData.uid)
        );
        const staffSnap = await getDocs(staffQ);
        const staff = [];
        staffSnap.forEach(d => staff.push({ id: d.id, ...d.data() }));

        if (staff.length === 0) {
          html += emptyState('👤', 'No staff accounts yet.');
        } else {
          staff.forEach(u => {
            html += `
              <div class="config-item">
                <div class="item-info">
                  <div class="item-title">${u.email}</div>
                  <div class="item-meta">Staff · ${(u.stationIds || []).length} station(s)</div>
                </div>
              </div>
            `;
          });
        }
      }
      html += `</div>`;
    }

    document.getElementById('page-content').innerHTML = html;

    // ── Attach handlers ───────────────────────────────────────────
    document.getElementById('add-rate-btn')?.addEventListener('click', showAddRateForm);

    document.querySelectorAll('.edit-rate').forEach(btn => {
      btn.addEventListener('click', () => showEditRateForm(btn.dataset.id, rates.find(r => r.id === btn.dataset.id)));
    });

    document.querySelectorAll('.delete-rate').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (confirm('Delete this rate?')) {
          await deleteDoc(doc(db, 'stations', stationId, 'rates', btn.dataset.id));
          renderConfig(stationId);
        }
      });
    });

    document.getElementById('add-station-btn')?.addEventListener('click', showAddStationForm);

    document.querySelectorAll('.delete-station').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (confirm('Delete this station and all its data?')) {
          await deleteDoc(doc(db, 'stations', btn.dataset.id));
          renderConfig(stationId);
        }
      });
    });

    document.getElementById('add-team-btn')?.addEventListener('click', showAddUserForm);

  } catch (err) {
    console.error('Config render error:', err);
    document.getElementById('page-content').innerHTML = emptyState('⚠️', 'Error loading settings.');
  }
}

// ── Add Rate Form ───────────────────────────────────────────────────────
function showAddRateForm(editData = null) {
  const isEdit = !!editData;
  const bodyHTML = `
    <form id="rate-form">
      <div class="field">
        <label for="rate-product">Product</label>
        <select id="rate-product" required>
          <option value="">Select product…</option>
          <option value="MS" ${editData?.product === 'MS' ? 'selected' : ''}>MS (Petrol)</option>
          <option value="HSD" ${editData?.product === 'HSD' ? 'selected' : ''}>HSD (Diesel)</option>
          <option value="CNG" ${editData?.product === 'CNG' ? 'selected' : ''}>CNG</option>
          <option value="LPG" ${editData?.product === 'LPG' ? 'selected' : ''}>LPG</option>
          <option value="Other" ${editData?.product === 'Other' ? 'selected' : ''}>Other</option>
        </select>
      </div>
      <div class="field">
        <label for="rate-value">Rate (₹ per liter)</label>
        <input type="number" id="rate-value" step="0.01" min="0" placeholder="0.00" value="${editData?.rate || ''}" required />
      </div>
      <div class="field">
        <label for="rate-date">Effective Date</label>
        <input type="date" id="rate-date" value="${editData?.effectiveDate || getTodayDate()}" required />
      </div>
      <button type="submit" class="btn btn-primary btn-full">${isEdit ? 'Update' : 'Add'} Rate</button>
    </form>
  `;

  document.getElementById('modal-title').textContent = isEdit ? 'Edit Rate' : 'Add Rate';
  document.getElementById('modal-body').innerHTML = bodyHTML;
  openModal('generic-modal');

  document.getElementById('rate-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const data = {
      product: document.getElementById('rate-product').value,
      rate: parseFloat(document.getElementById('rate-value').value) || 0,
      effectiveDate: document.getElementById('rate-date').value,
    };

    try {
      if (isEdit) {
        await updateDoc(doc(db, 'stations', currentStationId, 'rates', editData.id), data);
      } else {
        await addDoc(collection(db, 'stations', currentStationId, 'rates'), data);
      }
      closeModal('generic-modal');
      renderConfig(currentStationId);
    } catch (err) {
      console.error('Rate save error:', err);
      alert('Failed to save rate.');
    }
  });
}

function showEditRateForm(id, data) {
  showAddRateForm(data);
}

// ── Add Station Form (Super Admin only) ─────────────────────────────────
async function showAddStationForm() {
  const bodyHTML = `
    <form id="station-form">
      <div class="field">
        <label for="station-name">Station Name</label>
        <input type="text" id="station-name" placeholder="e.g. 139 Fiat Ave" required />
      </div>
      <div class="field">
        <label for="station-address">Address (optional)</label>
        <input type="text" id="station-address" placeholder="City, area..." />
      </div>
      <button type="submit" class="btn btn-primary btn-full">Create Station</button>
    </form>
  `;

  document.getElementById('modal-title').textContent = 'Create Station';
  document.getElementById('modal-body').innerHTML = bodyHTML;
  openModal('generic-modal');

  document.getElementById('station-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = document.getElementById('station-name').value.trim();
    const address = document.getElementById('station-address').value.trim();

    if (!name) return;

    try {
      await addDoc(collection(db, 'stations'), { name, address, createdAt: serverTimestamp() });
      closeModal('generic-modal');
      renderConfig(currentStationId);
    } catch (err) {
      console.error('Create station error:', err);
      alert('Failed to create station.');
    }
  });
}

// ── Add User Form ───────────────────────────────────────────────────────
async function showAddUserForm() {
  const userData = getCurrentUserData();
  const isSuper = isSuperAdmin();
  const isStationAdm = isStationAdmin();

  // Fetch stations for assignment
  const stationsSnap = await getDocs(collection(db, 'stations'));
  const stations = [];
  stationsSnap.forEach(d => stations.push({ id: d.id, ...d.data() }));

  // Filter stations based on role
  let availableStations = stations;
  if (isStationAdm) {
    const myIds = userData.stationIds || [];
    availableStations = stations.filter(s => myIds.includes(s.id));
  }

  let stationCheckboxes = '';
  availableStations.forEach(s => {
    stationCheckboxes += `
      <div class="checkbox-item">
        <input type="checkbox" id="assign-${s.id}" value="${s.id}" />
        <label for="assign-${s.id}">${s.name}</label>
      </div>
    `;
  });

  const roleOptions = isSuper
    ? `<option value="stationadmin">Station Admin</option><option value="staff">Staff</option>`
    : `<option value="staff">Staff</option>`;

  const bodyHTML = `
    <form id="user-form">
      <div class="field">
        <label for="new-email">Email</label>
        <input type="email" id="new-email" placeholder="user@example.com" required />
      </div>
      <div class="field">
        <label for="new-password">Password</label>
        <input type="password" id="new-password" placeholder="At least 6 characters" minlength="6" required />
      </div>
      <div class="field">
        <label for="new-role">Role</label>
        <select id="new-role" required>${roleOptions}</select>
      </div>
      <div class="field">
        <label>Assign to Station(s)</label>
        <div class="checkbox-list">
          ${stationCheckboxes || '<p style="color:var(--text-muted);font-size:13px;">No stations available.</p>'}
        </div>
      </div>
      <button type="submit" class="btn btn-primary btn-full">Create Account</button>
    </form>
  `;

  document.getElementById('modal-title').textContent = 'Add Team Member';
  document.getElementById('modal-body').innerHTML = bodyHTML;
  openModal('generic-modal');

  document.getElementById('user-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = document.getElementById('new-email').value.trim();
    const password = document.getElementById('new-password').value;
    const role = document.getElementById('new-role').value;

    const checkedBoxes = document.querySelectorAll('#modal-body input[type="checkbox"]:checked');
    const stationIds = Array.from(checkedBoxes).map(cb => cb.value);

    if (!email || !password) return;

    try {
      await createUserAsAdmin(email, password, role, stationIds);
      closeModal('generic-modal');
      renderConfig(currentStationId);
      alert(`Account created for ${email}. They can sign in immediately.`);
    } catch (err) {
      console.error('Create user error:', err);
      alert('Failed to create user: ' + err.message);
    }
  });
}
