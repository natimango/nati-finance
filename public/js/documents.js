const API_URL = '/api';
let allDocuments = [];
let filteredDocuments = [];
let currentProcessingDoc = null;
let currentManualDoc = null;
let manualLineItems = [];
let calendarCursor = new Date();
let filtersCollapsed = false;
let calendarCollapsed = false;
let useBillDateMode = true; // true = bill_date, false = uploaded_at

function authFetch(url, options = {}) {
    const opts = Object.assign({ credentials: 'include' }, options);
    return fetch(url, opts);
}

function getCategory(doc) {
    return doc.bill_category || doc.category || doc.document_category || doc.gemini_data?.category || '—';
}

function getCategoryGroup(doc) {
    return doc.category_group || doc.gemini_data?.category_group || null;
}

function formatLabel(value) {
    const v = value || '—';
    if (v === '—') return v;
    return v.toString().replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function getPayment(doc) {
    // Payment should come directly from the chosen method on upload/manual save
    return doc.bill_payment_method || doc.payment_method || doc.document_payment_method || '—';
}

function getDocDate(doc) {
    if (!useBillDateMode) return doc.uploaded_at;
    // Prefer the bill_date (actual invoice date); fall back to AI guess; finally uploaded_at
    return doc.bill_date || doc.gemini_data?.bill_date || doc.uploaded_at;
}

async function loadDocuments() {
    try {
        const response = await authFetch(`${API_URL}/documents`);
        const data = await response.json();
        
        if (data.success) {
            allDocuments = data.documents;
            filteredDocuments = allDocuments;
            displayDocuments(filteredDocuments);
            updateDocCount();
            renderCalendar();
        }
    } catch (error) {
        console.error('Error loading documents:', error);
    }
}

function displayDocuments(documents) {
    renderTable(documents);
}

function renderTable(documents) {
    const body = document.getElementById('documents-table-body');
    if (!body) return;
    if (documents.length === 0) {
        body.innerHTML = `<tr><td colspan="7" class="px-3 py-4 text-center text-gray-500">No documents found</td></tr>`;
        return;
    }
    body.innerHTML = documents.map((doc, idx) => {
        const status = getStatusBadge(doc.status);
        const vendor = doc.vendor_name || doc.gemini_data?.vendor_name || '—';
        const total = doc.total_amount || doc.gemini_data?.amounts?.total || 0;
        const billDate = getDocDate(doc);
        const providerInfo = getProviderInfo(doc.gemini_data);
        const paymentRaw = (getPayment(doc) || '').toUpperCase();
        const paymentMethod = paymentRaw && paymentRaw !== 'UNSPECIFIED'
            ? formatLabel(paymentRaw.toLowerCase())
            : '—';
        const categoryValue = formatLabel(getCategory(doc));
        const categoryGroup = getCategoryGroup(doc);
        const categoryDisplay = categoryGroup
            ? `${formatLabel(categoryGroup)} • ${categoryValue}`
            : categoryValue;
        const fileNumber = doc.document_id
            ? `#${String(doc.document_id).padStart(4, '0')}`
            : `#${String(idx + 1).padStart(4, '0')}`;
        return `
            <tr class="hover:bg-gray-50 cursor-pointer" data-id="${doc.document_id}" onclick="openBillModal(${doc.document_id})">
                <td class="px-3 py-2 text-sm text-gray-700">${fileNumber}</td>
                <td class="px-3 py-2 text-sm text-gray-900">${vendor}</td>
                <td class="px-3 py-2 text-sm text-gray-700">${categoryDisplay}</td>
                <td class="px-3 py-2 text-sm text-gray-700">${paymentMethod}</td>
                <td class="px-3 py-2 text-xs">${status}</td>
                <td class="px-3 py-2 text-right text-sm font-semibold">₹${Number(total || 0).toLocaleString()}</td>
                <td class="px-3 py-2 text-xs text-gray-500">${formatDate(billDate)}${providerInfo ? `<br><span class="text-[11px] text-gray-500">${providerInfo}</span>` : ''}</td>
            </tr>
        `;
    }).join('');
}

let selectedDocId = null;
function selectDocument(id) {
    selectedDocId = id;
    const doc = filteredDocuments.find(d => d.document_id === id);
    renderDetail(doc);
}


function openBillModal(id) {
    const doc = filteredDocuments.find(d => d.document_id === id);
    if (!doc) return;
    selectedDocId = id;
    const modal = document.getElementById('bill-modal');
    const body = document.getElementById('bill-modal-body');
    const titleEl = document.getElementById('bill-modal-title');
    const subEl = document.getElementById('bill-modal-sub');
    const providerInfo = getProviderInfo(doc.gemini_data);
    const total = doc.total_amount || doc.gemini_data?.amounts?.total || 0;
    const billNo = doc.bill_number || doc.gemini_data?.bill_number || '—';
    const billDate = getDocDate(doc);
    const vendor = doc.vendor_name || doc.gemini_data?.vendor_name || '—';
    const status = getStatusBadge(doc.status);
    const canProcess = doc.can_process !== false;
    const canManual = doc.can_manual !== false;
    const canDeleteDoc = doc.can_delete !== false;
    const categoryValue = formatLabel(getCategory(doc));
    const categoryGroup = getCategoryGroup(doc);
    const categoryLabel = categoryGroup
        ? `${formatLabel(categoryGroup)} • ${categoryValue}`
        : categoryValue;
    const previewButton = canPreviewFile(doc.file_type)
        ? `<button onclick="actionPreview(${doc.document_id}, '${doc.file_name?.replace('"','') || ''}', '${doc.file_type}')" class="px-3 py-2 bg-indigo-600 text-white rounded-lg text-sm"><i class='fas fa-eye mr-1'></i>Preview</button>`
        : '';
    const processButton = doc.status !== 'processed'
        ? (canProcess
            ? `<button onclick="actionProcessAI(${doc.document_id})" class="px-3 py-2 bg-purple-600 text-white rounded-lg text-sm"><i class='fas fa-robot mr-1'></i>Process AI</button>`
            : `<span class="px-3 py-2 bg-slate-100 text-slate-500 rounded-lg text-xs inline-flex items-center gap-1"><i class="fas fa-lock"></i>Manager required</span>`)
        : `<button onclick="actionViewData(${doc.document_id})" class="px-3 py-2 bg-purple-600 text-white rounded-lg text-sm"><i class='fas fa-eye mr-1'></i>View Data</button>`;
    const manualButton = canManual
        ? `<button onclick="actionManual(${doc.document_id})" class="px-3 py-2 bg-orange-500 text-white rounded-lg text-sm"><i class='fas fa-hand-paper mr-1'></i>Manual</button>`
        : '';
    const deleteButton = canDeleteDoc
        ? `<button onclick="actionDelete(${doc.document_id}, ${doc.bill_id || 'null'})" class="px-3 py-2 bg-red-600 text-white rounded-lg text-sm"><i class='fas fa-trash mr-1'></i>Delete</button>`
        : '';

    titleEl.textContent = vendor;
    subEl.textContent = `Bill: ${billNo} • ${formatDate(billDate)}`;

    body.innerHTML = `
        <div class="space-y-3">
            <div class="flex items-start justify-between gap-3">
                <div>
                    <p class="text-sm text-gray-500">${status}${providerInfo ? ` <span class='text-xs text-gray-500 ml-1'>${providerInfo}</span>` : ''}</p>
                    <p class="text-xs text-gray-500">${doc.file_name || ''}</p>
                </div>
                <div class="text-sm text-gray-700 flex items-center gap-2">
                    <span class="inline-flex items-center px-2 py-1 bg-gray-100 rounded text-xs text-gray-700"><i class="fas fa-money-bill-wave mr-1 text-green-600"></i>₹${Number(total||0).toLocaleString()}</span>
                    ${categoryLabel && categoryLabel !== '—' ? `<span class="inline-flex items-center px-2 py-1 bg-indigo-50 text-indigo-700 rounded text-xs"><i class="fas fa-tag mr-1"></i>${categoryLabel}</span>` : ''}
                </div>
            </div>
            <div class="grid grid-cols-1 sm:grid-cols-2 gap-2 text-sm text-gray-700">
                <div><span class="text-gray-500">Bill No:</span> ${billNo}</div>
                <div><span class="text-gray-500">Date:</span> ${formatDateDisplay(billDate)}</div>
                <div><span class="text-gray-500">Doc Type:</span> ${doc.file_type || '—'}</div>
                <div><span class="text-gray-500">File:</span> ${doc.file_name || '—'}</div>
            </div>
            <div class="flex flex-wrap gap-2 pt-2">
                ${previewButton}
                ${processButton}
                ${manualButton}
                ${deleteButton}
                <button onclick="actionDownload(${doc.document_id})" class="px-3 py-2 bg-green-600 text-white rounded-lg text-sm"><i class='fas fa-download mr-1'></i>Download</button>
            </div>
        </div>
    `;
    modal.classList.remove('hidden');
    modal.classList.add('flex');
}
function closeBillModal() {
    const modal = document.getElementById('bill-modal');
    if (modal) {
        modal.classList.add('hidden');
        modal.classList.remove('flex');
    }
}
function renderDetail(doc) { return; }

function toggleSection(bodyId, btnId) {
    const body = document.getElementById(bodyId);
    const btn = document.getElementById(btnId);
    if (!body || !btn) return;
    const isCollapsed = body.classList.contains('collapsed');
    if (isCollapsed) {
        body.classList.remove('collapsed');
        body.classList.add('expanded');
        btn.innerHTML = `<i class="fas fa-chevron-up mr-1"></i>Collapse`;
    } else {
        body.classList.remove('expanded');
        body.classList.add('collapsed');
        btn.innerHTML = `<i class="fas fa-chevron-down mr-1"></i>Expand`;
    }
}

function closeDetail() {
    const pane = document.getElementById('detail-pane');
    if (pane) {
        pane.classList.add('mobile-hidden');
        pane.innerHTML = `<p class="text-sm text-gray-500">Select a bill to view details.</p>`;
    }
    selectedDocId = null;
}

async function processWithAI(documentId) {
    const modal = document.getElementById('ai-modal');
    const content = document.getElementById('ai-content');
    
    content.innerHTML = `
        <div class="text-center py-12">
            <i class="fas fa-robot text-6xl text-indigo-600 mb-4 animate-pulse"></i>
            <h3 class="text-xl font-semibold text-gray-900 mb-2">Processing with AI...</h3>
            <p class="text-gray-600">Extracting vendor details, amounts, payment terms, and line items</p>
            <div class="mt-6">
                <div class="w-full bg-gray-200 rounded-full h-2">
                    <div class="bg-indigo-600 h-2 rounded-full animate-pulse" style="width: 60%"></div>
                </div>
            </div>
        </div>
    `;
    
    modal.classList.remove('hidden');
    
    try {
        const response = await authFetch(`${API_URL}/bills/${documentId}/process`, {
            method: 'POST'
        });
        
        const data = await response.json();
        
        if (data.success) {
            displayExtractedData(data.extracted_data, data.bill_id);
        } else {
            content.innerHTML = `
                <div class="text-center py-12">
                    <i class="fas fa-exclamation-triangle text-6xl text-red-600 mb-4"></i>
                    <h3 class="text-xl font-semibold text-gray-900 mb-2">Processing Failed</h3>
                    <p class="text-gray-600">${data.error || 'Unknown error'}</p>
                    <button onclick="closeAIModal()" class="mt-4 px-6 py-2 bg-gray-600 text-white rounded-lg">
                        Close
                    </button>
                </div>
            `;
        }
        
    } catch (error) {
        console.error('AI Processing error:', error);
        content.innerHTML = `
            <div class="text-center py-12">
                <i class="fas fa-exclamation-triangle text-6xl text-red-600 mb-4"></i>
                <h3 class="text-xl font-semibold text-gray-900 mb-2">Processing Failed</h3>
                <p class="text-gray-600">${error.message}</p>
                <button onclick="closeAIModal()" class="mt-4 px-6 py-2 bg-gray-600 text-white rounded-lg">
                    Close
                </button>
            </div>
        `;
    }
}

async function retryAI(documentId) {
    try {
        const response = await authFetch(`${API_URL}/bills/${documentId}/process`, { method: 'POST' });
        const data = await response.json();
        if (data.success) {
            alert('AI retry successful');
            displayExtractedData(data.extracted_data, data.bill_id);
        } else {
            alert(`AI retry failed: ${data.error || 'Unknown error'}`);
        }
        loadDocuments();
    } catch (error) {
        alert(`AI retry failed: ${error.message}`);
        console.error('Retry AI error:', error);
    }
}

function displayExtractedData(data, billId) {
    const content = document.getElementById('ai-content');
    const actions = document.getElementById('ai-actions');
    const provider = data._provider ? data._provider.toUpperCase() : (data.manual ? 'MANUAL' : 'AI');
    const fallback = data._fallback ? ' (fallback)' : '';
    
    content.innerHTML = `
        <div class="space-y-6">
            <div class="bg-green-50 border border-green-200 rounded-lg p-4">
                <div class="flex items-center">
                    <i class="fas fa-check-circle text-green-600 text-2xl mr-3"></i>
                    <div>
                        <h4 class="font-semibold text-green-900">Successfully Extracted</h4>
                        <p class="text-sm text-green-700">Confidence: ${Math.round((data.confidence || 0.9) * 100)}% • Provider: ${provider}${fallback}</p>
                    </div>
                </div>
            </div>
            
            <!-- Vendor Information -->
            <div class="bg-white border rounded-lg p-4">
                <h4 class="font-semibold text-gray-900 mb-3 flex items-center">
                    <i class="fas fa-building mr-2 text-indigo-600"></i>Vendor Information
                </h4>
                <div class="grid grid-cols-2 gap-4 text-sm">
                    <div><span class="text-gray-600">Name:</span> <span class="font-medium">${data.vendor_name || 'N/A'}</span></div>
                    <div><span class="text-gray-600">GSTIN:</span> <span class="font-medium">${data.vendor_gstin || 'N/A'}</span></div>
                    <div><span class="text-gray-600">Contact:</span> <span class="font-medium">${data.vendor_contact || 'N/A'}</span></div>
                    <div><span class="text-gray-600">Category:</span> <span class="font-medium">${data.category || 'N/A'}</span></div>
                </div>
            </div>
            
            <!-- Bill Details -->
            <div class="bg-white border rounded-lg p-4">
                <h4 class="font-semibold text-gray-900 mb-3 flex items-center">
                    <i class="fas fa-file-invoice mr-2 text-indigo-600"></i>Bill Details
                </h4>
                <div class="grid grid-cols-2 gap-4 text-sm">
                    <div><span class="text-gray-600">Bill Number:</span> <span class="font-medium">${data.bill_number || 'N/A'}</span></div>
                    <div><span class="text-gray-600">Bill Date:</span> <span class="font-medium">${data.bill_date || 'N/A'}</span></div>
                </div>
            </div>
            
            <!-- Amounts -->
            <div class="bg-white border rounded-lg p-4">
                <h4 class="font-semibold text-gray-900 mb-3 flex items-center">
                    <i class="fas fa-rupee-sign mr-2 text-indigo-600"></i>Amounts
                </h4>
                <div class="space-y-2 text-sm">
                    <div class="flex justify-between"><span class="text-gray-600">Subtotal:</span> <span class="font-medium">₹${(data.amounts?.subtotal || 0).toLocaleString()}</span></div>
                    <div class="flex justify-between"><span class="text-gray-600">Tax:</span> <span class="font-medium">₹${(data.amounts?.tax_amount || 0).toLocaleString()}</span></div>
                    <div class="flex justify-between border-t pt-2"><span class="font-semibold">Total:</span> <span class="font-bold text-lg">₹${(data.amounts?.total || 0).toLocaleString()}</span></div>
                </div>
            </div>
            
            <!-- Payment Terms -->
            ${data.payment_terms ? `
            <div class="bg-yellow-50 border border-yellow-200 rounded-lg p-4">
                <h4 class="font-semibold text-gray-900 mb-3 flex items-center">
                    <i class="fas fa-calendar-alt mr-2 text-yellow-600"></i>Payment Terms
                </h4>
                <div class="space-y-2 text-sm">
                    <div><span class="text-gray-600">Type:</span> <span class="font-medium">${data.payment_terms.type}</span></div>
                    ${data.payment_terms.description ? `<div><span class="text-gray-600">Terms:</span> <span class="font-medium">${data.payment_terms.description}</span></div>` : ''}
                    ${data.payment_terms.due_date ? `<div><span class="text-gray-600">Due Date:</span> <span class="font-medium text-red-600">${data.payment_terms.due_date}</span></div>` : ''}
                    ${data.payment_terms.advance_percentage ? `<div><span class="text-gray-600">Advance:</span> <span class="font-medium">${data.payment_terms.advance_percentage}%</span></div>` : ''}
                </div>
            </div>
            ` : ''}
            
            <!-- Line Items -->
            ${data.line_items && data.line_items.length > 0 ? `
            <div class="bg-white border rounded-lg p-4">
                <h4 class="font-semibold text-gray-900 mb-3 flex items-center">
                    <i class="fas fa-list mr-2 text-indigo-600"></i>Line Items
                </h4>
                <div class="overflow-x-auto">
                    <table class="min-w-full text-sm">
                        <thead class="bg-gray-50">
                            <tr>
                                <th class="px-4 py-2 text-left">Description</th>
                                <th class="px-4 py-2 text-right">Qty</th>
                                <th class="px-4 py-2 text-right">Rate</th>
                                <th class="px-4 py-2 text-right">Amount</th>
                            </tr>
                        </thead>
                        <tbody class="divide-y">
                            ${data.line_items.map(item => `
                                <tr>
                                    <td class="px-4 py-2">${item.description}</td>
                                    <td class="px-4 py-2 text-right">${item.quantity || '-'}</td>
                                    <td class="px-4 py-2 text-right">₹${(item.rate || 0).toLocaleString()}</td>
                                    <td class="px-4 py-2 text-right font-medium">₹${(item.amount || 0).toLocaleString()}</td>
                                </tr>
                            `).join('')}
                        </tbody>
                    </table>
                </div>
            </div>
            ` : ''}
        </div>
    `;
    
    actions.innerHTML = `
        <div class="flex justify-end items-center">
            <button onclick="closeAIModal(); loadDocuments();" class="px-6 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700">
                <i class="fas fa-check mr-2"></i>Done - Bill Recorded
            </button>
        </div>
    `;
}

async function viewExtractedData(documentId) {
    try {
        const response = await authFetch(`${API_URL}/documents/${documentId}`);
        const data = await response.json();
        
        if (data.success && data.document.gemini_data) {
            const modal = document.getElementById('ai-modal');
            modal.classList.remove('hidden');
            displayExtractedData(data.document.gemini_data, null);
        }
    } catch (error) {
        console.error('Error viewing data:', error);
    }
}

function closeAIModal() {
    document.getElementById('ai-modal').classList.add('hidden');
}

function escapeQuotes(str) {
    return str.replace(/'/g, "\\'").replace(/"/g, '\\"');
}

function canPreviewFile(mimeType) {
    if (!mimeType) return false;
    return mimeType.includes('pdf') || mimeType.includes('image');
}

function viewDocument(id, fileName, fileType) {
    const modal = document.getElementById('preview-modal');
    const modalTitle = document.getElementById('modal-title');
    const previewContent = document.getElementById('preview-content');
    
    modalTitle.textContent = fileName;
    
    if (fileType.includes('pdf')) {
        previewContent.innerHTML = `<iframe src="${API_URL}/files/${id}" class="w-full h-full min-h-[600px] border-0"></iframe>`;
    } else if (fileType.includes('image')) {
        previewContent.innerHTML = `<div class="flex items-center justify-center"><img src="${API_URL}/files/${id}" alt="${fileName}" class="max-w-full max-h-[70vh] object-contain"></div>`;
    }
    
    modal.classList.remove('hidden');
}

function closePreview() {
    document.getElementById('preview-modal').classList.add('hidden');
}

function downloadDocument(id) {
    window.open(`${API_URL}/files/${id}/download`, '_blank');
}

function getStatusBadge(status) {
    if (status === 'processed') return '<span class="inline-flex items-center px-2 py-1 rounded-full text-xs font-semibold bg-green-100 text-green-700"><i class="fas fa-check-circle mr-1"></i>Processed</span>';
    if (status === 'manual_required') return '<span class="inline-flex items-center px-2 py-1 rounded-full text-xs font-semibold bg-orange-100 text-orange-700"><i class="fas fa-hand-paper mr-1"></i>Manual Required</span>';
    if (status === 'error') return '<span class="inline-flex items-center px-2 py-1 rounded-full text-xs font-semibold bg-red-100 text-red-700"><i class="fas fa-times-circle mr-1"></i>Error</span>';
    if (status === 'processing') return '<span class="inline-flex items-center px-2 py-1 rounded-full text-xs font-semibold bg-indigo-100 text-indigo-700"><i class="fas fa-spinner fa-spin mr-1"></i>Processing</span>';
    return '<span class="inline-flex items-center px-2 py-1 rounded-full text-xs font-semibold bg-gray-100 text-gray-700"><i class="fas fa-clock mr-1"></i>Uploaded</span>';
}

function getProviderInfo(aiData) {
    if (!aiData) return null;
    try {
        const provider = aiData._provider || (aiData._fallback ? 'fallback' : null);
        if (aiData._note) return `AI: ${provider || 'heuristic'} (${aiData._note})`;
        if (provider === 'openai') return 'AI: OpenAI';
        if (provider === 'rule' || provider === 'heuristic') return 'AI: Heuristic';
        if (aiData.manual) return 'Manual';
        return provider ? `AI: ${provider}` : null;
    } catch (_) {
        return null;
    }
}

document.addEventListener('click', (e) => {
    const modal = document.getElementById('preview-modal');
    if (e.target === modal) closePreview();
});

document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        closePreview();
        closeAIModal();
    }
});

