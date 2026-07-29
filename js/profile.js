/* PumpLog — Profile page & account security center
 *
 * Profile
 *   ├── Account          name · username · email · phone · employee ID · role
 *   └── Security
 *         ├── Cloud PIN        change — handled by Firebase Authentication
 *         ├── App Lock PIN     this device only — never synced
 *         └── Security questions  App Lock recovery — this device only
 *
 * Also hosts the mandatory Cloud PIN change flow the sign-in gate can trigger.
 */

import {
  getCurrentUser, getCurrentUserData, isSuperAdmin, ROLES, ROLE_BADGE,
  formatFirebaseError, doSignOut, myDailyPumpIds,
} from './auth.js';
import {
  changeCloudPin, getMyPinStatus,
} from './staff-auth.js';
import {
  DEFAULT_SECURITY, validateCloudPinPolicy,
  validateAppLockPin, getEffectiveSecurity,
} from './station-settings.js';
import {
  SECURITY_QUESTIONS, getAppLockStatus, setAppLockPin, verifyAppLockPin,
  saveSecurityAnswers, clearAppLock, engageAppLock, armAppLockSession,
} from './app-lock.js';
import {
  h, openModal, closeModal, setModalLocked, setBusy, toastSuccess,
  confirmDelete, ICONS,
} from './components.js';

export const APP_VERSION = '1.0.0';

const byId = id => document.getElementById(id);
const APP_VERSION_LABEL = `v${APP_VERSION}`;

function fieldFail(id, message) {
  const el = byId(id);
  if (!el) return;
  el.textContent = message;
  el.classList.remove('hidden');
}

function pinInputHTML({ id, label, autocomplete = 'new-password', hint = '' }) {
  return `<div class="field"><label for="${id}">${label}</label><div class="input-affix">
    <input type="password" id="${id}" inputmode="numeric" autocomplete="${autocomplete}" pattern="[0-9]{4,8}" minlength="4" maxlength="8" required />
    <button type="button" class="affix-btn" data-secret-toggle="${id}" aria-label="Show" aria-pressed="false">Show</button></div>
    ${hint ? `<small class="hint">${hint}</small>` : ''}</div>`;
}

function wireSecretToggles(root = document) {
  root.querySelectorAll('[data-secret-toggle]').forEach(toggle => {
    toggle.addEventListener('click', () => {
      const field = byId(toggle.dataset.secretToggle);
      if (!field) return;
      const show = field.type === 'password';
      field.type = show ? 'text' : 'password';
      toggle.textContent = show ? 'Hide' : 'Show';
      toggle.setAttribute('aria-pressed', String(show));
    });
  });
}

function showFormModal(title, bodyHTML, { locked = false } = {}) {
  byId('modal-title').textContent = title;
  byId('modal-body').innerHTML = bodyHTML;
  setModalLocked('generic-modal', locked);
  openModal('generic-modal');
  wireSecretToggles(byId('modal-body'));
}

// ── Avatar & identity helpers ───────────────────────────────────────────
export function initialsFor(userData) {
  const first = (userData?.firstName || userData?.fullName || '').trim();
  const last = (userData?.lastName || '').trim();
  if (first) return `${first[0]}${last ? last[0] : (first.split(' ')[1]?.[0] || '')}`.toUpperCase();
  return (userData?.username || userData?.email || 'P')[0].toUpperCase();
}

export function avatarHTML(userData, size = 'large') {
  if (userData?.avatarUrl) {
    return `<span class="avatar avatar-${size}" role="img" aria-label="${h(userData.fullName || 'User')} avatar">
      <img src="${h(userData.avatarUrl)}" alt="" loading="lazy" referrerpolicy="no-referrer" /></span>`;
  }
  return `<span class="avatar avatar-${size} avatar-initials" aria-hidden="true">${h(initialsFor(userData))}</span>`;
}

