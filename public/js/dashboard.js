const API_URL = '/api';
const BRAIN_API = '/api/brain';
const ALERT_LABELS = {
    BUDGET_VARIANCE: 'Budget variance',
    DOC_NEEDS_REVIEW_AGED: 'Needs review 24h+',
    DOC_LOW_QUALITY: 'Low-quality OCR',
    DOC_HIGH_VALUE_NEEDS_REVIEW: 'High-value needs review',
    DOC_DUPLICATE_FILE: 'Duplicate file'
};

function authFetch(url, options = {}) {
    const opts = Object.assign({ credentials: 'include' }, options);
    return fetch(url, opts);
}

function formatINR(value) {
    if (value === null || value === undefined || Number.isNaN(Number(value))) return '—';
    return new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(value);
}

// Load dashboard data
async function loadDashboard() {
    try {
        // Get health stats
        const healthRes = await authFetch(`${API_URL}/health`);
        const health = await healthRes.json();
        
        document.getElementById('total-docs').textContent = health.stats.documents;
        
        // Get all documents
        const docsRes = await authFetch(`${API_URL}/documents`);
        const docsData = await docsRes.json();
        
        if (docsData.success) {
            const docs = docsData.documents;
            
            // Calculate this month count
            const now = new Date();
            const thisMonth = docs.filter(doc => {
                const docDate = new Date(doc.uploaded_at);
                return docDate.getMonth() === now.getMonth() && 
                       docDate.getFullYear() === now.getFullYear();
            }).length;
            
            document.getElementById('month-docs').textContent = thisMonth;
            document.getElementById('pending-docs').textContent = docs.filter(d => d.status === 'uploaded').length;
            
            // Show recent documents
            displayRecentDocuments(docs.slice(0, 5));
        }

        // Metrics summary
        const metricsRes = await authFetch(`${API_URL}/metrics/summary`);
        const metrics = await metricsRes.json();
        if (metrics.success) {
            renderMetrics(metrics);
        }

        await loadUnitEconomics();
        await loadWatchdog(true);
    } catch (error) {
        console.error('Error loading dashboard:', error);
        document.getElementById('recent-documents').innerHTML = `
            <div class="text-center py-8 text-red-500">
                <i class="fas fa-exclamation-triangle text-4xl mb-2"></i>
                <p>Error loading data. Is the server running?</p>
            </div>
        `;
    }
}

// Keyboard shortcuts
document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    if (e.key.toLowerCase() === 'u') window.location.href = 'upload.html';
    if (e.key.toLowerCase() === 'd') window.location.href = 'documents.html';
});

document.addEventListener('DOMContentLoaded', () => {
    if (window.sessionReady) {
        window.sessionReady.then(() => loadDashboard()).catch(() => {});
    } else {
        loadDashboard();
    }
});
function displayRecentDocuments(documents) {
    const container = document.getElementById('recent-documents');
    
    if (documents.length === 0) {
        container.innerHTML = `
            <div class="text-center py-8 text-gray-500">
                <i class="fas fa-inbox text-4xl mb-2"></i>
                <p>No documents yet</p>
                <a href="upload.html" class="text-indigo-600 hover:text-indigo-700 text-sm mt-2 inline-block">
                    Upload your first bill →
                </a>
            </div>
        `;
        return;
    }
    
    container.innerHTML = documents.map(doc => `
        <div class="flex items-center justify-between py-4 hover:bg-gray-50 px-4 rounded">
            <div class="flex items-center flex-1">
                <div class="flex-shrink-0">
                    <i class="fas fa-file-${getFileIcon(doc.file_type)} text-2xl ${getFileColor(doc.file_type)}"></i>
                </div>
                <div class="ml-4 flex-1">
                    <p class="font-medium text-gray-900">${doc.file_name}</p>
                    <div class="flex items-center space-x-4 text-sm text-gray-500 mt-1">
                        <span><i class="fas fa-tag mr-1"></i>${doc.document_category || 'uncategorized'}</span>
                        <span><i class="fas fa-clock mr-1"></i>${formatDate(doc.uploaded_at)}</span>
                        <span><i class="fas fa-hdd mr-1"></i>${formatBytes(doc.file_size)}</span>
                    </div>
                </div>
            </div>
            <div>
                <span class="px-3 py-1 text-xs font-medium rounded-full ${getStatusColor(doc.status)}">
                    ${doc.status}
                </span>
            </div>
        </div>
    `).join('');
}

