/* PumpLog — Report Cards
 *
 * Reports are read-only projections of shifts. Staff are deliberately scoped
 * to their own records by both this UI and Firestore rules; managers can pick
 * an employee at a station they manage.
 */

import { getAllStations, getStationsByIds, getStation, getShifts, getAllUsers, getUsersCreatedBy } from './store.js';
import {
  getCurrentUserData, isSuperAdmin, isStationAdmin, isStaff, can, formatFirebaseError,
} from './auth.js';
import {
  h, formatCurrency, formatVolume, formatDate, formatDateTime, knownHours,
  getTodayDate, rangeStart, emptyState, showSkeleton,
} from './components.js';

let reportState = null;
let wired = false;

export function initReports() {
  if (wired) wired = true;
}

function stationDateRange() {
  if (!reportState) return { from: null, to: null, label: 'All time' };
  if (reportState.range === 'custom') {
    return {
      from: reportState.from || null,
      to: reportState.to || reportState.from || null,
      label: reportState.from
        ? `${formatDate(reportState.from)}${reportState.to ? ` – ${formatDate(reportState.to)}` : ''}`
        : 'Choose dates',
    };
  }
  const from = rangeStart(reportState.range);
  return {
    from,
    to: reportState.range === 'all' ? null : getTodayDate(),
    label: reportState.range === 'today' ? 'Today' : reportState.range === 'week' ? 'Last 7 days'
      : reportState.range === 'month' ? 'Last 30 days' : 'All time',
  };
}

function employeeId(shift) {
  return shift.staffId || shift.staffUid || shift.createdBy || '';
}

function employeeName(shift, people = new Map()) {
  const person = people.get(employeeId(shift));
  return person?.fullName || person?.displayName || person?.email || person?.username
    || shift.staffName || shift.staffEmail || shift.createdBy || 'Unknown staff member';
}

