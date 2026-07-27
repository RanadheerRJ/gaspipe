/* PumpLog — Shared UI Components */

// ── Modal helpers ────────────────────────────────────────────────────────
export function openModal(id) {
  const el = document.getElementById(id);
  if (el) el.classList.remove('hidden');
}

export function closeModal(id) {
  const el = document.getElementById(id);
  if (el) el.classList.add('hidden');
}

export function closeAllModals() {
  document.querySelectorAll('.modal').forEach(m => m.classList.add('hidden'));
}

// ── Show generic modal with custom body ─────────────────────────────────
export function showGenericModal(title, bodyHTML) {
  document.getElementById('modal-title').textContent = title;
  document.getElementById('modal-body').innerHTML = bodyHTML;
  openModal('generic-modal');
}

// ── Format helpers ──────────────────────────────────────────────────────
export function formatCurrency(val, currency = '₹') {
  const num = Number(val) || 0;
  return `${currency}${num.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function formatVolume(val) {
  const num = Number(val) || 0;
  return `${num.toLocaleString('en-IN', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} L`;
}

export function formatDate(d) {
  if (!d) return '';
  const date = d.toDate ? d.toDate() : new Date(d);
  return date.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
}

export function formatTime(d) {
  if (!d) return '';
  const date = d.toDate ? d.toDate() : new Date(d);
  return date.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
}

export function formatDateTime(d) {
  if (!d) return '';
  return `${formatDate(d)} ${formatTime(d)}`;
}

export function getGreeting() {
  const h = new Date().getHours();
  if (h < 12) return 'Good morning';
  if (h < 17) return 'Good afternoon';
  return 'Good evening';
}

export function todayStr() {
  const d = new Date();
  return d.toISOString().split('T')[0];
}

export function getTodayDate() {
  return new Date().toISOString().split('T')[0];
}

// ── Loading overlay ─────────────────────────────────────────────────────
export function showLoading(show) {
  const el = document.getElementById('loading-screen');
  if (show) {
    el.classList.remove('hidden');
  } else {
    el.classList.add('hidden');
  }
}

// ── Empty state ─────────────────────────────────────────────────────────
export function emptyState(icon, message) {
  return `<div class="empty-state">
    <div class="empty-icon">${icon}</div>
    <p>${message}</p>
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