function filterDocuments() {
    const dateFrom = document.getElementById('date-from').value;
    const dateTo = document.getElementById('date-to').value;
    const category = document.getElementById('filter-category').value;
    const searchTerm = document.getElementById('search-box').value.toLowerCase();
    const paymentFilter = document.getElementById('filter-payment').value.toLowerCase();
    const statusFilter = document.getElementById('filter-status').value;
    
    let filtered = allDocuments;
    
    if (dateFrom) {
        const fromDate = new Date(dateFrom);
        fromDate.setHours(0, 0, 0, 0);
        filtered = filtered.filter(doc => {
            const docDate = new Date(getDocDate(doc));
            docDate.setHours(0, 0, 0, 0);
            return docDate >= fromDate;
        });
    }
    
    if (dateTo) {
        const toDate = new Date(dateTo);
        toDate.setHours(23, 59, 59, 999);
        filtered = filtered.filter(doc => new Date(getDocDate(doc)) <= toDate);
    }
    
    if (category) {
        filtered = filtered.filter(doc => (getCategory(doc) || '').toLowerCase() === category.toLowerCase());
    }

    if (statusFilter) {
        filtered = filtered.filter(doc => (doc.status || '') === statusFilter);
    }
    if (paymentFilter) {
        filtered = filtered.filter(doc => (getPayment(doc) || '').toLowerCase() === paymentFilter);
    }
    
    if (searchTerm) {
        filtered = filtered.filter(doc => 
            doc.file_name.toLowerCase().includes(searchTerm) ||
            (doc.notes && doc.notes.toLowerCase().includes(searchTerm))
        );
    }
    
    filteredDocuments = filtered;
    displayDocuments(filteredDocuments);
    updateDocCount();
    updateFilterSummary();
}

