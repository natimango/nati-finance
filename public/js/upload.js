const API_URL = '/api';
let selectedFile = null;

function authFetch(url, options = {}) {
    const opts = Object.assign({ credentials: 'include' }, options);
    return fetch(url, opts);
}

// File input change handler
document.getElementById('file-input').addEventListener('change', handleFileSelect);

// Drag and drop handlers
const dropZone = document.getElementById('drop-zone');

dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropZone.classList.add('border-indigo-500', 'bg-indigo-50');
});

dropZone.addEventListener('dragleave', (e) => {
    e.preventDefault();
    dropZone.classList.remove('border-indigo-500', 'bg-indigo-50');
});

dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone.classList.remove('border-indigo-500', 'bg-indigo-50');
    
    const files = e.dataTransfer.files;
    if (files.length > 0) {
        handleFile(files[0]);
    }
});

// Allow click-to-open only when the container itself is clicked to avoid double-open with label
dropZone.addEventListener('click', (e) => {
    if (e.target === dropZone) {
        document.getElementById('file-input').click();
    }
});

function handleFileSelect(e) {
    const file = e.target.files[0];
    if (file) {
        handleFile(file);
    }
}

function handleFile(file) {
    // Validate file
    const maxSize = 25 * 1024 * 1024; // 25MB
    const allowedTypes = [
        'application/pdf',
        'image/jpeg',
        'image/jpg',
        'image/png',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', // .xlsx
        'application/vnd.ms-excel', // .xls
        'application/msword', // .doc
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document' // .docx
    ];
    
    if (file.size > maxSize) {
        showMessage('File too large. Maximum size is 25MB.', 'error');
        return;
    }
    
    if (!allowedTypes.includes(file.type)) {
        showMessage('Invalid file type. Only PDF, JPG, PNG, Excel (XLS/XLSX), and Word (DOC/DOCX) are allowed.', 'error');
        return;
    }
    
    selectedFile = file;
    displayFileInfo(file);
    document.getElementById('upload-btn').disabled = false;
}

function displayFileInfo(file) {
    const fileInfo = document.getElementById('file-info');
    const fileIcon = document.getElementById('file-icon');
    const fileName = document.getElementById('file-name');
    const fileSize = document.getElementById('file-size');
    const fileType = document.getElementById('file-type');
    
    // Set icon and color based on file type
    const iconInfo = getFileIconInfo(file.type, file.name);
    fileIcon.className = `fas ${iconInfo.icon} ${iconInfo.color} text-3xl mr-4`;
    
    fileName.textContent = file.name;
    fileSize.textContent = formatBytes(file.size);
    fileType.textContent = iconInfo.label;
    
    fileInfo.classList.remove('hidden');
}

function getFileIconInfo(mimeType, fileName) {
    // PDF
    if (mimeType.includes('pdf')) {
        return { icon: 'fa-file-pdf', color: 'text-red-500', label: 'PDF' };
    }
    
    // Images
    if (mimeType.includes('image')) {
        return { icon: 'fa-file-image', color: 'text-blue-500', label: 'Image' };
    }
    
    // Excel
    if (mimeType.includes('spreadsheet') || mimeType.includes('excel') || 
        fileName.endsWith('.xlsx') || fileName.endsWith('.xls')) {
        return { icon: 'fa-file-excel', color: 'text-green-600', label: 'Excel' };
    }
    
    // Word
    if (mimeType.includes('wordprocessing') || mimeType.includes('msword') || 
        fileName.endsWith('.docx') || fileName.endsWith('.doc')) {
        return { icon: 'fa-file-word', color: 'text-blue-600', label: 'Word' };
    }
    
    return { icon: 'fa-file-alt', color: 'text-gray-500', label: 'Document' };
}

function clearFile() {
    selectedFile = null;
    document.getElementById('file-input').value = '';
    document.getElementById('file-info').classList.add('hidden');
    document.getElementById('upload-btn').disabled = true;
    document.getElementById('message-container').classList.add('hidden');
}

async function uploadFile() {
    if (!selectedFile) {
        showMessage('Please select a file', 'error');
        return;
    }
    
    const category = document.getElementById('category').value;
    const dropName = document.getElementById('drop_name') ? document.getElementById('drop_name').value : '';
    if (!category) {
        showMessage('Please select a category', 'error');
        return;
    }
    if (!dropName) {
        showMessage('Please select a drop/collection', 'error');
        return;
    }
    
    const notes = document.getElementById('notes').value;
    const paymentMethod = document.getElementById('payment_method') ? document.getElementById('payment_method').value : 'UNSPECIFIED';
    if (!paymentMethod || paymentMethod === 'UNSPECIFIED') {
        showMessage('Please select a payment method', 'error');
        return;
    }
    
    // Prepare form data
    const formData = new FormData();
    formData.append('bill', selectedFile);
    formData.append('category', category);
    formData.append('drop_name', dropName);
    formData.append('notes', notes);
    formData.append('payment_method', paymentMethod);
    
    // Show progress
    document.getElementById('upload-btn').disabled = true;
    document.getElementById('upload-btn').innerHTML = '<i class="fas fa-spinner fa-spin mr-2"></i>Uploading...';
    document.getElementById('progress-container').classList.remove('hidden');
    
    // Simulate progress (since we can't track real progress easily)
    let progress = 0;
    const progressInterval = setInterval(() => {
        progress += 10;
        if (progress <= 90) {
            document.getElementById('progress-bar').style.width = progress + '%';
            document.getElementById('progress-text').textContent = progress + '%';
        }
    }, 200);
    
    try {
        const response = await authFetch(`${API_URL}/upload`, {
            method: 'POST',
            body: formData
        });
        
        clearInterval(progressInterval);
        document.getElementById('progress-bar').style.width = '100%';
        document.getElementById('progress-text').textContent = '100%';
        
        const data = await response.json();
        
        if (data.success) {
            showMessage(`✅ ${selectedFile.name} uploaded successfully!`, 'success');
            setTimeout(() => {
                window.location.href = 'documents.html';
            }, 1500);
        } else {
            showMessage('Upload failed: ' + data.error, 'error');
            document.getElementById('upload-btn').disabled = false;
            document.getElementById('upload-btn').innerHTML = '<i class="fas fa-upload mr-2"></i>Upload Bill';
        }
    } catch (error) {
        clearInterval(progressInterval);
        console.error('Upload error:', error);
        showMessage('Upload failed. Please try again.', 'error');
        document.getElementById('upload-btn').disabled = false;
        document.getElementById('upload-btn').innerHTML = '<i class="fas fa-upload mr-2"></i>Upload Bill';
    }
}

function showMessage(message, type) {
    const container = document.getElementById('message-container');
    const bgColor = type === 'success' ? 'bg-green-50 border-green-200 text-green-800' : 'bg-red-50 border-red-200 text-red-800';
    const icon = type === 'success' ? 'check-circle' : 'exclamation-circle';
    
    container.innerHTML = `
        <div class="border ${bgColor} rounded-lg p-4">
            <div class="flex items-center">
                <i class="fas fa-${icon} mr-3"></i>
                <span>${message}</span>
            </div>
        </div>
    `;
    container.classList.remove('hidden');
    
    if (type === 'error') {
        document.getElementById('progress-container').classList.add('hidden');
    }
}

function formatBytes(bytes) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i];
}