function getFileIcon(mimeType) {
    if (mimeType.includes('pdf')) return 'pdf';
    if (mimeType.includes('image')) return 'image';
    return 'alt';
}

function getFileColor(mimeType) {
    if (mimeType.includes('pdf')) return 'text-red-500';
    if (mimeType.includes('image')) return 'text-blue-500';
    return 'text-gray-500';
}

function getStatusColor(status) {
    const colors = {
        'uploaded': 'bg-yellow-100 text-yellow-800',
        'processed': 'bg-green-100 text-green-800',
        'manual_required': 'bg-orange-100 text-orange-800',
        'error': 'bg-red-100 text-red-800'
    };
    return colors[status] || 'bg-gray-100 text-gray-800';
}

async function loadWatchdog(silent) {
    const container = document.getElementById('watchdog-list');
    if (!container) return;
    if (!silent) {
        container.innerHTML = `<div class="rounded-xl border border-slate-100 bg-slate-50 px-3 py-2 text-xs text-slate-500">Running checks…</div>`;
    }
    try {
        const [anomalyRes, alertsRes] = await Promise.all([
            authFetch(`${BRAIN_API}/watchdog`),
            authFetch(`${BRAIN_API}/alerts?status=open&limit=10`)
        ]);
        if (!anomalyRes.ok) throw new Error('Failed to run watchdog');
        if (!alertsRes.ok) throw new Error('Failed to load alerts');
        const anomalyData = await anomalyRes.json();
        const alertsData = await alertsRes.json();
        renderWatchdog(anomalyData, alertsData.alerts || []);
    } catch (err) {
        console.error('Watchdog error:', err);
        container.innerHTML = `<div class="rounded-xl border border-red-100 bg-red-50 px-3 py-2 text-xs text-red-600">Watchdog error: ${err.message || 'Unable to check'}</div>`;
    }
}

async function refreshWatchdog() {
    const container = document.getElementById('watchdog-list');
    if (container) {
        container.innerHTML = `<div class="rounded-xl border border-slate-100 bg-slate-50 px-3 py-2 text-xs text-slate-500">Re-running alerts…</div>`;
    }
    try {
        await authFetch(`${BRAIN_API}/alerts/run`, { method: 'POST' });
    } catch (err) {
        console.error('Alert run error', err);
    }
    loadWatchdog(true);
}

function renderMetrics(metrics) {
    // Docs by status summary
    const statusText = (metrics.docs_by_status || [])
        .map(s => `${s.status || 'unknown'}: ${s.count}`)
        .join(' • ');
    const statusEl = document.getElementById('docs-status');
    if (statusEl) statusEl.textContent = statusText || 'No data';

    // Top vendor
    const topVendor = (metrics.spend_by_vendor || [])[0];
    const topVendorEl = document.getElementById('top-vendor');
    if (topVendorEl) {
        if (topVendor) {
            topVendorEl.textContent =
                `${topVendor.vendor_name || 'N/A'} • ₹${Number(topVendor.total || 0).toLocaleString()}`;
        } else {
            topVendorEl.textContent = 'No data';
        }
    }
}

