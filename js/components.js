/* PumpLog — Shared UI helpers (a11y-first, dependency-free) */

// ── Safety ──────────────────────────────────────────────────────────────
// Every value interpolated into innerHTML must go through this.
export function escapeHtml(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export const h = escapeHtml;

// ── Modal helpers (focus trap + Escape + restore focus) ─────────────────
const FOCUSABLE = [
  'a[href]', 'button:not([disabled])', 'input:not([disabled])',
  'select:not([disabled])', 'textarea:not([disabled])', '[tabindex]:not([tabindex="-1"])',
].join(',');

let lastFocused = null;
let activeModalId = null;

function focusableIn(el) {
  return Array.from(el.querySelectorAll(FOCUSABLE)).filter(n => n.offsetParent !== null);
}

function onModalKeydown(e) {
  if (!activeModalId) return;
  const modal = document.getElementById(activeModalId);
  if (!modal) return;

  if (e.key === 'Escape') {
    e.preventDefault();
    closeModal(activeModalId);
    return;
  }

  if (e.key !== 'Tab') return;
  const nodes = focusableIn(modal);
  if (nodes.length === 0) return;
  const first = nodes[0];
  const last = nodes[nodes.length - 1];

  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault();
    first.focus();
  }
}

document.addEventListener('keydown', onModalKeydown);

export function openModal(id) {
  const el = document.getElementById(id);
  if (!el) return;
  lastFocused = document.activeElement;
  activeModalId = id;
  el.classList.remove('hidden');
  document.body.classList.add('modal-open');

  // Focus the first meaningful control, not the close button when avoidable.
  requestAnimationFrame(() => {
    const nodes = focusableIn(el);
    const preferred = nodes.find(n => !n.classList.contains('modal-close')) || nodes[0];
    preferred?.focus();
  });
}

export function closeModal(id) {
  const el = document.getElementById(id);
  if (!el) return;
  el.classList.add('hidden');
  if (activeModalId === id) activeModalId = null;
  if (!document.querySelector('.modal:not(.hidden)')) {
    document.body.classList.remove('modal-open');
  }
  if (lastFocused && document.contains(lastFocused)) {
    lastFocused.focus();
    lastFocused = null;
  }
}

export function closeAllModals() {
  document.querySelectorAll('.modal').forEach(m => m.classList.add('hidden'));
  activeModalId = null;
  document.body.classList.remove('modal-open');
}

export function showGenericModal(title, bodyHTML) {
  document.getElementById('modal-title').textContent = title;
  document.getElementById('modal-body').innerHTML = bodyHTML;
  openModal('generic-modal');
}

// ── Toasts (replaces blocking alert()) ──────────────────────────────────
export function toast(message, type = 'info', timeout = 4000) {
  const region = document.getElementById('toast-region');
  if (!region) return;

  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.setAttribute('role', type === 'error' ? 'alert' : 'status');

  const icon = type === 'success' ? '✓' : type === 'error' ? '!' : 'i';
  el.innerHTML = `<span class="toast-icon" aria-hidden="true">${icon}</span><span class="toast-msg"></span>`;
  el.querySelector('.toast-msg').textContent = message;

  const dismiss = document.createElement('button');
  dismiss.className = 'toast-close';
  dismiss.setAttribute('aria-label', 'Dismiss notification');
  dismiss.textContent = '×';
  dismiss.addEventListener('click', () => el.remove());
  el.appendChild(dismiss);

  region.appendChild(el);
  window.setTimeout(() => el.remove(), timeout);
}

// ── Accessible confirm dialog (replaces blocking confirm()) ─────────────
export function confirmDialog({ title, message, confirmLabel = 'Confirm', danger = false, confirmationText = '' }) {
  return new Promise(resolve => {
    const modal = document.getElementById('confirm-modal');
    document.getElementById('confirm-title').textContent = title;
    document.getElementById('confirm-message').textContent = message;

    const inputWrap = document.getElementById('confirm-input-wrap');
    const input = document.getElementById('confirm-input');
    const inputHint = document.getElementById('confirm-input-hint');
    if (inputWrap && input && inputHint) {
      inputWrap.classList.toggle('hidden', !confirmationText);
      input.value = '';
      inputHint.textContent = confirmationText ? `Type “${confirmationText}” to continue.` : '';
      input.setAttribute('aria-required', confirmationText ? 'true' : 'false');
    }

    const okBtn = document.getElementById('confirm-ok');
    const cancelBtn = document.getElementById('confirm-cancel');
    okBtn.textContent = confirmLabel;
    okBtn.className = `btn btn-full ${danger ? 'btn-danger' : 'btn-primary'}`;

    function cleanup(result) {
      okBtn.removeEventListener('click', onOk);
      cancelBtn.removeEventListener('click', onCancel);
      modal.removeEventListener('pumplog:closed', onCancel);
      closeModal('confirm-modal');
      resolve(result);
    }
    function onOk() {
      if (confirmationText && input?.value.trim() !== confirmationText) {
        if (inputHint) inputHint.textContent = `Type the station name exactly: ${confirmationText}`;
        input?.focus();
        return;
      }
      cleanup(true);
    }
    function onCancel() { cleanup(false); }

    okBtn.addEventListener('click', onOk);
    cancelBtn.addEventListener('click', onCancel);
    modal.addEventListener('pumplog:closed', onCancel, { once: true });

    openModal('confirm-modal');
    requestAnimationFrame(() => (confirmationText ? input : cancelBtn)?.focus());
  });
}