// ═══════════════════════════════════════════════════════════════════════
//  Profile modal
// ═══════════════════════════════════════════════════════════════════════
export async function openProfileModal({ stations = [], onSignOut } = {}) {
  const userData = getCurrentUserData();
  if (!userData) return;
  const uid = getCurrentUser()?.uid;
  const signOutHandler = onSignOut || (async () => {
    closeModal('profile-modal');
    await doSignOut().catch(() => {});
  });
  const stationText = isSuperAdmin()
    ? 'All stations'
    : stations.length
      ? stations.map(s => s.name).join(', ')
      : 'None assigned';
  const rostered = myDailyPumpIds().length;
  const pumpText = userData.role === 'staff'
    ? (rostered
        ? `${rostered} pump${rostered === 1 ? '' : 's'} assigned to you today`
        : userData.pumpIds?.length
          ? `${userData.pumpIds.length} usual pump${userData.pumpIds.length === 1 ? '' : 's'}`
          : 'No pump assigned today — ask your manager')
    : 'All pumps';

  const lockStatus = getAppLockStatus(uid);

  byId('profile-modal-body').innerHTML = `
    <div class="profile-hero">
      ${avatarHTML(userData, 'large')}
      <div class="profile-hero-text">
        <strong>${h(userData.fullName || [userData.firstName, userData.lastName].filter(Boolean).join(' ') || userData.email || 'PumpLog user')}</strong>
        <span class="role-badge">${ROLE_BADGE[userData.role] || '⚪'} ${h(ROLES[userData.role] || userData.role || 'Staff')}</span>
        ${(userData.status === 'disabled') ? '<span class="tag tag-disabled">Inactive</span>' : ''}
      </div>
    </div>

    <dl class="profile-settings-list profile-detail-grid">
      <dt>Email</dt><dd>${h(userData.email || '—')}</dd>
      <dt>Stations</dt><dd>${h(stationText)}</dd>
      <dt>Pumps</dt><dd>${h(pumpText)}</dd>
      <dt>App version</dt><dd>${APP_VERSION_LABEL}</dd>
    </dl>

    <section class="profile-security" aria-labelledby="profile-security-title">
      <h3 id="profile-security-title">${ICONS.shield} Security</h3>

      <div class="security-row">
        <div class="security-row-text">
          <strong>Cloud PIN</strong>
          <small>Used with your email to sign in through Firebase Authentication.</small>
        </div>
        <button type="button" id="profile-change-pin" class="btn btn-secondary btn-small">${ICONS.pin} Change</button>
      </div>

      <div class="security-row">
        <div class="security-row-text">
          <strong>App Lock ${lockStatus.configured ? '<span class="tag tag-on">On this device</span>' : '<span class="tag tag-off">Not set up</span>'}</strong>
          <small>Locks this device after refresh, reopen, or inactivity. The PIN never leaves this device.</small>
        </div>
        ${lockStatus.configured
          ? `<div class="security-row-actions">
              <button type="button" id="profile-applock-change" class="btn btn-secondary btn-small">${ICONS.edit} Change</button>
              <button type="button" id="profile-applock-lock-now" class="btn btn-secondary btn-small">${ICONS.lock} Lock now</button>
            </div>`
          : `<button type="button" id="profile-applock-setup" class="btn btn-secondary btn-small">${ICONS.lock} Set up</button>`}
      </div>

      ${lockStatus.configured ? `
      <div class="security-row">
        <div class="security-row-text">
          <strong>Security questions</strong>
          <small>${lockStatus.questionCount >= 2 ? 'Set — you can reset a forgotten App Lock PIN.' : 'Not set — add them to recover a forgotten PIN.'}</small>
        </div>
        <button type="button" id="profile-applock-questions" class="btn btn-secondary btn-small">${ICONS.edit} ${lockStatus.questionCount >= 2 ? 'Update' : 'Add'}</button>
      </div>
      <div class="security-row">
        <div class="security-row-text">
          <strong>Remove App Lock</strong>
          <small>Deletes the App Lock PIN and answers stored on this device.</small>
        </div>
        <button type="button" id="profile-applock-remove" class="btn btn-secondary btn-small danger-text">${ICONS.delete} Remove</button>
      </div>` : ''}
    </section>

    <div class="profile-account-actions">
      <button type="button" id="btn-signout" class="btn btn-secondary btn-full">Sign out</button>
    </div>`;

  openModal('profile-modal');

  byId('profile-change-pin')?.addEventListener('click', () => openChangePinForm());
  byId('profile-applock-setup')?.addEventListener('click', () => openAppLockSetupModal({ dismissible: true }));
  byId('profile-applock-change')?.addEventListener('click', () => openAppLockPinChange());
  byId('profile-applock-questions')?.addEventListener('click', () => openSecurityQuestionsForm());
  byId('profile-applock-lock-now')?.addEventListener('click', () => {
    closeModal('profile-modal');
    armAppLockSessionForCurrentUser();
    engageAppLock(() => {}, userData.fullName || '');
  });
  byId('profile-applock-remove')?.addEventListener('click', async () => {
    const ok = await confirmDelete('The App Lock PIN and security answers on this device will be deleted. Account sign-in is not affected.');
    if (!ok) return;
    clearAppLock(uid);
    toastSuccess('App Lock removed from this device');
    closeModal('profile-modal');
  });
  byId('btn-signout')?.addEventListener('click', event => signOutHandler({ currentTarget: event.currentTarget }));
}