async function loadUnitEconomics() {
    const blendedEl = document.getElementById('blended-max-cac');
    const flagsEl = document.getElementById('cm-flags');
    if (!blendedEl || !flagsEl) return;
    try {
        const res = await authFetch(`${API_URL}/reports/unit-economics`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        const econ = data?.data || {};
        const perSku = econ.per_sku || [];
        const blendedMaxCac = econ.blended_max_cac;
        blendedEl.textContent = formatINR(blendedMaxCac);

        const negativeCount = perSku.filter(p => p.flags?.negative_cm).length;
        const missingCount = perSku.filter(p => p.flags?.missing_price || p.flags?.missing_cost || p.flags?.missing_assumptions).length;
        const total = perSku.length;
        if (total === 0) {
            flagsEl.textContent = 'No SKU unit economics yet';
        } else {
            flagsEl.textContent = `Negative CM SKUs: ${negativeCount} • Missing data: ${missingCount}`;
        }
    } catch (err) {
        console.error('Unit economics error:', err);
        blendedEl.textContent = '—';
        flagsEl.textContent = 'Unit economics unavailable';
    }
}

function renderWatchdog(data, alerts) {
    const container = document.getElementById('watchdog-list');
    if (!container) return;
    const anomalyRows = [
        {
            key: 'duplicates',
            label: 'Duplicate bills',
            icon: 'fa-copy',
            items: (data.duplicates || []).slice(0, 2).map(d => {
                if (d.is_file_duplicate) {
                    return `${d.vendor_name || 'Vendor'} • ${d.file_name || 'Duplicate file'} (${d.count} copies)`;
                }
                return `${d.vendor_name || 'Vendor'} • #${d.bill_number || 'N/A'} (${d.count}x)`;
            })
        },
        {
            key: 'stale_manual',
            label: 'Stale manual reviews',
            icon: 'fa-hourglass-half',
            items: (data.stale_manual || []).slice(0, 2).map(d => `${d.file_name || 'document'} • ${formatDate(d.uploaded_at)}`)
        },
        {
            key: 'aged_unpaid',
            label: 'Bills unpaid > 30d',
            icon: 'fa-calendar-xmark',
            items: (data.aged_unpaid || []).slice(0, 2).map(b => `${b.vendor_name || 'Vendor'} • ₹${Number(b.total_amount || 0).toLocaleString()}`)
        },
        {
            key: 'oversized',
            label: 'Spend spikes',
            icon: 'fa-chart-line',
            items: (data.oversized || []).slice(0, 2).map(o => `${o.vendor_name || 'Vendor'} • ₹${Number(o.total_amount || 0).toLocaleString()}`)
        }
    ];

    const summary = data.summary || {};
    const anomalyHtml = anomalyRows.map(row => {
        const count = summary[row.key] ?? (row.items?.length || 0);
        const hasIssues = count > 0;
        const list = row.items.length
            ? row.items.map(item => `<div class="text-xs text-slate-500">${item}</div>`).join('')
            : `<div class="text-xs text-slate-400">All clear</div>`;
        return `
            <div class="rounded-xl border border-slate-100 bg-white/70 p-3">
                <div class="flex items-center justify-between text-sm font-semibold ${hasIssues ? 'text-rose-600' : 'text-emerald-600'}">
                    <span><i class="fas ${row.icon} mr-2"></i>${row.label}</span>
                    <span>${count}</span>
                </div>
                <div class="mt-1 space-y-1">${list}</div>
            </div>
        `;
    }).join('');

    const alertHtml = (alerts || []).length
        ? alerts.map(renderAlertCard).join('')
        : `<div class="rounded-xl border border-emerald-100 bg-emerald-50 px-3 py-2 text-xs text-emerald-600">All alerts cleared</div>`;

    container.innerHTML = `
        <div class="space-y-2">
            <p class="text-xs uppercase tracking-[0.3em] text-slate-500">Anomaly scanners</p>
            ${anomalyHtml}
        </div>
        <div class="space-y-2">
            <p class="text-xs uppercase tracking-[0.3em] text-slate-500 mt-3">Alerts</p>
            ${alertHtml}
        </div>
    `;
}

function renderAlertCard(alert) {
    const severityClass = alert.severity === 'critical'
        ? 'border-rose-100 bg-rose-50 text-rose-700'
        : 'border-amber-100 bg-amber-50 text-amber-700';
    const label = ALERT_LABELS[alert.alert_type] || alert.alert_type.replace(/_/g, ' ');
    const subtitle = alert.alert_type === 'BUDGET_VARIANCE'
        ? `${alert.drop_name || 'Drop'} • ${alert.category_group || 'Group'}`
        : (alert.document_id ? `Document #${String(alert.document_id).padStart(4, '0')}` : '');
    return `
        <div class="rounded-xl border ${severityClass} p-3">
            <div class="flex items-center justify-between text-sm font-semibold">
                <span><i class="fas fa-circle-info mr-2"></i>${label}</span>
                <span>${alert.severity === 'critical' ? 'Critical' : 'Review'}</span>
            </div>
            ${subtitle ? `<div class="text-xs text-slate-500 mt-1">${subtitle}</div>` : ''}
            <div class="mt-1 text-xs text-slate-600">${alert.message}</div>
        </div>
    `;
}

function formatDate(dateString) {
    const date = new Date(dateString);
    const now = new Date();
    const diffMs = now - date;
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);
    
    if (diffMins < 60) return `${diffMins} min ago`;
    if (diffHours < 24) return `${diffHours} hours ago`;
    if (diffDays < 7) return `${diffDays} days ago`;
    return date.toLocaleDateString();
}

function formatBytes(bytes) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i];
}

// Load on page load
loadDashboard();