function setDateFilter(period) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    let fromDate, toDate;
    
    switch(period) {
        case 'today':
            fromDate = toDate = new Date(today);
            break;
        case 'yesterday':
            fromDate = toDate = new Date(today.setDate(today.getDate() - 1));
            break;
        case 'thisWeek':
            fromDate = new Date(today.setDate(today.getDate() - today.getDay()));
            toDate = new Date();
            break;
        case 'thisMonth':
            fromDate = new Date(today.getFullYear(), today.getMonth(), 1);
            toDate = new Date();
            break;
    }
    
    document.getElementById('date-from').value = formatDateInput(fromDate);
    document.getElementById('date-to').value = formatDateInput(toDate);
    filterDocuments();
}

function clearFilters() {
    document.getElementById('date-from').value = '';
    document.getElementById('date-to').value = '';
    document.getElementById('filter-category').value = '';
    document.getElementById('filter-payment').value = '';
    document.getElementById('search-box').value = '';
    filterDocuments();
}

function sortDocuments() {
    const sortBy = document.getElementById('sort-by').value;
    let sorted = [...filteredDocuments];
    
    switch(sortBy) {
        case 'date-desc':
            sorted.sort((a, b) => new Date(getDocDate(b)) - new Date(getDocDate(a)));
            break;
        case 'date-asc':
            sorted.sort((a, b) => new Date(getDocDate(a)) - new Date(getDocDate(b)));
            break;
        case 'name-asc':
            sorted.sort((a, b) => a.file_name.localeCompare(b.file_name));
            break;
        case 'name-desc':
            sorted.sort((a, b) => b.file_name.localeCompare(a.file_name));
            break;
    }
    
    displayDocuments(sorted);
}

