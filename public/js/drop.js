const API_URL = '/api/brain';
const REPORT_API = '/api/reports';
const DEFAULT_BUDGET_GROUPS = ['COGS', 'OPERATING', 'MARKETING'];

let currentDrop = 'Drop 1';
let budgetGroups = [...DEFAULT_BUDGET_GROUPS];

function authFetch(url, options = {}) {
  const opts = Object.assign({ credentials: 'include' }, options);
  return fetch(url, opts);
}

function formatCurrency(val) {
  const n = Number(val || 0);
  return '₹' + n.toLocaleString(undefined, { maximumFractionDigits: 0 });
}

function formatGroupLabel(group) {
  return (group || 'OPERATING')
    .toString()
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function getBudgetWindow() {
  const now = new Date();
  const start = new Date(now.getFullYear(), 0, 1).toISOString().split('T')[0];
  const end = new Date(now.getFullYear(), 11, 31).toISOString().split('T')[0];
  return { start, end };
}

function setBudgetMessage(text, tone = 'muted') {
  const msg = document.getElementById('budget-message');
  if (!msg) return;
  msg.textContent = text || '';
  msg.className = `text-xs ${tone === 'error' ? 'text-rose-600' : tone === 'success' ? 'text-emerald-600' : 'text-slate-500'}`;
}

async function loadDrop() {
  const dropName = document.getElementById('drop-input').value || 'Drop 1';
  currentDrop = dropName;
  try {
    const resp = await authFetch(`${API_URL}/drop/${encodeURIComponent(dropName)}/cost`);
    const data = await resp.json();
    if (!resp.ok || data.error) throw new Error(data.error || 'Failed to load drop');

    document.getElementById('total-committed').textContent = formatCurrency(data.totals.committed);
    document.getElementById('total-paid').textContent = formatCurrency(data.totals.paid);
    document.getElementById('total-outstanding').textContent = formatCurrency(data.totals.outstanding);
    document.getElementById('period-label').textContent = `Drop: ${data.dropName}`;

    renderCategoryTable(data.byCategory || []);
    renderVendorTable(data.byVendor || []);
    renderSkuTable(data.perSku || []);
    renderBudgetInputs(data.budgetSummary || []);
    renderBudgetSummary(data.budgetSummary || [], data.budgetTotals || {});
    setBudgetMessage('');
  } catch (err) {
    console.error('Drop load error', err);
    document.getElementById('total-committed').textContent = '-';
    document.getElementById('total-paid').textContent = '-';
    document.getElementById('total-outstanding').textContent = '-';
    document.getElementById('cat-body').innerHTML = `<tr><td colspan="4" class="px-4 py-3 text-center text-rose-500 text-sm">${err.message || 'Failed to load drop'}</td></tr>`;
    document.getElementById('vendor-body').innerHTML = '';
    document.getElementById('sku-body').innerHTML = '';
    document.getElementById('budget-summary-body').innerHTML = `<tr><td colspan="5" class="px-4 py-3 text-center text-rose-500 text-sm">${err.message || 'Failed to load drop'}</td></tr>`;
    setBudgetMessage('Unable to fetch budgets.', 'error');
  }
}

function renderCategoryTable(rows) {
  const body = document.getElementById('cat-body');
  if (!body) return;
  body.innerHTML = rows.length
    ? rows.map(r => `
        <tr>
          <td class="px-4 py-2">${r.category}</td>
          <td class="px-4 py-2 text-right">${formatCurrency(r.committed)}</td>
          <td class="px-4 py-2 text-right">${formatCurrency(r.paid)}</td>
          <td class="px-4 py-2 text-right">${formatCurrency(r.outstanding)}</td>
        </tr>
      `).join('')
    : `<tr><td colspan="4" class="px-4 py-3 text-center text-slate-500 text-sm">No data</td></tr>`;
}

function renderVendorTable(rows) {
  const body = document.getElementById('vendor-body');
  if (!body) return;
  body.innerHTML = rows.length
    ? rows.map(v => `
        <tr>
          <td class="px-4 py-2">${v.vendor_name}</td>
          <td class="px-4 py-2 text-right">${formatCurrency(v.committed)}</td>
          <td class="px-4 py-2 text-right">${formatCurrency(v.paid)}</td>
        </tr>
      `).join('')
    : `<tr><td colspan="3" class="px-4 py-3 text-center text-slate-500 text-sm">No data</td></tr>`;
}

function renderSkuTable(rows) {
  const body = document.getElementById('sku-body');
  if (!body) return;
  body.innerHTML = rows.length
    ? rows.map(s => `
        <tr>
          <td class="px-4 py-2">${s.sku_code}</td>
          <td class="px-4 py-2 text-right">${formatCurrency(s.spend)}</td>
        </tr>
      `).join('')
    : `<tr><td colspan="2" class="px-4 py-3 text-center text-slate-500 text-sm">No SKU-tagged items</td></tr>`;
}

function renderBudgetInputs(summary) {
  const container = document.getElementById('budget-form-fields');
  if (!container) return;
  const groups = new Set(DEFAULT_BUDGET_GROUPS);
  summary.forEach(row => {
    if (row.category_group) {
      groups.add(row.category_group.toUpperCase());
    }
  });
  budgetGroups = Array.from(groups);
  container.innerHTML = budgetGroups.map(group => {
    const existing = summary.find(r => (r.category_group || '').toUpperCase() === group);
    const value = existing && existing.budget_amount ? Number(existing.budget_amount) : '';
    return `
      <div>
        <label class="block text-xs font-semibold text-slate-600 mb-1">${formatGroupLabel(group)} budget (₹)</label>
        <input id="budget-input-${group}" type="number" min="0" step="1000" value="${value !== '' ? value : ''}" class="w-full px-3 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-indigo-500 text-sm" placeholder="0" />
      </div>
    `;
  }).join('');
}

function renderBudgetSummary(summary, totals) {
  const body = document.getElementById('budget-summary-body');
  const totalEl = document.getElementById('budget-total');
  const varianceEl = document.getElementById('budget-variance');

  if (body) {
    if (!summary.length) {
      body.innerHTML = `<tr><td colspan="5" class="px-4 py-3 text-center text-slate-500 text-sm">No budgets yet. Use the form below to add one.</td></tr>`;
    } else {
      body.innerHTML = summary.map(row => {
        const variance = Number(row.variance || 0);
        const statusPositive = variance >= 0;
        return `
          <tr>
            <td class="px-4 py-2 font-medium">${formatGroupLabel(row.category_group)}</td>
            <td class="px-4 py-2 text-right">${formatCurrency(row.budget_amount)}</td>
            <td class="px-4 py-2 text-right">${formatCurrency(row.actual_amount)}</td>
            <td class="px-4 py-2 text-right ${statusPositive ? 'text-emerald-600' : 'text-rose-600'}">${statusPositive ? '+' : '-'}${formatCurrency(Math.abs(variance))}</td>
            <td class="px-4 py-2">
              <span class="inline-flex items-center px-2 py-1 rounded-full text-xs ${statusPositive ? 'bg-emerald-100 text-emerald-700' : 'bg-rose-100 text-rose-700'}">
                ${statusPositive ? 'Under budget' : 'Over budget'}
              </span>
            </td>
          </tr>
        `;
      }).join('');
    }
  }

  if (totalEl) {
    totalEl.textContent = formatCurrency(totals.budgeted || 0);
  }

  if (varianceEl) {
    const variance = Number(totals.variance || 0);
    const positive = variance >= 0;
    varianceEl.textContent = `${positive ? '+' : '-'}${formatCurrency(Math.abs(variance))} vs budget`;
    varianceEl.className = positive
      ? 'text-xs font-semibold text-emerald-600'
      : 'text-xs font-semibold text-rose-600';
  }
}

async function saveBudgets() {
  const saveBtn = document.getElementById('budget-save');
  if (!saveBtn) return;
  const groups = budgetGroups.length ? budgetGroups : DEFAULT_BUDGET_GROUPS;
  const { start, end } = getBudgetWindow();
  const requests = [];

  groups.forEach(group => {
    const input = document.getElementById(`budget-input-${group}`);
    if (!input) return;
    const raw = (input.value || '').trim();
    if (!raw) return;
    const amount = Number(raw);
    if (isNaN(amount)) return;
    requests.push(authFetch(`${REPORT_API}/drop-budgets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        drop_name: currentDrop,
        department: group,
        amount,
        start_date: start,
        end_date: end,
        notes: null
      })
    }));
  });

  if (!requests.length) {
    setBudgetMessage('Enter at least one budget amount to save.', 'error');
    return;
  }

  try {
    saveBtn.disabled = true;
    saveBtn.classList.add('opacity-60', 'cursor-not-allowed');
    setBudgetMessage('Saving budgets…');
    await Promise.all(requests);
    setBudgetMessage('Budgets saved.', 'success');
    await loadDrop();
  } catch (err) {
    console.error('Save budgets error', err);
    setBudgetMessage(err.message || 'Failed to save budgets.', 'error');
  } finally {
    saveBtn.disabled = false;
    saveBtn.classList.remove('opacity-60', 'cursor-not-allowed');
  }
}

document.addEventListener('DOMContentLoaded', () => {
  if (window.sessionReady) {
    window.sessionReady.then(() => loadDrop()).catch(() => {});
  } else {
    loadDrop();
  }
});
