/* PumpLog — shared account security UI */

import { changeStaffPin } from './staff-auth.js';
import { formatFirebaseError } from './auth.js';
import { openModal, closeModal, toast, setBusy } from './components.js';

export function openChangePinForm() {
  document.getElementById('modal-title').textContent = 'Change PIN';
  document.getElementById('modal-body').innerHTML = `<form id="change-pin-form" novalidate>
    <p class="modal-intro">Your PIN is verified securely by Firebase. It is never saved in this app.</p>
    <div class="field"><label for="current-pin">Current PIN</label><input type="password" id="current-pin" inputmode="numeric" autocomplete="current-password" maxlength="4" required /></div>
    <div class="field"><label for="new-account-pin">New PIN</label><input type="password" id="new-account-pin" inputmode="numeric" autocomplete="new-password" maxlength="4" required /><small class="hint">Exactly 4 digits; avoid repeated or sequential numbers.</small></div>
    <div class="field"><label for="confirm-account-pin">Confirm new PIN</label><input type="password" id="confirm-account-pin" inputmode="numeric" autocomplete="new-password" maxlength="4" required /></div>
    <p id="change-pin-error" class="form-error hidden" role="alert"></p><button type="submit" class="btn btn-primary btn-full">Save PIN</button>
  </form>`;
  openModal('generic-modal');
  document.getElementById('change-pin-form').addEventListener('submit', async event => {
    event.preventDefault();
    const button = event.currentTarget.querySelector('button[type="submit"]');
    const error = document.getElementById('change-pin-error');
    const currentPin = document.getElementById('current-pin').value;
    const newPin = document.getElementById('new-account-pin').value;
    const confirm = document.getElementById('confirm-account-pin').value;
    const fail = message => { error.textContent = message; error.classList.remove('hidden'); };
    if (!/^\d{4}$/.test(currentPin) || !/^\d{4}$/.test(newPin)) return fail('PINs must contain exactly 4 digits.');
    if (/^(\d)\1{3}$/.test(newPin) || ['0123', '1234', '9876', '3210'].includes(newPin)) return fail('Choose a less predictable 4-digit PIN.');
    if (newPin !== confirm) return fail('New PINs do not match.');
    setBusy(button, true, 'Saving…');
    try {
      await changeStaffPin({ currentPin, newPin });
      closeModal('generic-modal');
      toast('PIN updated successfully.', 'success');
    } catch (err) {
      fail(formatFirebaseError(err));
      setBusy(button, false);
    }
  });
}
