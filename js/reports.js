/* Daily operational reports: generated from closed shifts, then submitted and approved. */
import { getDb, doc, setDoc, serverTimestamp } from './firebase.js';
import { getStation, getShifts, getDailyReports, getPumpSessions, invalidateStation } from './store.js';
import { getCurrentUserData, can, isStaff, formatFirebaseError } from './auth.js';
import { recordAudit } from './audit.js';
import { h, formatCurrency, formatVolume, formatDate, getTodayDate, emptyState, showSkeleton, toastError, toastSuccess, setBusy } from './components.js';

let state = null;
export function initReports() {}

const n = value => Number(value) || 0;
function totals(rows) {
  const fuelSold = rows.reduce((sum, row) => sum + n(row.volume), 0);
  const sales = rows.reduce((sum, row) => sum + n(row.sales), 0);
  const testingFuel = rows.reduce((sum, row) => sum + n(row.testingFuel), 0);
  const expenses = rows.reduce((sum, row) => sum + n(row.expensesTotal), 0);
  const credits = rows.reduce((sum, row) => sum + n(row.creditsTotal), 0);
  const digitalPayments = rows.reduce((sum, row) => sum + n(row.digitalPaymentsTotal), 0);
  return { fuelSold, sales, testingFuel, expenses, credits, digitalPayments, cashExpected: sales - expenses - credits - digitalPayments };
}
function reportBody(rows) {
  const t = totals(rows);
  return `<section class="report-printable"><div class="report-card-head"><div><p class="eyebrow">Daily report</p><h3>${h(formatDate(state.date) || state.date)}</h3><p class="report-card-sub">${h(state.station?.name || 'Station')}</p></div><span class="report-card-mark">⛽</span></div>
    <div class="report-stat-grid"><div><span>Closed pumps</span><strong>${rows.length}</strong></div><div><span>Fuel sold</span><strong>${h(formatVolume(t.fuelSold))}</strong></div><div><span>Sales</span><strong>${h(formatCurrency(t.sales))}</strong></div><div><span>Expected cash</span><strong>${h(formatCurrency(t.cashExpected))}</strong></div></div>
    <h4 class="report-breakdown-head">Pump closures</h4>${rows.length ? `<div class="report-breakdown-wrap"><table class="report-breakdown"><thead><tr><th>Pump</th><th>Employee</th><th>Opening</th><th>Closing</th><th>Sold</th><th>Testing</th><th>Expenses</th><th>Credits</th></tr></thead><tbody>${rows.map(row => `<tr><td>${h(row.pumpName || 'Pump')}</td><td>${h(row.staffName || 'Staff')}</td><td>${n(row.opening).toFixed(2)}</td><td>${n(row.closing).toFixed(2)}</td><td>${h(formatVolume(row.volume))}</td><td>${h(formatVolume(row.testingFuel))}</td><td>${h(formatCurrency(row.expensesTotal))}</td><td>${h(formatCurrency(row.creditsTotal))}</td></tr>`).join('')}</tbody></table></div>` : emptyState('⛽', 'No pump closures for this day.')}
    <section class="report-summary-section"><h4>Station summary</h4><dl class="profile-settings-list"><dt>Digital payments</dt><dd>${h(formatCurrency(t.digitalPayments))}</dd><dt>Overall expenses</dt><dd>${h(formatCurrency(t.expenses))}</dd><dt>Overall credits</dt><dd>${h(formatCurrency(t.credits))}</dd><dt>Cash summary</dt><dd>${h(formatCurrency(t.cashExpected))}</dd><dt>Variance</dt><dd>${h(formatCurrency(0))}</dd></dl></section></section>`;
}
function paint() {
  const host = document.getElementById('daily-report-body'); if (!host || !state) return;
  host.innerHTML = reportBody(state.rows);
  const current = state.existing;
  const status = current?.status || 'Draft';
  const info = document.getElementById('daily-report-status');
  if (info) info.innerHTML = `<span class="status-chip ${status === 'Approved' || status === 'Locked' ? 'active-mine' : 'idle'}">${h(status)}</span>`;
  const generate = document.getElementById('generate-report');
  const send = document.getElementById('send-report');
  const approve = document.getElementById('approve-report');
  if (generate) generate.disabled = !state.rows.length || !!current || state.activePumps > 0;
  if (send) send.hidden = !current || !['Draft'].includes(status) || !can('report.submit', { stationId: state.stationId });
  if (approve) approve.hidden = !current || !['Submitted', 'Pending Approval'].includes(status) || !can('report.approve', { stationId: state.stationId });
}
async function saveReport(status) {
  const me = getCurrentUserData(); const ref = doc(getDb(), 'stations', state.stationId, 'dailyReports', state.date);
  const payload = { stationId: state.stationId, date: state.date, status, pumpClosures: state.rows.map(row => ({ id: row.id, pumpId: row.pumpId, pumpName: row.pumpName || '', employeeId: row.staffUid || row.staffId || '', employeeName: row.staffName || '', opening: n(row.opening), closing: n(row.closing), fuelSold: n(row.volume), testingFuel: n(row.testingFuel), expenses: row.expenses || [], expensesTotal: n(row.expensesTotal), credits: row.credits || [], creditsTotal: n(row.creditsTotal), digitalPayments: row.digitalPayments || [], digitalPaymentsTotal: n(row.digitalPaymentsTotal) })), totals: totals(state.rows), updatedAt: serverTimestamp(), updatedBy: me.uid };
  if (!state.existing) Object.assign(payload, { createdAt: serverTimestamp(), createdBy: me.uid, creatorName: me.fullName || me.email || 'User' });
  if (status === 'Submitted') Object.assign(payload, { submittedAt: serverTimestamp(), submittedBy: me.uid, status: 'Submitted' });
  if (status === 'Approved') Object.assign(payload, { approvedAt: serverTimestamp(), approvedBy: me.uid, status: 'Approved' });
  await setDoc(ref, payload, { merge: true });
  state.existing = { ...(state.existing || {}), ...payload }; invalidateStation(state.stationId);
}
function wire() {
  document.getElementById('daily-report-date')?.addEventListener('change', async e => { state.date = e.target.value; await load(); });
  document.getElementById('generate-report')?.addEventListener('click', async e => { setBusy(e.currentTarget, true, 'Generating…'); try { await saveReport('Draft'); recordAudit(state.stationId, 'Daily Report Generated', { type: 'dailyReport', id: state.date }).catch(() => {}); toastSuccess('Draft report generated'); paint(); } catch (err) { toastError(formatFirebaseError(err)); } finally { setBusy(e.currentTarget, false); } });
  document.getElementById('send-report')?.addEventListener('click', async e => { setBusy(e.currentTarget, true, 'Sending…'); try { await saveReport('Submitted'); recordAudit(state.stationId, 'Report Submitted', { type: 'dailyReport', id: state.date }).catch(() => {}); toastSuccess('Report submitted for approval'); paint(); } catch (err) { toastError(formatFirebaseError(err)); } finally { setBusy(e.currentTarget, false); } });
  document.getElementById('approve-report')?.addEventListener('click', async e => { setBusy(e.currentTarget, true, 'Approving…'); try { await saveReport('Approved'); recordAudit(state.stationId, 'Report Approved', { type: 'dailyReport', id: state.date }).catch(() => {}); toastSuccess('Report approved and locked'); paint(); } catch (err) { toastError(formatFirebaseError(err)); } finally { setBusy(e.currentTarget, false); } });
  document.getElementById('report-print')?.addEventListener('click', () => window.print());
}
async function load() {
  showSkeleton(3); const [station, shifts, reports, sessions] = await Promise.all([getStation(state.stationId), getShifts(state.stationId, { from: state.date, max: 500 }), getDailyReports(state.stationId, { from: state.date, max: 100 }), getPumpSessions(state.stationId)]);
  state.station = station; state.activePumps = sessions.filter(row => row.status === 'active' && row.date === state.date).length; state.rows = shifts.filter(row => row.date === state.date); state.existing = reports.find(row => row.id === state.date) || null;
  document.getElementById('page-content').innerHTML = `<div class="page-head"><div><h2 class="page-title">Daily Reports</h2><p class="section-hint">Review closed pumps, then send one clear report for approval.${state.activePumps ? ` ${state.activePumps} pump${state.activePumps === 1 ? ' is' : 's are'} still waiting to close.` : ' All active pumps are closed.'}</p></div><button id="report-print" class="btn btn-secondary btn-small">Print / PDF</button></div><div class="report-filters"><div class="filter-field"><label for="daily-report-date">Day</label><input id="daily-report-date" type="date" max="${getTodayDate()}" value="${h(state.date)}" /></div><div id="daily-report-status"></div></div><div id="daily-report-body"></div><div class="report-actions"><button id="generate-report" class="btn btn-primary">Generate daily report</button><button id="send-report" class="btn btn-primary">Send report</button><button id="approve-report" class="btn btn-primary">Approve report</button></div>`;
  paint(); wire();
}
export async function renderReports(stationId) {
  if (!can('report.view', { stationId })) { document.getElementById('page-content').innerHTML = emptyState('🔒', 'Reports are not available for this station.'); return; }
  if (isStaff()) { document.getElementById('page-content').innerHTML = emptyState('📈', 'Your closed shifts are available in History. A manager generates the station daily report.'); return; }
  state = { stationId, date: getTodayDate(), rows: [], station: null, existing: null, activePumps: 0 }; try { await load(); } catch (err) { document.getElementById('page-content').innerHTML = emptyState('⚠️', formatFirebaseError(err)); }
}