// ── Button busy state ───────────────────────────────────────────────────
export function setBusy(btn, busy, busyLabel = 'Working…') {
  if (!btn) return;
  if (busy) {
    btn.dataset.idleLabel = btn.dataset.idleLabel || btn.textContent;
    btn.disabled = true;
    btn.setAttribute('aria-busy', 'true');
    btn.textContent = busyLabel;
  } else {
    btn.disabled = false;
    btn.removeAttribute('aria-busy');
    if (btn.dataset.idleLabel) btn.textContent = btn.dataset.idleLabel;
  }
}

// ── Format helpers ──────────────────────────────────────────────────────
const inr = new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const litres = new Intl.NumberFormat('en-IN', { minimumFractionDigits: 1, maximumFractionDigits: 1 });

export function formatCurrency(val, currency = '₹') {
  return `${currency}${inr.format(Number(val) || 0)}`;
}

export function formatVolume(val) {
  return `${litres.format(Number(val) || 0)} L`;
}

// Parses 'YYYY-MM-DD' as a LOCAL date so the day never shifts by timezone.
function toDate(d) {
  if (!d) return null;
  if (typeof d.toDate === 'function') return d.toDate();
  if (d instanceof Date) return d;
  if (typeof d === 'string') {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d);
    if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  }
  const parsed = new Date(d);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function formatDate(d) {
  const date = toDate(d);
  if (!date) return '';
  return date.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
}

export function formatTime(d) {
  const date = toDate(d);
  if (!date) return '';
  return date.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
}

export function formatDateTime(d) {
  const date = toDate(d);
  if (!date) return '';
  return `${formatDate(date)} ${formatTime(date)}`;
}

export function timestampToDate(value) {
  return toDate(value);
}

export function formatTimeAgo(value) {
  const date = toDate(value);
  if (!date) return '';
  const minutes = Math.max(0, Math.floor((Date.now() - date.getTime()) / 60000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function knownHours(shift) {
  return typeof shift?.hoursWorked === 'number' && Number.isFinite(shift.hoursWorked)
    ? shift.hoursWorked
    : null;
}

export function getGreeting() {
  const hour = new Date().getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 17) return 'Good afternoon';
  return 'Good evening';
}

// Local calendar date (NOT toISOString, which is UTC and can be off by a day).
export function getTodayDate(offsetDays = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export const todayStr = () => getTodayDate();

export function rangeStart(range) {
  switch (range) {
    case 'today': return getTodayDate();
    case 'week': return getTodayDate(-6);
    case 'month': return getTodayDate(-29);
    default: return null; // 'all'
  }
}

// ── Loading / skeleton states ───────────────────────────────────────────
export function showLoading(show) {
  const el = document.getElementById('loading-screen');
  if (!el) return;
  el.classList.toggle('hidden', !show);
}

export function skeleton(rows = 3) {
  return `<div class="skeleton-wrap" aria-hidden="true">${
    Array.from({ length: rows }, () => '<div class="skeleton-row"></div>').join('')
  }</div>`;
}

export function showSkeleton(rows = 3) {
  const content = document.getElementById('page-content');
  if (content) content.innerHTML = skeleton(rows);
}

// ── Empty state ─────────────────────────────────────────────────────────
export function emptyState(icon, message, actionHTML = '') {
  return `<div class="empty-state">
    <div class="empty-icon" aria-hidden="true">${icon}</div>
    <p>${escapeHtml(message)}</p>
    ${actionHTML}
  </div>`;
}

// ── Debounce ────────────────────────────────────────────────────────────
export function debounce(fn, ms = 300) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}