async function armAppLockSessionForCurrentUser() {
  const user = getCurrentUser();
  const userData = getCurrentUserData();
  if (!user || !userData) return;
  const policy = await getEffectiveSecurity(userData);
  armAppLockSession(user, { ...policy, appLockEnabled: true, appLockOnInactivity: policy.appLockOnInactivity ?? true });
}

// ═══════════════════════════════════════════════════════════════════════
//  Cloud PIN — change (Profile → Security)
// ═══════════════════════════════════════════════════════════════════════
export async function openChangePinForm() {
  const status = await getMyPinStatus().catch(() => null);
  const policy = status?.policies || DEFAULT_SECURITY;
  showFormModal('Change Cloud PIN', `<form id="change-pin-form" novalidate>
    <p class="modal-intro">Your Cloud PIN is updated in Firebase Authentication and applies to future sign-ins immediately.</p>
    ${pinInputHTML({ id: 'current-pin', label: 'Current Cloud PIN', autocomplete: 'current-password' })}
    ${pinInputHTML({ id: 'new-account-pin', label: 'New Cloud PIN', hint: `${policy.minPinLength || 4}–8 digits${policy.pinComplexity === 'standard' ? '; no repeated or sequential digits' : ''}.` })}
    ${pinInputHTML({ id: 'confirm-account-pin', label: 'Confirm Cloud PIN' })}
    <p id="change-pin-error" class="form-error hidden" role="alert"></p>
    <button type="submit" class="btn btn-primary btn-full">Save Cloud PIN ${ICONS.save}</button>
  </form>`);

  byId('change-pin-form').addEventListener('submit', async event => {
    event.preventDefault();
    const button = event.currentTarget.querySelector('button[type="submit"]');
    const currentPin = byId('current-pin').value;
    const newPin = byId('new-account-pin').value;
    const confirm = byId('confirm-account-pin').value;
    if (!currentPin) return fieldFail('change-pin-error', '❌ Enter your current Cloud PIN.');
    const invalid = validateCloudPinPolicy(newPin, policy);
    if (invalid) return fieldFail('change-pin-error', invalid);
    if (newPin !== confirm) return fieldFail('change-pin-error', '❌ New Cloud PINs do not match.');
    setBusy(button, true, 'Saving…');
    try {
      await changeCloudPin({ currentPin, newPin });
      closeModal('generic-modal');
      toastSuccess('Cloud PIN Updated');
    } catch (err) {
      fieldFail('change-pin-error', `❌ ${formatFirebaseError(err)}`);
      setBusy(button, false);
    }
  });
}