function updateDocCount() {
    const total = allDocuments.length;
    const showing = filteredDocuments.length;
    const docCountEl = document.getElementById('doc-count');
    if (docCountEl) {
        docCountEl.textContent = showing < total ? `(${showing} of ${total})` : `(${total})`;
    }
    const heroEl = document.getElementById('doc-count-hero');
    if (heroEl) {
        heroEl.textContent = `${showing}/${total || 0}`;
    }
    const manualCount = allDocuments.filter(doc => doc.status === 'manual_required').length;
    const processedCount = allDocuments.filter(doc => doc.status === 'processed').length;
    const manualEl = document.getElementById('manual-required-count');
    if (manualEl) manualEl.textContent = manualCount;
    const processedEl = document.getElementById('processed-count');
    if (processedEl) processedEl.textContent = processedCount;
}

function updateFilterSummary() {
    const dateFrom = document.getElementById('date-from').value;
    const dateTo = document.getElementById('date-to').value;
    const category = document.getElementById('filter-category').value;
    const searchTerm = document.getElementById('search-box').value;
    const paymentFilter = document.getElementById('filter-payment').value;
    
    const activeFilters = [];
    if (dateFrom && dateTo) activeFilters.push(`${formatDateDisplay(dateFrom)} to ${formatDateDisplay(dateTo)}`);
    else if (dateFrom) activeFilters.push(`From ${formatDateDisplay(dateFrom)}`);
    else if (dateTo) activeFilters.push(`Until ${formatDateDisplay(dateTo)}`);
    if (category) activeFilters.push(`Category: ${category}`);
    if (paymentFilter) activeFilters.push(`Payment: ${paymentFilter}`);
    if (searchTerm) activeFilters.push(`Search: "${searchTerm}"`);
    
    const filterContainer = document.getElementById('active-filters');
    const filterSummary = document.getElementById('filter-summary');
    
    if (activeFilters.length > 0) {
        filterSummary.textContent = `Active filters: ${activeFilters.join(' • ')}`;
        filterContainer.classList.remove('hidden');
    } else {
        filterContainer.classList.add('hidden');
    }

    renderTable(filteredDocuments);
    renderDetail(filteredDocuments[0]);
}

