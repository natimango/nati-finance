const API_URL = '/api';

function authFetch(url, options = {}) {
  const opts = Object.assign({ credentials: 'include' }, options);
  return fetch(url, opts);
}

function formatMoney(val) {
  const n = Number(val || 0);
  return '₹' + n.toLocaleString(undefined, { maximumFractionDigits: 0 });
}

function formatLabel(value) {
  if (!value) return 'Unspecified';
  return value.toString().toLowerCase().replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function formatLocalDate(date) {
  const d = new Date(date);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function defaultDates() {
  const today = new Date();
  const yearStart = new Date(today.getFullYear(), 0, 1);
  document.getElementById('start-date').value = formatLocalDate(yearStart);
  document.getElementById('end-date').value = formatLocalDate(today);
}

async function refreshReports() {
  const start = document.getElementById('start-date').value;
  const end = document.getElementById('end-date').value;
  await Promise.all([loadPL(start, end), loadMetrics(start, end)]);
  const ts = new Date().toLocaleTimeString();
  const badge = document.getElementById('last-updated');
  if (badge) badge.textContent = `Updated ${ts}`;
}

async function loadPL(start, end) {
  try {
    const params = new URLSearchParams();
    if (start) params.append('start_date', start);
    if (end) params.append('end_date', end);
    const resp = await authFetch(`${API_URL}/reports/profit-loss?` + params.toString(), { cache: 'no-store' });
    const data = await resp.json();
    if (!resp.ok || data.error) throw new Error(data.error || 'Failed to load P&L');

    document.getElementById('rev-total').textContent = formatMoney(data.revenue.total);
    document.getElementById('cogs-total').textContent = formatMoney(data.cogs.total);
    document.getElementById('gross-profit').textContent = formatMoney(data.gross_profit);
    document.getElementById('exp-total').textContent = formatMoney(data.expenses.total);
    document.getElementById('net-profit').textContent = formatMoney(data.net_profit);

    const revBody = document.getElementById('rev-body');
    revBody.innerHTML = (data.revenue.accounts || []).map(r => `
      <tr><td class="py-1">${r.account_name}</td><td class="py-1 text-right">${formatMoney(r.amount)}</td></tr>
    `).join('') || `<tr><td class="py-2 text-slate-500" colspan="2">No revenue data</td></tr>`;

    const cogsBody = document.getElementById('cogs-body');
    cogsBody.innerHTML = (data.cogs.accounts || []).map(r => `
      <tr><td class="py-1">${r.account_name}</td><td class="py-1 text-right">${formatMoney(r.amount)}</td></tr>
    `).join('') || `<tr><td class="py-2 text-slate-500" colspan="2">No COGS data</td></tr>`;

    const expBody = document.getElementById('exp-body');
    expBody.innerHTML = (data.expenses.accounts || []).map(r => `
      <tr><td class="py-1">${r.account_name}</td><td class="py-1 text-right">${formatMoney(r.amount)}</td></tr>
    `).join('') || `<tr><td class="py-2 text-slate-500" colspan="2">No expense data</td></tr>`;
  } catch (err) {
    console.error('P&L error', err);
    document.getElementById('rev-total').textContent = '-';
    document.getElementById('cogs-total').textContent = '-';
    document.getElementById('gross-profit').textContent = '-';
    document.getElementById('exp-total').textContent = '-';
    document.getElementById('net-profit').textContent = '-';
    document.getElementById('rev-body').innerHTML = `<tr><td colspan="2" class="py-2 text-red-500 text-sm">${err.message}</td></tr>`;
    document.getElementById('cogs-body').innerHTML = '';
    document.getElementById('exp-body').innerHTML = '';
  }
}

async function loadMetrics(start, end) {
  try {
    const params = new URLSearchParams();
    if (start) params.append('start_date', start);
    if (end) params.append('end_date', end);
    const resp = await authFetch(`${API_URL}/metrics/summary?` + params.toString(), { cache: 'no-store' });
    const data = await resp.json();
    if (!resp.ok || data.error) throw new Error(data.error || 'Failed to load metrics');

    const docsEl = document.getElementById('docs-status');
    docsEl.innerHTML = (data.docs_by_status || []).map(d => `
      <li>${d.status || 'unknown'}: <span class="font-semibold">${d.count}</span></li>
    `).join('') || `<li class="text-slate-500">No documents</li>`;

    const groupEl = document.getElementById('group-body');
    if (groupEl) {
      groupEl.innerHTML = (data.spend_by_group || []).map(g => `
        <li>${formatLabel(g.category_group)}: <span class="font-semibold">${formatMoney(g.total)}</span></li>
      `).join('') || `<li class="text-slate-500">No spend recorded</li>`;
    }

    const vendorBody = document.getElementById('vendor-body');
    const topVendors = (data.spend_by_vendor || []).slice(0, 3);
    vendorBody.innerHTML = topVendors.map(v => `
      <tr><td class="py-1">${v.vendor_name || 'Unassigned'}</td><td class="py-1 text-right">${formatMoney(v.total)}</td></tr>
    `).join('') || `<tr><td colspan="2" class="py-2 text-slate-500">No vendor spend</td></tr>`;

    const catBody = document.getElementById('cat-body');
    catBody.innerHTML = (data.spend_by_category || []).map(c => `
      <tr><td class="py-1">${c.category || 'uncategorized'}</td><td class="py-1 text-right">${formatMoney(c.total)}</td></tr>
    `).join('') || `<tr><td colspan="2" class="py-2 text-slate-500">No category spend</td></tr>`;

    const payBody = document.getElementById('pay-body');
    const paymentRows = data.spend_by_payment_method || [];
    const label = (m) => {
      const mm = (m || 'UNSPECIFIED').toUpperCase();
      if (mm === 'CASH') return 'Cash';
      if (mm === 'UPI') return 'UPI';
      if (mm === 'BANK_TRANSFER') return 'Bank Transfer';
      if (mm === 'CHEQUE' || mm === 'CHECK') return 'Cheque';
      if (mm === 'OTHER') return 'Other';
      return mm;
    };
    payBody.innerHTML = paymentRows.map(p => `
      <tr><td class="py-1">${label(p.payment_method)}</td><td class="py-1 text-right">${formatMoney(p.total)}</td></tr>
    `).join('') || `<tr><td colspan="2" class="py-2 text-slate-500">No payment breakdown</td></tr>`;
  } catch (err) {
    console.error('Metrics error', err);
    document.getElementById('docs-status').innerHTML = `<li class="text-red-500 text-sm">${err.message}</li>`;
    document.getElementById('vendor-body').innerHTML = '';
    document.getElementById('cat-body').innerHTML = '';
    const payBody = document.getElementById('pay-body');
    if (payBody) payBody.innerHTML = '';
  }
}

document.addEventListener('DOMContentLoaded', () => {
  const init = () => {
    defaultDates();
    refreshReports();
    setInterval(refreshReports, 30000);
  };
  if (window.sessionReady) {
    window.sessionReady.then(init).catch(() => {});
  } else {
    init();
  }
});