// ═══════════════════════════════════════════════════════════════════════
//  Forced credential flows (sign-in gate) — non-dismissible
// ═══════════════════════════════════════════════════════════════════════
export function openForcedCloudPinChange(status) {
  return new Promise(resolve => {
    const policy = status?.policies || DEFAULT_SECURITY;
    const rotating = status?.pinRotationRequired && !status?.pinResetRequired;
    showFormModal(rotating ? 'Cloud PIN rotation required' : 'Set your Cloud PIN', `<form id="forced-pin-form" novalidate>
      <p class="modal-intro">${rotating
        ? `Your station requires a new Cloud PIN every ${policy.pinRotationDays || '?'} days.`
        : 'Create your own Cloud PIN to continue.'} The PIN takes effect for future sign-ins immediately.</p>
      ${pinInputHTML({ id: 'forced-current-pin', label: rotating ? 'Current Cloud PIN' : 'Temporary Cloud PIN', autocomplete: 'current-password' })}
      ${pinInputHTML({ id: 'forced-new-pin', label: 'New Cloud PIN', hint: `${policy.minPinLength || 4}–8 digits${policy.pinComplexity === 'standard' ? '; no repeated or sequential digits' : ''}.` })}
      ${pinInputHTML({ id: 'forced-confirm-pin', label: 'Confirm new Cloud PIN' })}
      <p id="forced-pin-error" class="form-error hidden" role="alert"></p>
      <button type="submit" class="btn btn-primary btn-full">Update Cloud PIN ${ICONS.save}</button>
      <button type="button" class="link-btn forced-signout">Sign out instead</button>
    </form>`, { locked: true });

    byId('forced-pin-form').addEventListener('submit', async event => {
      event.preventDefault();
      const button = event.currentTarget.querySelector('button[type="submit"]');
      const currentPin = byId('forced-current-pin').value;
      const newPin = byId('forced-new-pin').value;
      const confirm = byId('forced-confirm-pin').value;
      if (!currentPin) return fieldFail('forced-pin-error', '❌ Enter your current Cloud PIN.');
      const invalid = validateCloudPinPolicy(newPin, policy);
      if (invalid) return fieldFail('forced-pin-error', invalid);
      if (newPin === currentPin) return fieldFail('forced-pin-error', '❌ Choose a Cloud PIN different from the current one.');
      if (newPin !== confirm) return fieldFail('forced-pin-error', '❌ New Cloud PINs do not match.');
      setBusy(button, true, 'Saving…');
      try {
        await changeCloudPin({ currentPin, newPin });
        setModalLocked('generic-modal', false);
        closeModal('generic-modal');
        toastSuccess('Cloud PIN Updated');
        resolve();
      } catch (err) {
        fieldFail('forced-pin-error', `❌ ${formatFirebaseError(err)}`);
        setBusy(button, false);
      }
    });
    byId('forced-pin-form').querySelector('.forced-signout').addEventListener('click', async () => {
      setModalLocked('generic-modal', false);
      closeModal('generic-modal');
      await doSignOut().catch(() => {});
      resolve();
    });
  });
}

// ═══════════════════════════════════════════════════════════════════════
//  App Lock — setup wizard, PIN change, security questions
// ═══════════════════════════════════════════════════════════════════════
export function openAppLockSetupModal({ dismissible = true, onDone } = {}) {
  const uid = getCurrentUser()?.uid;
  if (!uid) return;
  showFormModal('Set up App Lock', `<form id="applock-setup-form" novalidate>
    <p class="modal-intro">App Lock protects this device after refresh, reopen, or inactivity. The PIN is stored only on this device — it never syncs to Firebase or your other devices.</p>
    ${pinInputHTML({ id: 'applock-new-pin', label: 'Create App Lock PIN', hint: '4–8 digits; no repeated or sequential digits.' })}
    ${pinInputHTML({ id: 'applock-confirm-pin', label: 'Confirm App Lock PIN' })}
    <p id="applock-setup-error" class="form-error hidden" role="alert"></p>
    <button type="submit" class="btn btn-primary btn-full">Continue ${ICONS.save}</button>
    ${dismissible ? '<button type="button" class="link-btn" id="applock-setup-later">Maybe later</button>' : ''}
  </form>`);

  byId('applock-setup-later')?.addEventListener('click', () => {
    closeModal('generic-modal');
    onDone?.(false);
  });

  byId('applock-setup-form').addEventListener('submit', async event => {
    event.preventDefault();
    const button = event.currentTarget.querySelector('button[type="submit"]');
    const pin = byId('applock-new-pin').value;
    const confirm = byId('applock-confirm-pin').value;
    const invalid = validateAppLockPin(pin);
    if (invalid) return fieldFail('applock-setup-error', invalid);
    if (pin !== confirm) return fieldFail('applock-setup-error', '❌ App Lock PINs do not match.');
    setBusy(button, true, 'Saving…');
    await setAppLockPin(uid, pin);
    openSecurityQuestionsForm({
      firstRun: true,
      onDone: async () => {
        toastSuccess('App Lock PIN Created');
        const userData = getCurrentUserData();
        if (userData) {
          const policy = await getEffectiveSecurity(userData).catch(() => null);
          armAppLockSession(getCurrentUser(), { ...(policy || DEFAULT_SECURITY), appLockEnabled: true });
        }
        onDone?.(true);
      },
    });
  });
}