async function deleteDocument(id) {
    if (!confirm('Are you sure you want to delete this document?')) return;
    
    try {
        const response = await authFetch(`${API_URL}/documents/${id}`, { method: 'DELETE' });
        const data = await response.json();
        
        if (data.success) {
            await loadDocuments(); // refresh table + calendar fully
        }
    } catch (error) {
        console.error('Error:', error);
    }
}

async function deleteBill(billId) {
    if (!confirm('Delete this bill and reset the document for reprocess?')) return;
    try {
        const resp = await authFetch(`${API_URL}/bills/${billId}`, { method: 'DELETE' });
        const data = await resp.json();
        if (data.success) {
            alert('Bill deleted. Document reset to uploaded.');
            loadDocuments();
        } else {
            alert(data.error || 'Failed to delete bill');
        }
    } catch (err) {
        console.error('Delete bill error:', err);
        alert('Failed to delete bill');
    }
}

// Keyboard navigation for table (up/down + Enter)
document.addEventListener('keydown', (e) => {
    const rows = Array.from(document.querySelectorAll('#documents-table-body tr'));
    if (!rows.length) return;
    let idx = rows.findIndex(r => r.classList.contains('ring-2'));
    if (e.key === 'ArrowDown') {
        e.preventDefault();
        idx = Math.min(idx + 1, rows.length - 1);
        highlightRow(rows, idx);
    } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        idx = Math.max(idx - 1, 0);
        highlightRow(rows, idx);
    } else if (e.key === 'Enter' && idx >= 0) {
        const id = rows[idx].dataset.id;
        if (id) selectDocument(Number(id));
    }
});