function employeesFrom(shifts, people = new Map()) {
  const map = new Map();
  shifts.forEach(shift => {
    const uid = employeeId(shift);
    if (!uid) return;
    if (!map.has(uid)) map.set(uid, { uid, name: employeeName(shift, people) });
  });
  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function filteredRows() {
  if (!reportState) return [];
  const { from, to } = stationDateRange();
  const me = getCurrentUserData();
  return reportState.shifts.filter(shift => {
    const date = shift.date || '';
    const inRange = (!from || date >= from) && (!to || date <= to);
    const own = !isStaff() || employeeId(shift) === me?.uid || shift.createdBy === me?.uid;
    const employee = reportState.employee === 'all' || !reportState.employee || employeeId(shift) === reportState.employee;
    return inRange && own && employee;
  });
}

function reportSummary(rows) {
  const days = new Set(rows.map(s => s.date).filter(Boolean));
  const hours = rows.map(knownHours);
  const unknownHours = hours.filter(value => value == null).length;
  const totalHours = hours.reduce((sum, value) => sum + (value ?? 0), 0);
  return {
    days: days.size,
    hours: unknownHours ? '—' : `${totalHours.toFixed(2)} h`,
    unknownHours,
    volume: rows.reduce((sum, s) => sum + (Number(s.volume) || 0), 0),
    sales: rows.reduce((sum, s) => sum + (Number(s.sales) || 0), 0),
  };
}

function reportEmployeeLabel(rows) {
  if (reportState.employee === 'all') return isStaff() ? (getCurrentUserData()?.email || 'My report') : 'All employees';
  const found = reportState.employees.find(e => e.uid === reportState.employee);
  return found?.name || rows[0] && employeeName(rows[0], reportState.people) || getCurrentUserData()?.fullName || getCurrentUserData()?.email || 'Employee report';
}

function employeeOptions() {
  const options = reportState.employees.map(employee =>
    `<option value="${h(employee.uid)}" ${reportState.employee === employee.uid ? 'selected' : ''}>${h(employee.name)}</option>`
  ).join('');
  return isStaff() ? options : `<option value="all" ${reportState.employee === 'all' ? 'selected' : ''}>All employees</option>${options}`;
}

function filterHTML() {
  const stationOptions = reportState.stations.map(station =>
    `<option value="${h(station.id)}" ${station.id === reportState.stationId ? 'selected' : ''}>${h(station.name)}</option>`
  ).join('');
  const custom = reportState.range === 'custom';
  return `<div class="report-filters" aria-label="Report filters">
    ${reportState.stations.length > 1 ? `<div class="filter-field"><label for="report-station">Station</label><select id="report-station">${stationOptions}</select></div>` : ''}
    <div class="filter-field"><label for="report-employee">Employee</label>
      <select id="report-employee" ${isStaff() ? 'disabled aria-disabled="true"' : ''}>${employeeOptions()}</select></div>
    <div class="filter-field report-range-field"><span class="filter-label">Date range</span>
      <div class="report-range-chips" role="group" aria-label="Report date range">
        ${[['today', 'Today'], ['week', '7 days'], ['month', '30 days'], ['all', 'All time'], ['custom', 'Custom']].map(([value, label]) =>
          `<button type="button" class="chip ${reportState.range === value ? 'chip-active' : ''}" data-report-range="${value}" aria-pressed="${reportState.range === value}">${label}</button>`).join('')}
      </div></div>
    ${custom ? `<div class="filter-field"><label for="report-from">From</label><input type="date" id="report-from" max="${getTodayDate()}" value="${h(reportState.from || '')}" /></div>
      <div class="filter-field"><label for="report-to">To</label><input type="date" id="report-to" max="${getTodayDate()}" value="${h(reportState.to || '')}" /></div>` : ''}
  </div>`;
}

function breakdownHTML(rows) {
  if (!rows.length) return emptyState('📈', 'No shift records match these filters yet.');
  return `<div class="report-breakdown-wrap"><table class="report-breakdown"><caption class="sr-only">Report shift breakdown</caption><thead><tr>
    <th scope="col">Date</th><th scope="col">Pump</th><th scope="col">Shift</th><th scope="col">Hours</th><th scope="col">Volume</th><th scope="col">Sales</th>
  </tr></thead><tbody>${rows.map(shift => `<tr>
    <td>${h(formatDate(shift.date) || shift.date || '—')}</td><td>${h(shift.pumpName || 'Pump')}</td><td>S${h(shift.shiftLabel || '?')}</td>
    <td>${knownHours(shift) == null ? '—' : h(Number(shift.hoursWorked).toFixed(2))}</td>
    <td>${h(formatVolume(shift.volume))}</td><td>${h(formatCurrency(shift.sales))}</td>
  </tr>`).join('')}</tbody></table></div>`;
}

function paintReport() {
  const container = document.getElementById('report-results');
  if (!container || !reportState) return;
  const rows = filteredRows();
  const summary = reportSummary(rows);
  const station = reportState.stations.find(s => s.id === reportState.stationId) || reportState.station;
  const range = stationDateRange();
  const unknownNote = summary.unknownHours
    ? `${summary.unknownHours} older record${summary.unknownHours === 1 ? '' : 's'} do not have hours worked, so the hours total is shown as —.` : '';
  container.innerHTML = `<section class="report-printable" aria-labelledby="report-card-title">
    <div class="report-card-head"><div><p class="eyebrow">PumpLog Report Card</p><h3 id="report-card-title">${h(reportEmployeeLabel(rows))}</h3>
      <p class="report-card-sub">${h(station?.name || 'Station')} · ${h(range.label)}</p></div><span class="report-card-mark" aria-hidden="true">⛽</span></div>
    <div class="report-stat-grid">
      <div><span>Working days</span><strong>${summary.days}</strong></div><div><span>Hours worked</span><strong>${summary.hours}</strong></div>
      <div><span>Total volume</span><strong>${h(formatVolume(summary.volume))}</strong></div><div><span>Total sales</span><strong>${h(formatCurrency(summary.sales))}</strong></div>
    </div>${unknownNote ? `<p class="report-note">${h(unknownNote)}</p>` : ''}
    <div class="report-breakdown-head"><h4>Shift breakdown</h4><span>${rows.length} record${rows.length === 1 ? '' : 's'}</span></div>
    ${breakdownHTML(rows)}
  </section>`;
  const csv = document.getElementById('report-csv');
  const print = document.getElementById('report-print');
  if (csv) { csv.disabled = !rows.length; csv.onclick = () => exportCSV(rows, reportEmployeeLabel(rows)); }
  if (print) print.onclick = () => window.print();
}

async function loadReportData() {
  const dateRange = stationDateRange();
  const [shifts, peopleRows] = await Promise.all([
    getShifts(reportState.stationId, { from: dateRange.from, max: 5000 }),
    isSuperAdmin() ? getAllUsers() : isStationAdmin() ? getUsersCreatedBy(getCurrentUserData()?.uid) : Promise.resolve([getCurrentUserData()]),
  ]);
  reportState.shifts = shifts;
  reportState.people = new Map((peopleRows || []).filter(Boolean).map(person => [person.uid || person.id, person]));
  const scoped = reportState.shifts.filter(s => (!dateRange.to || (s.date || '') <= dateRange.to));
  reportState.employees = employeesFrom(scoped, reportState.people);
  const me = getCurrentUserData();
  if (isStaff()) reportState.employee = me?.uid || '';
  else if (reportState.employee !== 'all' && !reportState.employees.some(e => e.uid === reportState.employee)) reportState.employee = 'all';
  const station = reportState.stations.find(s => s.id === reportState.stationId);
  reportState.station = station || await getStation(reportState.stationId);
  const content = document.getElementById('page-content');
  if (!content) return;
  content.innerHTML = `<div class="page-head"><div><h2 class="page-title">Report Cards</h2><p class="section-hint">A shareable summary of work, volume, and sales.</p></div>
    <div class="report-actions"><button id="report-csv" class="btn btn-secondary btn-small" ${reportState.shifts.length ? '' : 'disabled'}>Export CSV</button>
      <button id="report-print" class="btn btn-primary btn-small">Print / PDF</button></div></div>
    ${filterHTML()}<div id="report-results"></div>`;
  paintReport();
  wireReportControls();
}

function wireReportControls() {
  document.getElementById('report-station')?.addEventListener('change', async e => {
    reportState.stationId = e.target.value;
    reportState.employee = isStaff() ? getCurrentUserData()?.uid || '' : 'all';
    showSkeleton(3);
    await loadReportData();
  });
  document.getElementById('report-employee')?.addEventListener('change', e => {
    reportState.employee = e.target.value;
    paintReport();
  });
  document.querySelectorAll('[data-report-range]').forEach(button => button.addEventListener('click', async () => {
    reportState.range = button.dataset.reportRange;
    if (reportState.range !== 'custom') { reportState.from = ''; reportState.to = ''; }
    await loadReportData();
  }));
  document.getElementById('report-from')?.addEventListener('change', async e => {
    reportState.from = e.target.value;
    if (reportState.to && reportState.to < reportState.from) reportState.to = reportState.from;
    await loadReportData();
  });
  document.getElementById('report-to')?.addEventListener('change', async e => {
    reportState.to = e.target.value;
    await loadReportData();
  });
}

export async function renderReports(stationId) {
  if (!can('report.view', { stationId })) {
    document.getElementById('page-content').innerHTML = emptyState('🔒', 'Reports are not available for this station.');
    return;
  }
  showSkeleton(4);
  try {
    const stations = isSuperAdmin() ? await getAllStations() : await getStationsByIds(getCurrentUserData()?.stationIds || []);
    reportState = {
      stationId: stations.some(s => s.id === stationId) ? stationId : stations[0]?.id,
      stations,
      station: null,
      shifts: [],
      people: new Map(),
      employees: [],
      employee: isStaff() ? getCurrentUserData()?.uid || '' : 'all',
      range: 'today', from: '', to: '',
    };
    if (!reportState.stationId) {
      document.getElementById('page-content').innerHTML = emptyState('📈', 'Select a station before creating a report.');
      return;
    }
    await loadReportData();
  } catch (err) {
    document.getElementById('page-content').innerHTML = emptyState('⚠️', formatFirebaseError(err));
  }
}

function csvCell(value) {
  return `"${String(value ?? '').replace(/"/g, '""')}"`;
}

function exportCSV(rows, employee) {
  const headers = ['Employee', 'Date', 'Station', 'Pump', 'Shift', 'Hours', 'Volume (L)', 'Sales', 'Clock in', 'Clock out'];
  const station = reportState.stations.find(s => s.id === reportState.stationId) || reportState.station;
  const csv = [headers.map(csvCell).join(','), ...rows.map(shift => [
    employee, shift.date, station?.name || '', shift.pumpName, shift.shiftLabel,
    knownHours(shift) == null ? '' : Number(shift.hoursWorked).toFixed(2),
    Number(shift.volume || 0).toFixed(2), Number(shift.sales || 0).toFixed(2),
    formatDateTime(shift.clockInAt), formatDateTime(shift.clockOutAt),
  ].map(csvCell).join(','))].join('\r\n');
  const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `pumplog-report-${getTodayDate()}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}