export function openAppLockPinChange() {
  const uid = getCurrentUser()?.uid;
  if (!uid) return;
  showFormModal('Change App Lock PIN', `<form id="applock-change-form" novalidate>
    <p class="modal-intro">This changes the App Lock PIN on this device only.</p>
    ${pinInputHTML({ id: 'applock-current', label: 'Current App Lock PIN', autocomplete: 'current-password' })}
    ${pinInputHTML({ id: 'applock-new', label: 'New App Lock PIN', hint: '4–8 digits; no repeated or sequential digits.' })}
    ${pinInputHTML({ id: 'applock-confirm', label: 'Confirm new PIN' })}
    <p id="applock-change-error" class="form-error hidden" role="alert"></p>
    <button type="submit" class="btn btn-primary btn-full">Save App Lock PIN ${ICONS.save}</button>
  </form>`);

  byId('applock-change-form').addEventListener('submit', async event => {
    event.preventDefault();
    const button = event.currentTarget.querySelector('button[type="submit"]');
    const current = byId('applock-current').value;
    const pin = byId('applock-new').value;
    const confirm = byId('applock-confirm').value;
    if (!(await verifyAppLockPin(uid, current))) return fieldFail('applock-change-error', '❌ Incorrect App Lock PIN.');
    const invalid = validateAppLockPin(pin);
    if (invalid) return fieldFail('applock-change-error', invalid);
    if (pin !== confirm) return fieldFail('applock-change-error', '❌ New PINs do not match.');
    setBusy(button, true, 'Saving…');
    await setAppLockPin(uid, pin);
    closeModal('generic-modal');
    toastSuccess('App Lock PIN Updated');
  });
}

export function openSecurityQuestionsForm({ firstRun = false, onDone } = {}) {
  const uid = getCurrentUser()?.uid;
  if (!uid) return;
  const status = getAppLockStatus(uid);
  const options = selected => SECURITY_QUESTIONS.map(q =>
    `<option value="${q.id}" ${selected === q.id ? 'selected' : ''}>${h(q.label)}</option>`).join('');
  const pickDefault = (exclude, fallback) => {
    const available = SECURITY_QUESTIONS.find(q => q.id !== exclude);
    return available?.id || fallback;
  };
  const [q1, q2] = status.questions.length >= 2 ? status.questions : ['favoriteColor', pickDefault('favoriteColor', 'favoriteFood')];

  showFormModal('Security questions', `<form id="applock-questions-form" novalidate>
    <p class="modal-intro">${firstRun
      ? 'Almost done. Add two security questions to recover a forgotten App Lock PIN.'
      : 'Verify your App Lock PIN, then update your recovery questions.'} Answers are stored securely on this device only — never uploaded to Firebase.</p>
    ${firstRun ? '' : pinInputHTML({ id: 'applock-verify-pin', label: 'Current App Lock PIN', autocomplete: 'current-password' })}
    <div class="field"><label for="applock-question-1">Question 1</label>
      <select id="applock-question-1">${options(q1)}</select></div>
    <div class="field"><label for="applock-answer-1">Answer 1</label>
      <input type="text" id="applock-answer-1" autocomplete="off" maxlength="60" required /></div>
    <div class="field"><label for="applock-question-2">Question 2</label>
      <select id="applock-question-2">${options(q2)}</select></div>
    <div class="field"><label for="applock-answer-2">Answer 2</label>
      <input type="text" id="applock-answer-2" autocomplete="off" maxlength="60" required /></div>
    <p id="applock-questions-error" class="form-error hidden" role="alert"></p>
    <button type="submit" class="btn btn-primary btn-full">Save questions ${ICONS.save}</button>
    ${firstRun ? '<button type="button" class="link-btn" id="applock-questions-skip">Skip for now</button>' : ''}
  </form>`);

  byId('applock-questions-skip')?.addEventListener('click', () => {
    closeModal('generic-modal');
    onDone?.();
  });

  byId('applock-questions-form').addEventListener('submit', async event => {
    event.preventDefault();
    const button = event.currentTarget.querySelector('button[type="submit"]');
    const question1 = byId('applock-question-1').value;
    const question2 = byId('applock-question-2').value;
    const answer1 = byId('applock-answer-1').value.trim();
    const answer2 = byId('applock-answer-2').value.trim();
    if (!firstRun && !(await verifyAppLockPin(uid, byId('applock-verify-pin').value))) {
      return fieldFail('applock-questions-error', '❌ Incorrect App Lock PIN.');
    }
    if (question1 === question2) return fieldFail('applock-questions-error', '❌ Choose two different questions.');
    if (!answer1 || !answer2) return fieldFail('applock-questions-error', '❌ Answer both questions.');
    setBusy(button, true, 'Saving…');
    await saveSecurityAnswers(uid, [
      { id: question1, answer: answer1 },
      { id: question2, answer: answer2 },
    ]);
    closeModal('generic-modal');
    toastSuccess('Security Questions Saved');
    onDone?.();
  });
}