function highlightRow(rows, idx) {
    rows.forEach(r => r.classList.remove('ring-2', 'ring-indigo-300'));
    const row = rows[idx];
    if (row) {
        row.classList.add('ring-2', 'ring-indigo-300');
        const id = row.dataset.id;
        if (id) selectDocument(Number(id));
        row.scrollIntoView({ block: 'nearest' });
    }
}

function getFileIconInfo(mimeType, fileName) {
    if (!mimeType) mimeType = '';
    if (!fileName) fileName = '';
    
    if (mimeType.includes('pdf')) return { icon: 'fa-file-pdf', color: 'text-red-500', label: 'PDF' };
    if (mimeType.includes('image')) return { icon: 'fa-file-image', color: 'text-blue-500', label: 'Image' };
    if (mimeType.includes('spreadsheet') || mimeType.includes('excel') || fileName.endsWith('.xlsx') || fileName.endsWith('.xls')) {
        return { icon: 'fa-file-excel', color: 'text-green-600', label: 'Excel' };
    }
    if (mimeType.includes('wordprocessing') || mimeType.includes('msword') || fileName.endsWith('.docx') || fileName.endsWith('.doc')) {
        return { icon: 'fa-file-word', color: 'text-blue-600', label: 'Word' };
    }
    return { icon: 'fa-file-alt', color: 'text-gray-500', label: 'Document' };
}

function formatDate(dateString) {
    return new Date(dateString).toLocaleDateString('en-US', {
        year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
    });
}

function formatDateInput(date) {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function formatDateDisplay(dateString) {
    return new Date(dateString).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

function formatBytes(bytes) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i];
}

// Calendar view helpers
function changeCalendarMonth(delta) {
    calendarCursor.setMonth(calendarCursor.getMonth() + delta);
    renderCalendar();
}

function renderCalendar() {
    const monthName = calendarCursor.toLocaleString('default', { month: 'long', year: 'numeric' });
    document.getElementById('calendar-month').textContent = monthName;
    const billBtn = document.getElementById('mode-billdate');
    const uploadBtn = document.getElementById('mode-uploaddate');
    if (billBtn && uploadBtn) {
        if (useBillDateMode) {
            billBtn.className = 'px-2 py-1 bg-indigo-600 text-white';
            uploadBtn.className = 'px-2 py-1 bg-white text-slate-700';
        } else {
            billBtn.className = 'px-2 py-1 bg-white text-slate-700';
            uploadBtn.className = 'px-2 py-1 bg-indigo-600 text-white';
        }
    }
    const grid = document.getElementById('calendar-grid');
    grid.innerHTML = '';

    const year = calendarCursor.getFullYear();
    const month = calendarCursor.getMonth();
    const firstDay = new Date(year, month, 1);
    const startDay = firstDay.getDay(); // 0-6
    const daysInMonth = new Date(year, month + 1, 0).getDate();

    // Map dates to document counts
    const docCountByDate = {};
    allDocuments.forEach(doc => {
        const d = new Date(getDocDate(doc));
        const key = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
        docCountByDate[key] = (docCountByDate[key] || 0) + 1;
    });

    // Fill blanks before first day
    for (let i = 0; i < startDay; i++) {
        grid.innerHTML += `<div class="py-3"></div>`;
    }

    const today = new Date();
    for (let day = 1; day <= daysInMonth; day++) {
        const key = `${year}-${month}-${day}`;
        const count = docCountByDate[key] || 0;
        const dateStr = formatDateInput(new Date(year, month, day));
        const isToday = today.getFullYear() === year && today.getMonth() === month && today.getDate() === day;

        grid.innerHTML += `
            <button 
                class="py-3 rounded-md border text-sm hover:border-indigo-400 hover:bg-indigo-50 transition ${count ? 'bg-indigo-50 border-indigo-200' : 'border-gray-200'} ${isToday ? 'ring-2 ring-green-300' : ''}"
                onclick="filterByDate('${dateStr}')">
                <div class="font-semibold text-gray-800">${day}</div>
                <div class="text-xs text-gray-500">${count ? `${count} bill${count>1?'s':''}` : ''}</div>
            </button>
        `;
    }
}

function filterByDate(dateStr) {
    document.getElementById('date-from').value = dateStr;
    document.getElementById('date-to').value = dateStr;
    filterDocuments();
}

function setDateMode(mode) {
    useBillDateMode = (mode === 'bill');
    renderCalendar();
    filterDocuments();
}

// Manual Processing Helpers
async function openManualModal(documentId) {
    let doc = allDocuments.find(d => d.document_id === documentId) || null;
    let billLineItems = null;

    try {
        const response = await authFetch(`${API_URL}/documents/${documentId}`);
        if (response.ok) {
            const data = await response.json();
            if (data.success && data.document) {
                const detail = data.document;
                doc = doc ? { ...doc, ...detail } : detail;
                billLineItems = Array.isArray(detail.line_items) ? detail.line_items : null;
                if (detail.gemini_data && !doc.gemini_data) {
                    doc.gemini_data = detail.gemini_data;
                }
            }
        }
    } catch (err) {
        console.error('Failed to load document detail', err);
    }

    if (!doc) return;
    populateManualForm(doc, billLineItems);
}

function populateManualForm(doc, billLineItems) {
    currentManualDoc = doc;
    const gemData = doc.gemini_data || {};
    const amounts = gemData.amounts || {};

    if (Array.isArray(billLineItems) && billLineItems.length) {
        manualLineItems = billLineItems.map(item => ({
            description: item.description || '',
            sku_code: item.sku_code || '',
            quantity: Number(item.quantity || 0),
            rate: item.unit_price != null ? Number(item.unit_price) : Number(item.rate || 0),
            amount: Number(item.amount || 0)
        }));
    } else if (gemData.line_items && Array.isArray(gemData.line_items)) {
        manualLineItems = gemData.line_items.map((item) => ({
            description: item.description || '',
            sku_code: item.sku_code || '',
            quantity: Number(item.quantity || 0),
            rate: Number(item.rate || 0),
            amount: Number(item.amount || 0)
        }));
    } else {
        manualLineItems = [{
            description: doc.file_name || gemData.bill_number || 'Line item',
            sku_code: '',
            quantity: 1,
            rate: parseFloat(doc.bill_total_amount ?? doc.total_amount ?? amounts.total ?? 0) || 0,
            amount: parseFloat(doc.bill_total_amount ?? doc.total_amount ?? amounts.total ?? 0) || 0
        }];
    }

    const vendorName = doc.bill_vendor_name || doc.vendor_name || gemData.vendor_name || '';
    document.getElementById('manual-vendor-name').value = vendorName;

    document.getElementById('manual-bill-number').value = doc.bill_number || gemData.bill_number || '';
    const rawBillDate = doc.bill_date || gemData.bill_date || '';
    document.getElementById('manual-bill-date').value = rawBillDate ? rawBillDate.split('T')[0] : '';

    const manualCat = doc.bill_category || getCategory(doc);
    document.getElementById('manual-category').value = (manualCat && manualCat !== '—') ? manualCat : 'misc';

    const subtotalGuess = (doc.bill_subtotal ?? doc.subtotal ?? amounts.subtotal) || '';
    document.getElementById('manual-subtotal').value = subtotalGuess;

    const taxGuess = (doc.bill_tax_amount ?? doc.tax_amount ?? amounts.tax_amount ??
        ((amounts.cgst || 0) + (amounts.sgst || 0) + (amounts.igst || 0))) || '';
    document.getElementById('manual-tax').value = taxGuess;

    const totalGuess = (doc.bill_total_amount ?? doc.total_amount ?? amounts.total) || '';
    document.getElementById('manual-total').value = totalGuess;

    const payMethod = doc.bill_payment_method || getPayment(doc);
    document.getElementById('manual-payment-method').value = (payMethod && payMethod !== '—') ? payMethod : '';

    const mergedTerms = doc.payment_terms
        || gemData.payment_terms
        || ((doc.bill_payment_type || doc.bill_advance_percentage || doc.bill_payment_due_date) ? {
            type: doc.bill_payment_type,
            advance_percentage: doc.bill_advance_percentage,
            due_date: doc.bill_payment_due_date
        } : null)
        || {};
    doc.payment_terms = mergedTerms;

    document.getElementById('manual-pay-type').value = mergedTerms.type || 'FULL';
    document.getElementById('manual-advance').value = mergedTerms.advance_percentage ?? '';
    const due = mergedTerms.due_date ? mergedTerms.due_date.split('T')[0] : '';
    document.getElementById('manual-due-date').value = due;
document.getElementById('manual-notes').value = doc.notes || '';
document.getElementById('manual-department').value = doc.department || '';
document.getElementById('manual-error').textContent = '';
syncManualPaymentFields();
updateManualAdvanceSummary();
renderLineItems();
document.getElementById('manual-modal').classList.remove('hidden');
}

function syncManualPaymentFields() {
    const payTypeEl = document.getElementById('manual-pay-type');
    const advanceInput = document.getElementById('manual-advance');
    const dueInput = document.getElementById('manual-due-date');
    if (!payTypeEl || !advanceInput) return;
    const wrapper = advanceInput.parentElement;
    if (payTypeEl.value === 'ADVANCE') {
        advanceInput.disabled = false;
        if (wrapper) wrapper.classList.remove('opacity-50');
        if (dueInput) dueInput.required = true;
    } else {
        advanceInput.disabled = true;
        advanceInput.value = '';
        if (wrapper) wrapper.classList.add('opacity-50');
        if (dueInput) {
            dueInput.required = false;
            dueInput.value = '';
        }
    }
    updateManualAdvanceSummary();
}

function updateManualAdvanceSummary() {
    const note = document.getElementById('manual-balance-note');
    if (!note) return;
    const payType = document.getElementById('manual-pay-type')?.value || 'FULL';
    const total = parseFloat(document.getElementById('manual-total')?.value || 0);
    const advancePct = parseFloat(document.getElementById('manual-advance')?.value || 0);
    const dueDateRaw = document.getElementById('manual-due-date')?.value || '';

    if (payType !== 'ADVANCE' || !total) {
        note.textContent = '';
        return;
    }
    const advanceAmount = advancePct ? (total * advancePct) / 100 : 0;
    const balance = Math.max(total - advanceAmount, 0);
    const dateLabel = dueDateRaw ? `due on ${formatDateDisplay(dueDateRaw)}` : 'set a due date';
    note.textContent = `Balance ₹${balance.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${dateLabel}`;
}

function closeManualModal() {
    document.getElementById('manual-modal').classList.add('hidden');
    currentManualDoc = null;
    manualLineItems = [];
}

function renderLineItems() {
    const tbody = document.getElementById('manual-line-items');
    tbody.innerHTML = manualLineItems.map((item, idx) => `
        <tr>
            <td class="px-3 py-2">
                <input value="${item.description || ''}" class="w-full px-2 py-1 border rounded" onchange="updateLineItem(${idx}, 'description', this.value)">
            </td>
            <td class="px-3 py-2">
                <input value="${item.sku_code || ''}" class="w-full px-2 py-1 border rounded" placeholder="SKU" onchange="updateLineItem(${idx}, 'sku_code', this.value)">
            </td>
            <td class="px-3 py-2 text-right">
                <input type="number" step="0.01" min="0" value="${item.quantity || 0}" class="w-24 px-2 py-1 border rounded text-right" onchange="updateLineItem(${idx}, 'quantity', this.value)">
            </td>
            <td class="px-3 py-2 text-right">
                <input type="number" step="0.01" min="0" value="${item.rate || 0}" class="w-28 px-2 py-1 border rounded text-right" onchange="updateLineItem(${idx}, 'rate', this.value)">
            </td>
            <td class="px-3 py-2 text-right">
                <input type="number" step="0.01" min="0" value="${item.amount || 0}" class="w-28 px-2 py-1 border rounded text-right" onchange="updateLineItem(${idx}, 'amount', this.value)">
            </td>
            <td class="px-3 py-2 text-right">
                <button type="button" onclick="removeLineItemRow(${idx})" class="px-2 py-1 text-red-600 hover:text-red-800">
                    <i class="fas fa-trash"></i>
                </button>
            </td>
        </tr>
    `).join('');
}

function addLineItemRow() {
    manualLineItems.push({ description: '', sku_code: '', quantity: 1, rate: 0, amount: 0 });
    renderLineItems();
}

function removeLineItemRow(idx) {
    manualLineItems.splice(idx, 1);
    if (manualLineItems.length === 0) manualLineItems.push({ description: '', sku_code: '', quantity: 1, rate: 0, amount: 0 });
    renderLineItems();
}

function updateLineItem(idx, field, value) {
    if (!manualLineItems[idx]) return;
    if (['quantity', 'rate', 'amount'].includes(field)) {
        manualLineItems[idx][field] = parseFloat(value || 0);
    } else {
        manualLineItems[idx][field] = value;
    }
}

async function submitManual(event) {
    event.preventDefault();
    if (!currentManualDoc) return;
    const errorEl = document.getElementById('manual-error');
    errorEl.textContent = '';

    const payload = {
        vendor_name: document.getElementById('manual-vendor-name').value.trim(),
        bill_number: document.getElementById('manual-bill-number').value.trim(),
        bill_date: document.getElementById('manual-bill-date').value || null,
        category: document.getElementById('manual-category').value || 'misc',
        department: document.getElementById('manual-department').value || null,
        subtotal: parseFloat(document.getElementById('manual-subtotal').value || 0),
        tax_amount: parseFloat(document.getElementById('manual-tax').value || 0),
        total_amount: parseFloat(document.getElementById('manual-total').value || 0),
        payment_method: document.getElementById('manual-payment-method').value || '',
        payment_terms: {
          type: document.getElementById('manual-pay-type').value,
          description: '',
          advance_percentage: document.getElementById('manual-advance').value ? parseFloat(document.getElementById('manual-advance').value) : null,
          due_date: document.getElementById('manual-due-date').value || null,
          installments: []
        },
        line_items: manualLineItems,
        notes: document.getElementById('manual-notes').value
    };

    if (!payload.vendor_name) {
        errorEl.textContent = 'Vendor name is required.';
        return;
    }
    if (!payload.total_amount || payload.total_amount <= 0) {
        errorEl.textContent = 'Total amount must be greater than zero.';
        return;
    }
    if (!payload.category) {
        errorEl.textContent = 'Category is required.';
        return;
    }
    if (!payload.payment_method) {
        errorEl.textContent = 'Payment method is required.';
        return;
    }
    if (payload.payment_terms.type === 'ADVANCE') {
        if (!payload.payment_terms.advance_percentage || payload.payment_terms.advance_percentage <= 0) {
            errorEl.textContent = 'Advance percentage is required for advance payment terms.';
            return;
        }
        if (!payload.payment_terms.due_date) {
            errorEl.textContent = 'Advance payment terms need a due date for the balance.';
            return;
        }
    } else {
        payload.payment_terms.advance_percentage = null;
        if (!payload.payment_terms.due_date) {
            payload.payment_terms.due_date = null;
        }
    }

    try {
        const response = await authFetch(`${API_URL}/bills/${currentManualDoc.document_id}/manual`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        const data = await response.json();
        if (data.success) {
            alert('Bill processed manually and posted.');
            closeManualModal();
            loadDocuments();
        } else {
            errorEl.textContent = data.error || 'Manual processing failed';
        }
    } catch (err) {
        errorEl.textContent = err.message;
        console.error('Manual submit error:', err);
    }
}

document.addEventListener('DOMContentLoaded', () => {
    if (window.sessionReady) {
        window.sessionReady.then(() => loadDocuments()).catch(() => {});
    } else {
        loadDocuments();
    }
    const payTypeEl = document.getElementById('manual-pay-type');
    if (payTypeEl) {
        payTypeEl.addEventListener('change', syncManualPaymentFields);
    }
    ['manual-advance', 'manual-total', 'manual-due-date'].forEach(id => {
        const el = document.getElementById(id);
        if (el) {
            el.addEventListener('input', updateManualAdvanceSummary);
            el.addEventListener('change', updateManualAdvanceSummary);
        }
    });
});


function closeBillModal() {
    const modal = document.getElementById('bill-modal');
    if (modal) modal.classList.add('hidden');
}
function actionPreview(docId, fileName, fileType) { closeBillModal(); viewDocument(docId, fileName, fileType); }
function actionProcessAI(docId) { closeBillModal(); processWithAI(docId); }
function actionViewData(docId) { closeBillModal(); viewExtractedData(docId); }
function actionManual(docId) { closeBillModal(); openManualModal(docId); }
function actionRetry(docId) { closeBillModal(); retryAI(docId); }
function actionDelete(documentId, billId) {
    closeBillModal();
    if (billId) {
        deleteBill(billId);
    } else {
        deleteDocument(documentId);
    }
}
function actionDownload(docId) { closeBillModal(); downloadDocument(docId); }
