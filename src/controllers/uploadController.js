const pool = require('../config/database');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { preprocessFile } = require('../services/preprocessService');
const mime = require('mime-types');
const sharp = require('sharp');
const { extractWithRules } = require('../services/ruleExtractor');
const { parseInvoiceText } = require('../services/aiParser');
const { normalizeCategory } = require('../utils/categoryMap');
const { safeParseJSON } = require('../utils/json');
const { storeRawText, getRawTextFromDoc } = require('../utils/ocrCache');
const { logDocumentFieldChange } = require('../utils/documentAudit');
const { evidenceMatchesRawText } = require('../utils/textNormalize');
const { getDefaultDropId } = require('../utils/metaCache');

const uploadDir = path.join(__dirname, '../../uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const DEFAULT_JOURNAL_USER_ID = parseInt(process.env.SYSTEM_USER_ID || '1', 10);
const REQUIRED_OCR_VERSION = parseInt(process.env.OCR_VERSION || '1', 10);
const MIN_OCR_TEXT_LENGTH = Math.max(parseInt(process.env.OCR_TEXT_MIN_LEN || '200', 10), 32);
const VERIFY_CONF_THRESHOLD = Math.min(Math.max(parseFloat(process.env.VERIFY_CONF_THRESHOLD || '0.85'), 0.5), 0.99);
const MAX_REPROCESS_PER_DOC_PER_DAY = Math.max(parseInt(process.env.MAX_REPROCESS_PER_DOC_PER_DAY || '3', 10), 1);

function resolveJournalUser(preferred) {
  return preferred || DEFAULT_JOURNAL_USER_ID;
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname));
  }
});

const fileFilter = (req, file, cb) => {
  const allowedTypes = /jpeg|jpg|png|pdf|xlsx|xls|doc|docx/;
  const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());

  const allowedMimeTypes = [
    'image/jpeg', 'image/jpg', 'image/png', 'application/pdf',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.ms-excel', 'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  ];

  const guessedMime = mime.lookup(file.originalname) || '';
  const incomingMime = file.mimetype || '';
  const normalizedMime = incomingMime === 'application/octet-stream'
    ? (guessedMime || incomingMime)
    : incomingMime || guessedMime;

  const mimetypeAllowed = allowedMimeTypes.includes(normalizedMime);
  const allowOctet = incomingMime === 'application/octet-stream';
  const allowUnknown = !incomingMime && guessedMime && allowedMimeTypes.includes(guessedMime);

  if (extname && (mimetypeAllowed || allowOctet || allowUnknown)) {
    return cb(null, true);
  }
  cb(new Error('Only PDF, JPG, PNG, Excel, and Word files allowed!'));
};

const upload = multer({
  storage: storage,
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: fileFilter
});

async function optimizeImage(file) {
  if (!file || !file.mimetype || !file.mimetype.startsWith('image/')) {
    return;
  }
  const ext = path.extname(file.path).toLowerCase();
  const maxDim = Number(process.env.UPLOAD_IMAGE_MAX_DIM || 2000);
  const jpegQuality = Number(process.env.UPLOAD_IMAGE_JPEG_QUALITY || 80);
  const tempPath = `${file.path}.tmp`;
  try {
    const transformer = sharp(file.path)
      .rotate()
      .resize({
        width: maxDim,
        height: maxDim,
        fit: 'inside',
        withoutEnlargement: true
      });

    if (ext === '.jpg' || ext === '.jpeg') {
      await transformer.jpeg({ quality: jpegQuality, mozjpeg: true }).toFile(tempPath);
    } else if (ext === '.png') {
      await transformer.png({ compressionLevel: 9, adaptiveFiltering: true, palette: true }).toFile(tempPath);
    } else {
      await transformer.toFile(tempPath);
    }

    await fs.promises.rename(tempPath, file.path);
    const stat = await fs.promises.stat(file.path);
    file.size = stat.size;
  } catch (err) {
    console.error('Image optimization failed:', err.message);
    if (fs.existsSync(tempPath)) {
      fs.promises.unlink(tempPath).catch(() => {});
    }
  }
}

function computeFileHash(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

// Upload and AUTO-PROCESS with AI
const uploadBill = async (req, res) => {
  try {
    const { category, notes, payment_method, drop_name } = req.body;
    const file = req.file;
    const paymentMethod = (payment_method || '').toUpperCase();
    const dropName = drop_name || null;
    const uploaderId = req.user?.userId || null;
    console.log('Upload body:', req.body, 'resolved payment:', paymentMethod, 'user:', uploaderId);
    
    if (!file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }
    if (!category) {
      return res.status(400).json({ error: 'category is required' });
    }
    if (!dropName) {
      return res.status(400).json({ error: 'drop_name is required' });
    }
    if (!paymentMethod || paymentMethod === 'UNSPECIFIED') {
      return res.status(400).json({ error: 'payment_method is required' });
    }

    if (file && (!file.mimetype || file.mimetype === 'application/octet-stream')) {
      const guessed = mime.lookup(file.originalname);
      if (guessed) {
        file.mimetype = guessed;
      } else {
        const lower = file.originalname.toLowerCase();
        if (lower.endsWith('.pdf')) file.mimetype = 'application/pdf';
        else if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) file.mimetype = 'image/jpeg';
        else if (lower.endsWith('.png')) file.mimetype = 'image/png';
        else if (lower.endsWith('.xlsx')) file.mimetype = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
        else if (lower.endsWith('.xls')) file.mimetype = 'application/vnd.ms-excel';
        else if (lower.endsWith('.docx')) file.mimetype = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
        else if (lower.endsWith('.doc')) file.mimetype = 'application/msword';
      }
    }
    
    await optimizeImage(file);
    const fileHash = await computeFileHash(file.path);

    // 1. Save to documents table
    const docResult = await pool.query(
      `INSERT INTO documents 
       (file_name, file_path, file_size, file_type, document_category, payment_method, notes, uploaded_by, status) 
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) 
       RETURNING *`,
      [file.originalname, file.path, file.size, file.mimetype, category || 'uncategorized', paymentMethod, notes || null, uploaderId, 'processing']
    );
    
    const document = {
      ...docResult.rows[0],
      document_category: category || docResult.rows[0].document_category || 'uncategorized',
      payment_method: paymentMethod,
      drop_name: dropName
    };
    await pool.query('UPDATE documents SET file_hash = $1 WHERE document_id = $2', [fileHash, document.document_id]);

    // 2. Preprocess (OCR/text extraction) and store raw text
    let rawText = '';
    try {
      const pre = await preprocessFile(file.path, file.mimetype);
      rawText = pre.raw_text || '';
      await pool.query('UPDATE documents SET notes = COALESCE(notes, $1) WHERE document_id = $2', [
        `Preprocessed (${pre.meta?.type || 'unknown'})`, document.document_id
      ]);
      await storeRawText(document.document_id, rawText, pre.meta || {}, { fileHash });
    } catch (err) {
      console.error('Preprocess error:', err.message);
      if (file.mimetype === 'application/octet-stream' && path.extname(file.path).toLowerCase() === '.pdf') {
        try {
          const pre = await preprocessFile(file.path, 'application/pdf');
          rawText = pre.raw_text || '';
          await storeRawText(document.document_id, rawText, pre.meta || {}, { fileHash });
        } catch (pdfErr) {
          console.error('Fallback PDF preprocess failed:', pdfErr.message);
        }
      }
    }

    // 3. AUTO-PROCESS with AI abstraction (background)
    processDocumentWithAI(document, rawText, paymentMethod)
      .then(result => {
        if (result && result.success === false) {
          console.warn('Background AI skipped:', result.reason || result.error);
        }
      })
      .catch(err => console.error('Background AI processing failed:', err));
    
    res.json({
      success: true,
      message: 'Bill uploaded and AI processing started',
      document: {
        id: document.document_id,
        fileName: document.file_name,
        status: 'AI processing in progress...'
      }
    });
  } catch (error) {
    console.error('Upload error:', error);
    res.status(500).json({ error: error.message });
  }
};

function hasActionablePaymentTerms(terms) {
  if (!terms) return false;
  const type = (terms.type || '').toUpperCase();
  const hasInstallments = Array.isArray(terms.installments) && terms.installments.length > 0;
  const hasAdvance = typeof terms.advance_percentage === 'number' && terms.advance_percentage > 0;
  const hasDueDate = Boolean(terms.due_date);
  const hasNet = Boolean(terms.net_days) || type.startsWith('NET_');
  if (hasInstallments) return true;
  if (type === 'ADVANCE') {
    return hasAdvance && hasDueDate;
  }
  return hasDueDate || hasNet;
}

function normalizeISODate(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return String(value);
  return parsed.toISOString().slice(0, 10);
}

function isSameUtcDay(a, b) {
  if (!a || !b) return false;
  return a.getUTCFullYear() === b.getUTCFullYear()
    && a.getUTCMonth() === b.getUTCMonth()
    && a.getUTCDate() === b.getUTCDate();
}

function canAttemptReprocess(doc) {
  if (!doc) return true;
  const lastAttempt = doc.ai_last_attempt_at ? new Date(doc.ai_last_attempt_at) : null;
  if (!lastAttempt) return true;
  if (!isSameUtcDay(lastAttempt, new Date())) return true;
  return (doc.ai_attempt_count || 0) < MAX_REPROCESS_PER_DOC_PER_DAY;
}

async function recordAiAttempt(documentId, error) {
  const errorText = error ? (error.message || error || '').toString().slice(0, 400) : null;
  await pool.query(
    `UPDATE documents
        SET ai_attempt_count = COALESCE(ai_attempt_count, 0) + 1,
            ai_last_attempt_at = NOW(),
            ai_last_error = $1
      WHERE document_id = $2`,
    [errorText, documentId]
  );
}

async function updateDocumentMetadata(documentId, { mimeType, fileSize, pageCount }) {
  if (!documentId) return;
  await pool.query(
    `
    UPDATE documents
    SET mime_type = COALESCE($1, mime_type),
        file_size_bytes = COALESCE($2, file_size_bytes),
        page_count = COALESCE($3, page_count)
    WHERE document_id = $4
    `,
    [mimeType || null, fileSize || null, pageCount || null, documentId]
  );
}

function shouldPromoteToVerified({ hasBillDate, hasTotal, lockedDate, lockedTotal }) {
  return hasBillDate && hasTotal && lockedDate && lockedTotal;
}

function determineVerificationSource(actorType) {
  if (!actorType) return 'system';
  if (actorType === 'user') return 'manual';
  if (actorType === 'manager' || actorType === 'admin') return 'manual';
  return actorType;
}

function normalizeHeuristicCandidates(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map((entry) => {
    if (!entry || typeof entry !== 'object') {
      return { value: entry, evidence: null };
    }
    return entry;
  });
}

function buildExtractionState({ provider, heuristics, aiSummary, appliedEvidence }) {
  const heuristicBlock = heuristics ? {
    vendor_candidates: heuristics.vendor_candidates || [],
    bill_date_candidates: normalizeHeuristicCandidates(
      heuristics.bill_date_candidates || heuristics.date_candidates || []
    ),
    total_candidates: normalizeHeuristicCandidates(heuristics.total_candidates || []),
    receipt_hint: heuristics.receipt_hint || null,
    flags: heuristics.flags || null
  } : null;

  const aiBlock = aiSummary ? {
    vendor_name: aiSummary.vendor_name || null,
    bill_number: aiSummary.bill_number || null,
    bill_date: aiSummary.bill_date || null,
    total_amount: aiSummary.total_amount || null,
    subtotal: aiSummary.subtotal != null ? aiSummary.subtotal : null,
    tax_amount: aiSummary.tax_amount != null ? aiSummary.tax_amount : null,
    quality_score: aiSummary.quality_score != null ? aiSummary.quality_score : null,
    reason: aiSummary.reason || null,
    confidence: (aiSummary.total_amount && aiSummary.total_amount.confidence != null)
      ? aiSummary.total_amount.confidence
      : (aiSummary.bill_date && aiSummary.bill_date.confidence != null
        ? aiSummary.bill_date.confidence
        : (aiSummary.confidence || null))
  } : null;

  return {
    run_at: new Date().toISOString(),
    provider,
    heuristics: heuristicBlock,
    ai: aiBlock,
    applied: appliedEvidence || null
  };
}

function computeQualityScore({ vendorName, billDate, totalAmount }) {
  let score = 0;
  if (vendorName) score += 25;
  if (billDate) score += 35;
  if (totalAmount && totalAmount > 0) score += 40;
  if (score > 100) return 100;
  return score;
}

function asNumberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const num = Number(value);
  if (Number.isNaN(num)) return null;
  return num;
}

function sanitizeSnippet(snippet) {
  if (!snippet) return null;
  const normalized = snippet.toString().replace(/\s+/g, ' ').trim();
  if (!normalized) return null;
  return normalized.length > 140 ? `${normalized.slice(0, 137)}...` : normalized;
}

function determineFieldSource({ value, locked, manualFlag, provider, aiHasValue, heuristicHasValue }) {
  if ((locked && value) || manualFlag) return 'manual';
  if (aiHasValue) {
    if (!provider) return 'ai';
    if (provider === 'rule' || provider === 'heuristic') return 'heuristic';
    if (provider === 'manual') return 'manual';
    return provider;
  }
  if (heuristicHasValue) return 'heuristic';
  if (value) return 'stored';
  return null;
}

function formatCurrencyValue(value) {
  const amount = asNumberOrNull(value);
  if (amount === null) return null;
  return `₹${amount.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
}

function normalizeAiField(field) {
  if (!field) {
    return { value: null, confidence: null, evidence: null };
  }
  if (typeof field === 'object') {
    return {
      value: field.value ?? null,
      confidence: field.confidence != null ? Number(field.confidence) : null,
      evidence: field.evidence || null
    };
  }
  return {
    value: field,
    confidence: null,
    evidence: null
  };
}

function buildDateEvidence(aiState, heuristics) {
  const aiField = normalizeAiField(aiState?.bill_date);
  if (aiField.value) {
    const conf = aiField.confidence != null
      ? ` (${Math.round(aiField.confidence * 100)}% conf.)`
      : '';
    const snippet = sanitizeSnippet(aiField.evidence || aiField.value);
    return `AI → ${snippet}${conf}`.trim();
  }
  const candidates = Array.isArray(heuristics?.bill_date_candidates)
    ? heuristics.bill_date_candidates
    : Array.isArray(heuristics?.date_candidates)
      ? heuristics.date_candidates
      : [];
  if (candidates.length > 0) {
    const first = candidates[0];
    if (first && typeof first === 'object') {
      const snippet = sanitizeSnippet(first.evidence || first.value);
      return `Heuristic → ${snippet}`;
    }
    return `Heuristic → ${sanitizeSnippet(first)}`;
  }
  return null;
}

function buildTotalEvidence(aiState, heuristics) {
  const aiField = normalizeAiField(aiState?.total_amount || aiState?.total);
  if (aiField.value != null) {
    const currency = formatCurrencyValue(aiField.value) || aiField.value;
    const confidence = aiField.confidence != null
      ? ` (${Math.round(Number(aiField.confidence) * 100)}% conf.)`
      : '';
    const snippet = sanitizeSnippet(aiField.evidence);
    const suffix = snippet ? ` | ${snippet}` : '';
    return `AI → ${currency}${confidence}${suffix}`.trim();
  }
  const candidates = Array.isArray(heuristics?.total_candidates)
    ? heuristics.total_candidates
    : [];
  if (candidates.length > 0) {
    const candidate = candidates[0];
    const currency = formatCurrencyValue(candidate.value) || candidate.value;
    const snippetSource = candidate.evidence || candidate.line;
    const snippet = sanitizeSnippet(snippetSource);
    return `Heuristic → ${currency}${snippet ? ` | ${snippet}` : ''}`;
  }
  return null;
}

function getHeuristicDateCandidates(heuristics) {
  if (!heuristics) return [];
  if (Array.isArray(heuristics.bill_date_candidates)) return heuristics.bill_date_candidates;
  if (Array.isArray(heuristics.date_candidates)) {
    return heuristics.date_candidates.map((value) => {
      if (!value || typeof value === 'object') return value;
      return { value, evidence: value, confidence: null };
    });
  }
  return [];
}

function pickBestDateCandidate(heuristics) {
  const candidates = getHeuristicDateCandidates(heuristics);
  if (!candidates.length) return null;
  const first = candidates[0];
  if (!first) return null;
  if (typeof first === 'object') return first;
  return { value: first, evidence: first, confidence: null };
}

function pickBestTotalCandidate(heuristics) {
  if (!heuristics || !Array.isArray(heuristics.total_candidates)) return null;
  const [first] = heuristics.total_candidates;
  if (!first) return null;
  if (typeof first === 'object') return first;
  return { value: asNumberOrNull(first), evidence: first, confidence: null };
}

function canUseAiCandidate(candidate, rawText, threshold) {
  if (!candidate || candidate.value === null || candidate.value === undefined) return false;
  if (candidate.confidence === null || candidate.confidence === undefined) return false;
  if (candidate.confidence < threshold) return false;
  if (!candidate.evidence) return false;
  return evidenceMatchesRawText(rawText || '', candidate.evidence);
}

function resolveVerificationReason({ hasBillDate, hasTotal, qualityScore, aiConfidence, heuristics }) {
  const heuristicFlags = heuristics?.flags || {};
  if (!hasBillDate && !hasTotal) return 'Missing date & total';
  if (!hasBillDate) {
    if (heuristicFlags.ambiguousDate || (Array.isArray(heuristics?.bill_date_candidates) && heuristics.bill_date_candidates.length > 1)) {
      return 'Ambiguous date';
    }
    return 'Missing bill date';
  }
  if (!hasTotal) {
    if (heuristicFlags.ambiguousTotal || heuristicFlags.multipleTotals || (Array.isArray(heuristics?.total_candidates) && heuristics.total_candidates.length > 1)) {
      return 'Ambiguous total';
    }
    return 'Missing total';
  }
  if (qualityScore != null && qualityScore < 60) return 'Low quality';
  if (aiConfidence != null && aiConfidence < 0.5) return 'Low AI confidence';
  return null;
}

function buildVerificationSnapshot(row = {}) {
  const geminiData = (row.gemini_data && typeof row.gemini_data === 'object')
    ? row.gemini_data
    : safeParseJSON(row.gemini_data) || {};
  const extractionState = (row.extraction_state && typeof row.extraction_state === 'object')
    ? row.extraction_state
    : safeParseJSON(row.extraction_state) || {};
  const heuristics = extractionState?.heuristics || {};
  const aiState = extractionState?.ai || {};
  const aiBillDateField = normalizeAiField(aiState?.bill_date);
  const aiTotalField = normalizeAiField(aiState?.total_amount || aiState?.total);
  const provider = (extractionState?.provider || '').toLowerCase();
  const manualFlag = Boolean(extractionState?.manual || geminiData?.manual);

  const storedBillDate = row.bill_date || geminiData?.bill_date || null;
  let storedTotal = row.total_amount != null
    ? asNumberOrNull(row.total_amount)
    : asNumberOrNull(geminiData?.amounts?.total);
  if (storedTotal === null && row.bill_total_amount != null) {
    storedTotal = asNumberOrNull(row.bill_total_amount);
  }

  const hasBillDate = Boolean(storedBillDate);
  const hasTotal = storedTotal != null && storedTotal > 0;
  const lockedDate = Boolean(row.bill_date_locked);
  const lockedTotal = Boolean(row.total_locked);
  const qualityScore = asNumberOrNull(row.quality_score);
  const aiConfidence = asNumberOrNull(
    aiState?.confidence != null
      ? aiState.confidence
      : (aiTotalField.confidence != null
        ? aiTotalField.confidence
        : aiBillDateField.confidence)
  );
  const docStatus = (row.status || '').toLowerCase();
  const storedStatus = (row.verification_status || '').toLowerCase();
  const hasRawText = Boolean(row.raw_text);

  const storedReason = row.verification_reason || null;
  const unpostedAmount = Number(row.unposted_amount || 0);
  const hasUnposted = unpostedAmount > 0;
  let reason = storedReason || resolveVerificationReason({
    hasBillDate,
    hasTotal,
    qualityScore,
    aiConfidence,
    heuristics
  });
  if (hasUnposted) {
    reason = reason || 'Unposted spend';
  }

  const isProcessing = !hasRawText || !['processed', 'manual_required'].includes(docStatus);
  let status;
  if (isProcessing) {
    status = 'processing';
  } else if (hasBillDate && hasTotal && (lockedDate || lockedTotal || storedStatus === 'verified')) {
    status = 'verified';
  } else if (
    reason ||
    storedStatus === 'needs_review' ||
    storedStatus === 'failed' ||
    (!hasBillDate || !hasTotal)
  ) {
    status = 'needs_review';
  } else {
    status = storedStatus || 'unverified';
  }

  const billDateSource = determineFieldSource({
    value: storedBillDate,
    locked: lockedDate,
    manualFlag,
    provider,
    aiHasValue: Boolean(aiBillDateField.value),
    heuristicHasValue: Array.isArray(heuristics?.bill_date_candidates) && heuristics.bill_date_candidates.length > 0
  });

  const totalSource = determineFieldSource({
    value: storedTotal,
    locked: lockedTotal,
    manualFlag,
    provider,
    aiHasValue: aiTotalField.value != null,
    heuristicHasValue: Array.isArray(heuristics?.total_candidates) && heuristics.total_candidates.length > 0
  });

  return {
    status,
    unposted_amount: unpostedAmount > 0 ? unpostedAmount : null,
    quality_score: qualityScore != null ? qualityScore : null,
    bill_date_locked: lockedDate,
    total_locked: lockedTotal,
    bill_date_source: billDateSource,
    total_source: totalSource,
    bill_date_evidence: buildDateEvidence(aiState, heuristics),
    total_evidence: buildTotalEvidence(aiState, heuristics),
    reason: status === 'needs_review' ? reason : null
  };
}

// Background AI processing with accounting entries
async function processDocumentWithAI(
  document,
  rawTextFromPreprocess,
  paymentMethod = 'UNSPECIFIED',
  actorContext = {}
) {
  const actorType = actorContext.actorType || 'system';
  const actorId = actorContext.actorId || null;
  const operationId = crypto.randomUUID();
  const sourceAction = actorContext.sourceAction || (actorType === 'system' ? 'upload_auto' : 'reprocess');
  const docBillDateLocked = Boolean(document.bill_date_locked);
  const docTotalLocked = Boolean(document.total_locked);

  try {
    console.log(`\n🤖 AI Processing: ${document.file_name}`);
    const manualGemini = safeParseJSON(document.gemini_data);
    if (manualGemini?.manual) {
      console.log(`Skipping AI for document ${document.document_id} because it has a manual override.`);
      return { success: false, reason: 'manual_override' };
    }

    const existingBillResult = await pool.query(
      `SELECT bill_id, bill_date, total_amount, confidence_score, payment_status,
              bill_date_locked, total_locked
         FROM bills
        WHERE document_id = $1
        LIMIT 1`,
      [document.document_id]
    );
    const existingBill = existingBillResult.rows[0] || null;
    const hasManualLock = existingBill && parseFloat(existingBill.confidence_score || 0) >= 0.99;
    if (hasManualLock) {
      console.log(`Skipping AI for document ${document.document_id} because a manual bill already exists.`);
      return { success: false, reason: 'manual_locked' };
    }

    let rawText = rawTextFromPreprocess || getRawTextFromDoc(document);
    const currentOcrVersion = parseInt(document.ocr_version || '0', 10);
    let needsFreshOcr = false;
    if (!rawText || rawText.length < MIN_OCR_TEXT_LENGTH) {
      needsFreshOcr = true;
    }
    if (currentOcrVersion < REQUIRED_OCR_VERSION) {
      needsFreshOcr = true;
    }
    let computedFileHash = null;
    if (document.file_path && document.file_hash && !needsFreshOcr) {
      try {
        computedFileHash = await computeFileHash(document.file_path);
        if (computedFileHash !== document.file_hash) {
          needsFreshOcr = true;
        }
      } catch (hashErr) {
        console.error('File hash compute failed:', hashErr.message);
      }
    } else if (document.file_path && !document.file_hash) {
      needsFreshOcr = true;
    }

    if (needsFreshOcr && document.file_path) {
      try {
        if (!computedFileHash) {
          computedFileHash = await computeFileHash(document.file_path);
        }
      } catch (hashErr) {
        console.error('File hash recompute failed:', hashErr.message);
      }
      try {
        const pre = await preprocessFile(document.file_path, document.file_type);
        rawText = pre.raw_text || '';
        if (rawText) {
          await storeRawText(document.document_id, rawText, pre.meta || {}, { fileHash: computedFileHash });
        }
      } catch (err) {
        console.error('Re-preprocess error:', err.message);
      }
    }

    if (!rawText || rawText.length < Math.max(50, Math.floor(MIN_OCR_TEXT_LENGTH * 0.5))) {
      await pool.query(
        'UPDATE documents SET status = $1, notes = COALESCE(notes, $2) WHERE document_id = $3',
        ['manual_required', 'OCR text missing; manual review needed', document.document_id]
      );
      return { success: false, reason: 'missing_ocr' };
    }

    const heuristicsSeed = rawText ? extractWithRules(rawText) : null;
    let extraction = await parseInvoiceText(rawText, {
      filePath: document.file_path,
      fileType: document.file_type,
      heuristics: heuristicsSeed
    });

    await recordAiAttempt(document.document_id, extraction.success ? null : extraction.error);

    if (!extraction.success && heuristicsSeed && heuristicsSeed.amounts?.total) {
      extraction = {
        success: true,
        provider: 'rule',
        fallback: true,
        data: { ...heuristicsSeed },
        heuristics: heuristicsSeed,
        aiSummary: null
      };
    }

    if (!extraction.success) {
      console.error('AI extraction failed:', extraction.error);
      await pool.query(
        'UPDATE documents SET status = $1, notes = COALESCE(notes, $2) WHERE document_id = $3',
        ['manual_required', 'AI extraction failed, manual processing needed', document.document_id]
      );
      return { success: false, reason: 'ai_failed', error: extraction.error };
    }

    let provider = extraction.provider || 'openai';
    const heuristics = extraction.heuristics || heuristicsSeed || null;
    const aiSummary = extraction.aiSummary || null;
    const rawData = extraction.data || {};
    rawData.amounts = rawData.amounts || { subtotal: null, tax_amount: null, total: null };

    const vendorName =
      rawData.vendor_name ||
      rawData.vendor ||
      rawData.supplier ||
      rawData.merchant ||
      null;

    const heuristicDate = pickBestDateCandidate(heuristics);
    const heuristicTotal = pickBestTotalCandidate(heuristics);
    const aiBillDateCandidate = aiSummary ? normalizeAiField(aiSummary.bill_date) : { value: null, confidence: null, evidence: null };
    const aiTotalCandidate = aiSummary ? normalizeAiField(aiSummary.total_amount) : { value: null, confidence: null, evidence: null };

    const previousBillDate = normalizeISODate(existingBill?.bill_date);
    const previousTotal = existingBill && existingBill.total_amount != null
      ? Number(existingBill.total_amount)
      : null;
    const billDateLocked = docBillDateLocked || Boolean(existingBill?.bill_date_locked);
    const billTotalLocked = docTotalLocked || Boolean(existingBill?.total_locked);

    const fieldEvidence = {
      bill_date: null,
      total_amount: null
    };

    let resolvedBillDate = previousBillDate || rawData.bill_date || document.bill_date || null;
    if (!billDateLocked) {
      if (canUseAiCandidate(aiBillDateCandidate, rawText, VERIFY_CONF_THRESHOLD)) {
        resolvedBillDate = aiBillDateCandidate.value;
        fieldEvidence.bill_date = { source: 'ai', evidence: aiBillDateCandidate.evidence, confidence: aiBillDateCandidate.confidence };
      } else if (!resolvedBillDate && heuristicDate?.value) {
        resolvedBillDate = heuristicDate.value;
        fieldEvidence.bill_date = { source: 'heuristic', evidence: heuristicDate.evidence || heuristicDate.value, confidence: heuristicDate.confidence || null };
      }
    } else if (previousBillDate) {
      resolvedBillDate = previousBillDate;
    }

    let resolvedTotal = previousTotal != null
      ? Number(previousTotal)
      : asNumberOrNull(rawData?.amounts?.total ?? rawData.total_amount ?? rawData.total);

    if (!billTotalLocked) {
      if (canUseAiCandidate(aiTotalCandidate, rawText, VERIFY_CONF_THRESHOLD)) {
        resolvedTotal = asNumberOrNull(aiTotalCandidate.value);
        fieldEvidence.total_amount = { source: 'ai', evidence: aiTotalCandidate.evidence, confidence: aiTotalCandidate.confidence };
      } else if (!resolvedTotal && heuristicTotal?.value) {
        resolvedTotal = asNumberOrNull(heuristicTotal.value);
        fieldEvidence.total_amount = { source: 'heuristic', evidence: heuristicTotal.evidence || heuristicTotal.line, confidence: heuristicTotal.confidence || null };
      }
    } else if (previousTotal != null) {
      resolvedTotal = Number(previousTotal);
    }

    if (!resolvedTotal || Number.isNaN(resolvedTotal) || resolvedTotal <= 0) {
      await pool.query(
        'UPDATE documents SET status = $1, notes = COALESCE(notes, $2) WHERE document_id = $3',
        ['manual_required', 'AI could not extract total amount reliably', document.document_id]
      );
      return { success: false, reason: 'missing_total' };
    }

    const finalVendorName = vendorName || document.vendor_name || document.bill_vendor_name || null;

    const data = {
      vendor_name: finalVendorName,
      bill_number: rawData.bill_number || null,
      bill_date: resolvedBillDate,
      amounts: {
        subtotal: rawData?.amounts?.subtotal || resolvedTotal,
        tax_amount: rawData?.amounts?.tax_amount || 0,
        total: resolvedTotal
      },
      payment_terms: rawData.payment_terms || null,
      confidence: rawData.confidence
        || aiTotalCandidate.confidence
        || aiBillDateCandidate.confidence
        || null,
      _provider: provider,
      _fallback: provider !== 'openai'
    };

    const aiUsedField = (fieldEvidence.bill_date?.source === 'ai') || (fieldEvidence.total_amount?.source === 'ai');
    if (provider === 'openai' && !aiUsedField) {
      provider = 'hybrid';
      data._provider = 'hybrid';
      data._fallback = true;
    }

    const chosenCategory =
      document.document_category ||
      data.category ||
      rawData.category ||
      'misc';
    const categoryInfo = normalizeCategory(chosenCategory);
    data.category = categoryInfo.category;
    data.category_group = categoryInfo.category_group;
    const effectiveCategory = categoryInfo.category;
    if (!['fabric', 'manufacturing'].includes(effectiveCategory) && data.line_items) {
      delete data.line_items;
    }

    const effectivePayment = paymentMethod || document.payment_method || 'UNSPECIFIED';
    const dropName = document.drop_name || null;

    const appliedEvidence = {
      bill_date: {
        value: resolvedBillDate,
        source: fieldEvidence.bill_date?.source || (billDateLocked ? 'locked' : 'stored'),
        evidence: fieldEvidence.bill_date?.evidence || null,
        confidence: fieldEvidence.bill_date?.confidence || null
      },
      total_amount: {
        value: resolvedTotal,
        source: fieldEvidence.total_amount?.source || (billTotalLocked ? 'locked' : 'stored'),
        evidence: fieldEvidence.total_amount?.evidence || null,
        confidence: fieldEvidence.total_amount?.confidence || null
      }
    };

    const aiSnapshot = aiSummary ? {
      vendor_name: aiSummary.vendor_name || null,
      bill_number: aiSummary.bill_number || null,
      bill_date: aiSummary.bill_date || null,
      total_amount: aiSummary.total_amount || null,
      subtotal: aiSummary.subtotal != null ? aiSummary.subtotal : null,
      tax_amount: aiSummary.tax_amount != null ? aiSummary.tax_amount : null,
      quality_score: aiSummary.quality_score != null ? aiSummary.quality_score : null,
      reason: aiSummary.reason || null
    } : null;

    const extractionState = buildExtractionState({
      provider,
      heuristics,
      aiSummary: aiSnapshot,
      appliedEvidence
    });

    const qualityScore = computeQualityScore({
      vendorName: data.vendor_name,
      billDate: resolvedBillDate,
      totalAmount: resolvedTotal
    });
    const hasBillDate = Boolean(resolvedBillDate);
    const hasTotal = resolvedTotal != null && resolvedTotal > 0;
    const aiConfidence = aiTotalCandidate.confidence || aiBillDateCandidate.confidence || data.confidence || null;
    const verificationReason = resolveVerificationReason({
      hasBillDate,
      hasTotal,
      qualityScore,
      aiConfidence,
      heuristics
    });
    const isVerified = shouldPromoteToVerified({ hasBillDate, hasTotal, lockedDate: billDateLocked, lockedTotal: billTotalLocked });
    const verificationStatus = isVerified
      ? 'verified'
      : (verificationReason ? 'needs_review' : 'unverified');
    const verifiedAt = isVerified ? new Date().toISOString() : null;
    const verifiedBy = isVerified ? (actorId || DEFAULT_JOURNAL_USER_ID) : null;
    const verificationSource = isVerified ? determineVerificationSource(actorType) : null;

    await pool.query(
      'UPDATE documents SET gemini_data = $1, status = $2, extraction_state = $3, quality_score = $4, verification_status = $5, verification_reason = $6, verified_at = $7, verified_by_user_id = $8, verification_source = $9 WHERE document_id = $10',
      [
        JSON.stringify(data),
        'processed',
        JSON.stringify(extractionState),
        qualityScore,
        verificationStatus,
        verificationReason,
        verifiedAt,
        verifiedBy,
        verificationSource,
        document.document_id
      ]
    );

    let vendorId = null;
    if (finalVendorName) {
      vendorId = await createOrUpdateVendor(data);
    }

    const billUpsert = await pool.query(
      `INSERT INTO bills 
         (document_id, vendor_id, bill_number, bill_date, subtotal, tax_amount, total_amount, 
          category, category_group, drop_name, confidence_score, status, payment_status, payment_method)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
       ON CONFLICT ON CONSTRAINT ux_bills_document DO UPDATE SET
          vendor_id = EXCLUDED.vendor_id,
          bill_number = EXCLUDED.bill_number,
          bill_date = EXCLUDED.bill_date,
          subtotal = EXCLUDED.subtotal,
          tax_amount = EXCLUDED.tax_amount,
          total_amount = EXCLUDED.total_amount,
          category = EXCLUDED.category,
          category_group = EXCLUDED.category_group,
          drop_name = EXCLUDED.drop_name,
          confidence_score = EXCLUDED.confidence_score,
          status = EXCLUDED.status,
          payment_status = EXCLUDED.payment_status,
          payment_method = EXCLUDED.payment_method
       RETURNING bill_id, bill_date, total_amount`,
      [
        document.document_id,
        vendorId,
        data.bill_number || null,
        resolvedBillDate || document.bill_date || null,
        data.amounts?.subtotal || 0,
        data.amounts?.tax_amount || 0,
        resolvedTotal || 0,
        data.category || document.document_category || 'misc',
        categoryInfo.category_group,
        dropName,
        data.confidence || 0.8,
        'approved',
        'pending',
        effectivePayment
      ]
    );
    const billId = billUpsert.rows[0].bill_id;
    const updatedBillDate = normalizeISODate(billUpsert.rows[0].bill_date || resolvedBillDate);
    const updatedTotal = Number(billUpsert.rows[0].total_amount ?? resolvedTotal);

    if (!billDateLocked && updatedBillDate) {
      const billDateEvidence = fieldEvidence.bill_date?.evidence
        || heuristicDate?.evidence
        || heuristics?.date_candidates?.[0]
        || updatedBillDate;
      const billDateReason = fieldEvidence.bill_date?.source === 'heuristic' ? 'heuristic_extract' : 'ai_extract';
      const billDateConfidence = fieldEvidence.bill_date?.confidence || data.confidence || null;
      await logDocumentFieldChange({
        documentId: document.document_id,
        fieldName: 'bill_date',
        oldValue: previousBillDate,
        newValue: updatedBillDate,
        actorType: 'ai',
        actorId,
        reason: billDateReason,
        confidence: billDateConfidence,
        evidence: billDateEvidence,
        operationId,
        sourceAction
      });
    }
    if (!billTotalLocked && updatedTotal && updatedTotal !== previousTotal) {
      const totalEvidence = fieldEvidence.total_amount?.evidence
        || heuristicTotal?.evidence
        || heuristics?.total_candidates?.[0]?.line
        || updatedTotal;
      const totalReason = fieldEvidence.total_amount?.source === 'heuristic' ? 'heuristic_extract' : 'ai_extract';
      const totalConfidence = fieldEvidence.total_amount?.confidence || data.confidence || null;
      await logDocumentFieldChange({
        documentId: document.document_id,
        fieldName: 'total_amount',
        oldValue: previousTotal,
        newValue: updatedTotal,
        actorType: 'ai',
        actorId,
        reason: totalReason,
        confidence: totalConfidence,
        evidence: totalEvidence,
        operationId,
        sourceAction
      });
    }

    await pool.query('DELETE FROM bill_items WHERE bill_id = $1', [billId]);
    const defaultDropId = await getDefaultDropId();
    if (data.line_items && data.line_items.length > 0) {
      for (let i = 0; i < data.line_items.length; i += 1) {
        const item = data.line_items[i];
        await pool.query(
          `INSERT INTO bill_items (bill_id, description, quantity, unit_price, amount, line_number, drop_id, is_postable, posting_status)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [
            billId,
            item.description,
            item.quantity || 0,
            item.rate || 0,
            item.amount || 0,
            i + 1,
            item.drop_id || defaultDropId,
            item.is_postable === false ? false : true,
            'unposted'
          ]
        );
      }
    }

    const scheduleCreated = await createPaymentSchedule(billId, {
      bill_date: data.bill_date || document.bill_date,
      amounts: data.amounts || { total: resolvedTotal || 0 },
      payment_terms: data.payment_terms
    });
    const paymentStatus = scheduleCreated ? 'pending' : 'paid';
    await pool.query('UPDATE bills SET payment_status = $1 WHERE bill_id = $2', [paymentStatus, billId]);

    await createAccountingEntries(
      billId,
      data,
      vendorId,
      { createdBy: resolveJournalUser(document.uploaded_by) }
    );

    console.log('✅ Complete: Bill recorded with accounting entries\n');
    return { success: true, bill_id: billId, vendor_id: vendorId, document_id: document.document_id };
  } catch (error) {
    console.error('AI Processing error:', error);
    await pool.query(
      'UPDATE documents SET status = $1, notes = COALESCE(notes, $2) WHERE document_id = $3',
      ['manual_required', 'AI extraction failed, manual processing needed', document.document_id]
    );
    return { success: false, error: error.message };
  }
}

async function createOrUpdateVendor(data) {
  if (!data.vendor_name) return null;
  
  const result = await pool.query(
    `INSERT INTO vendors (vendor_name, vendor_code, gstin, pan, address, phone, vendor_type, is_active)
     VALUES ($1, $2, $3, $4, $5, $6, $7, true)
     ON CONFLICT (vendor_code) DO UPDATE 
     SET vendor_name = EXCLUDED.vendor_name, gstin = EXCLUDED.gstin
     RETURNING vendor_id`,
    [
      data.vendor_name,
      data.vendor_name.toUpperCase().replace(/[^A-Z0-9]/g, '').substring(0, 10),
      data.vendor_gstin || null,
      data.vendor_pan || null,
      data.vendor_address || null,
      data.vendor_contact || null,
      data.category || 'vendor'
    ]
  );
  
  return result.rows[0]?.vendor_id || null;
}

async function createPaymentSchedule(billId, data = {}) {
  const terms = data.payment_terms;
  await pool.query('DELETE FROM payment_terms WHERE bill_id = $1', [billId]);
  await pool.query('DELETE FROM payment_schedule WHERE bill_id = $1', [billId]);

  if (!hasActionablePaymentTerms(terms) || (terms.type && terms.type.toUpperCase() !== 'ADVANCE')) {
    return false;
  }

  const totalAmount = Number(data.amounts?.total ?? data.total_amount ?? 0);
  const billDate = new Date(data.bill_date || new Date());
  const type = (terms.type || '').toUpperCase();
  const dueDate = terms.due_date ? new Date(terms.due_date) : null;
  const installments = Array.isArray(terms.installments) ? terms.installments : [];
  const advancePct = terms.advance_percentage != null ? Number(terms.advance_percentage) : null;
  const netDays = Number(terms.net_days || (type.startsWith('NET_') ? type.replace('NET_', '') : NaN));

  await pool.query(
    `INSERT INTO payment_terms (bill_id, payment_type, total_amount, advance_percentage, installment_count, terms_text)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [billId, type || 'FULL', totalAmount, advancePct || null, installments.length || null, terms.description || null]
  );

  if (installments.length > 0) {
    for (let i = 0; i < installments.length; i++) {
      const inst = installments[i];
      if (!inst.due_date) continue;
      await pool.query(
        `INSERT INTO payment_schedule (bill_id, installment_number, due_date, amount_due)
         VALUES ($1, $2, $3, $4)`,
        [
          billId,
          i + 1,
          new Date(inst.due_date),
          Number(inst.amount || (totalAmount / installments.length))
        ]
      );
    }
    return true;
  }

  if (type === 'ADVANCE') {
    if (!advancePct || !dueDate) {
      return false;
    }
    const advanceAmount = Number((totalAmount * advancePct) / 100);
    const balanceAmount = Math.max(totalAmount - advanceAmount, 0);
    if (advanceAmount > 0) {
      await pool.query(
        `INSERT INTO payment_schedule (bill_id, installment_number, due_date, amount_due, amount_paid, payment_status)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [billId, 1, billDate, advanceAmount, advanceAmount, 'PAID']
      );
    }
    if (balanceAmount > 0) {
      await pool.query(
        `INSERT INTO payment_schedule (bill_id, installment_number, due_date, amount_due)
         VALUES ($1, $2, $3, $4)`,
        [billId, advanceAmount > 0 ? 2 : 1, dueDate, balanceAmount]
      );
    }
    return true;
  }

  if (!Number.isNaN(netDays) && netDays > 0) {
    const netDue = new Date(billDate);
    netDue.setDate(netDue.getDate() + netDays);
    await pool.query(
      `INSERT INTO payment_schedule (bill_id, installment_number, due_date, amount_due)
       VALUES ($1, $2, $3, $4)`,
      [billId, 1, netDue, totalAmount]
    );
    return true;
  }

  if (dueDate) {
    await pool.query(
      `INSERT INTO payment_schedule (bill_id, installment_number, due_date, amount_due)
       VALUES ($1, $2, $3, $4)`,
      [billId, 1, dueDate, totalAmount]
    );
    return true;
  }

  return false;
}

// 🎯 CREATE DOUBLE-ENTRY ACCOUNTING
async function createAccountingEntries(billId, data, vendorId, options = {}) {
  const category = data.category || 'misc';
  const subtotal = data.amounts?.subtotal || 0;
  const taxAmount = data.amounts?.tax_amount || 0;
  const total = data.amounts?.total || 0;
  const createdBy = resolveJournalUser(options.createdBy || data.created_by || null);
  
  // Get or create GL accounts
  const expenseAccount = await getGLAccount(category);
  const inputTaxAccount = await getGLAccount('input_tax');
  const payableAccount = await getGLAccount('accounts_payable');
  
  // Create journal entry
  const journalResult = await pool.query(
    `INSERT INTO journal_entries (entry_date, reference_type, reference_id, description, total_debit, total_credit, status, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING journal_id`,
    [
      data.bill_date || new Date(),
      'BILL',
      billId,
      `${data.vendor_name || 'Vendor'} - ${data.bill_number || 'Bill'}`,
      total,
      total,
      'posted',
      createdBy
    ]
  );
  
  const journalId = journalResult.rows[0].journal_id;
  
  // Debit: Expense Account
  await pool.query(
    `INSERT INTO journal_entry_lines (journal_id, account_id, debit_amount, credit_amount, description, line_number)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [journalId, expenseAccount, subtotal, 0, `${category} expense`, 1]
  );
  
  // Debit: Input Tax (GST)
  if (taxAmount > 0) {
    await pool.query(
      `INSERT INTO journal_entry_lines (journal_id, account_id, debit_amount, credit_amount, description, line_number)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [journalId, inputTaxAccount, taxAmount, 0, 'Input GST', 2]
    );
  }
  
  // Credit: Accounts Payable
  await pool.query(
    `INSERT INTO journal_entry_lines (journal_id, account_id, debit_amount, credit_amount, description, line_number)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [journalId, payableAccount, 0, total, `Payable to ${data.vendor_name || 'Vendor'}`, 3]
  );
  
  console.log(`✓ Journal Entry #${journalId} created`);
}

// Get or create GL account by category
async function getGLAccount(category) {
  const accountMap = {
    'food': { code: '5100', name: 'Food & Meals Expense', type: 'EXPENSE' },
    'travel': { code: '5200', name: 'Travel & Transportation', type: 'EXPENSE' },
    'vendor': { code: '5300', name: 'Vendor Payments', type: 'EXPENSE' },
    'manufacturing': { code: '4100', name: 'Cost of Goods Sold - Manufacturing', type: 'COGS' },
    'stitching': { code: '4200', name: 'Cost of Goods Sold - Stitching', type: 'COGS' },
    'salary': { code: '5400', name: 'Salaries & Wages', type: 'EXPENSE' },
    'rent': { code: '5500', name: 'Rent Expense', type: 'EXPENSE' },
    'tech': { code: '5600', name: 'Technology Expense', type: 'EXPENSE' },
    'marketing': { code: '5700', name: 'Marketing & Advertising', type: 'EXPENSE' },
    'logistics': { code: '5800', name: 'Logistics & Shipping', type: 'EXPENSE' },
    'packaging': { code: '4300', name: 'Packaging Materials', type: 'COGS' },
    'input_tax': { code: '1300', name: 'Input Tax Credit (GST)', type: 'ASSET' },
    'accounts_payable': { code: '2100', name: 'Accounts Payable', type: 'LIABILITY' },
    'misc': { code: '5900', name: 'Miscellaneous Expense', type: 'EXPENSE' }
  };
  
  const account = accountMap[category] || accountMap['misc'];
  
  const result = await pool.query(
    `INSERT INTO accounts (account_code, account_name, account_type, is_active)
     VALUES ($1, $2, $3, true)
     ON CONFLICT (account_code) DO UPDATE SET account_name = EXCLUDED.account_name
     RETURNING account_id`,
    [account.code, account.name, account.type]
  );
  
  return result.rows[0].account_id;
}

// Get all documents
const getDocuments = async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT 
        d.*,
        d.payment_method AS document_payment_method,
        v.vendor_name,
        b.bill_id,
        b.bill_number,
        b.bill_date,
        COALESCE(b.category, d.document_category) AS category,
        b.total_amount,
        b.total_amount AS bill_total_amount,
        b.category AS bill_category,
        b.category_group,
        COALESCE(b.payment_method, d.payment_method) AS payment_method,
        b.payment_method AS bill_payment_method,
        b.drop_name,
        b.trip_name,
        b.channel,
        b.campaign,
        b.department,
        b.status as bill_status,
        b.payment_status,
        pt.payment_type AS bill_payment_type,
        pt.advance_percentage AS bill_advance_percentage,
        pt.terms_text AS bill_payment_terms_text,
        ps.due_date AS bill_payment_due_date,
        COALESCE(unposted.unposted_amount, 0) AS unposted_amount,
        COALESCE(unposted.unposted_count, 0) AS unposted_line_count
       FROM documents d
       LEFT JOIN bills b ON b.document_id = d.document_id
       LEFT JOIN vendors v ON b.vendor_id = v.vendor_id
       LEFT JOIN LATERAL (
         SELECT payment_type, advance_percentage, terms_text
         FROM payment_terms
         WHERE bill_id = b.bill_id
         ORDER BY term_id DESC
         LIMIT 1
       ) pt ON true
       LEFT JOIN LATERAL (
         SELECT due_date
         FROM payment_schedule
         WHERE bill_id = b.bill_id
         ORDER BY due_date ASC
         LIMIT 1
       ) ps ON true
       LEFT JOIN LATERAL (
         SELECT
           COUNT(*) FILTER (WHERE bi.is_postable AND bi.posting_status <> 'posted') AS unposted_count,
           COALESCE(SUM(bi.amount) FILTER (WHERE bi.is_postable AND bi.posting_status <> 'posted'), 0) AS unposted_amount
         FROM bill_items bi
         WHERE bi.bill_id = b.bill_id
       ) unposted ON true
        LEFT JOIN LATERAL (
          SELECT COUNT(*) AS missing_dims_count
          FROM bill_items bi
          WHERE bi.bill_id = b.bill_id
            AND bi.is_postable
            AND (
              bi.coa_account_id IS NULL
              OR bi.department_id IS NULL
              OR bi.drop_id IS NULL
            )
        ) dims ON true
       ORDER BY d.uploaded_at DESC`
    );
    const userId = req.user?.userId;
    const role = req.user?.role || 'uploader';
    const canManageAll = role === 'manager' || role === 'admin';
    const docs = result.rows.map((row) => {
      const parsedGemini = safeParseJSON(row.gemini_data);
      if (parsedGemini) {
        row.gemini_data = parsedGemini;
      }
      const effectivePayment =
        row.bill_payment_method ||
        row.document_payment_method ||
        row.payment_method ||
        null;
      row.payment_method = effectivePayment;
      row.category = row.bill_category || row.document_category || row.category;
      if (row.bill_payment_type || row.bill_advance_percentage || row.bill_payment_due_date || row.bill_payment_terms_text) {
        row.payment_terms = {
          type: row.bill_payment_type || 'FULL',
          advance_percentage: row.bill_advance_percentage,
          due_date: row.bill_payment_due_date,
          description: row.bill_payment_terms_text || null
        };
      }
      const ownsDoc = row.uploaded_by === userId;
      const verification = buildVerificationSnapshot(row);
      return {
        ...row,
        can_delete: canManageAll || ownsDoc,
        can_manual: canManageAll,
        can_process: canManageAll,
        verification
        ,missing_dimensions: row.missing_dims_count || 0
      };
    });

    res.json({
      success: true,
      documents: docs,
      count: docs.length
    });
  } catch (error) {
    console.error('Get documents error:', error);
    res.status(500).json({ error: error.message });
  }
};

const getDocument = async (req, res) => {
  try {
    const { id } = req.params;
    const docResult = await pool.query(
      `SELECT 
         d.*,
         d.payment_method AS document_payment_method,
         b.bill_id,
         b.vendor_id,
         b.bill_number,
         b.bill_date,
         b.due_date,
         b.subtotal AS bill_subtotal,
         b.tax_amount AS bill_tax_amount,
         b.total_amount AS bill_total_amount,
         b.category AS bill_category,
         b.category_group AS bill_category_group,
         b.payment_method AS bill_payment_method,
         b.drop_name AS bill_drop_name,
         b.trip_name AS bill_trip_name,
         b.channel AS bill_channel,
         b.campaign AS bill_campaign,
         b.department AS bill_department,
         b.tags AS bill_tags,
         b.status AS bill_status,
         b.payment_status AS bill_payment_status,
         pt.payment_type AS bill_payment_type,
         pt.advance_percentage AS bill_advance_percentage,
         pt.terms_text AS bill_payment_terms_text,
         ps.due_date AS bill_payment_due_date,
         v.vendor_name AS bill_vendor_name
       FROM documents d
       LEFT JOIN bills b ON b.document_id = d.document_id
       LEFT JOIN vendors v ON b.vendor_id = v.vendor_id
       LEFT JOIN LATERAL (
         SELECT payment_type, advance_percentage, terms_text
         FROM payment_terms
         WHERE bill_id = b.bill_id
         ORDER BY term_id DESC
         LIMIT 1
       ) pt ON true
       LEFT JOIN LATERAL (
         SELECT due_date
         FROM payment_schedule
         WHERE bill_id = b.bill_id
         ORDER BY due_date ASC
         LIMIT 1
       ) ps ON true
       WHERE d.document_id = $1`,
      [id]
    );

    if (docResult.rows.length === 0) {
      return res.status(404).json({ error: 'Document not found' });
    }

    const document = docResult.rows[0];
    const parsedGemini = safeParseJSON(document.gemini_data);
    if (parsedGemini) {
      document.gemini_data = parsedGemini;
    }
    if (document.bill_payment_method) {
      document.payment_method = document.bill_payment_method;
    } else if (document.document_payment_method) {
      document.payment_method = document.document_payment_method;
    }
    if (document.bill_payment_type || document.bill_advance_percentage || document.bill_payment_due_date || document.bill_payment_terms_text) {
      document.payment_terms = {
        type: document.bill_payment_type || 'FULL',
        advance_percentage: document.bill_advance_percentage,
        due_date: document.bill_payment_due_date,
        description: document.bill_payment_terms_text || null
      };
    }
    const verification = buildVerificationSnapshot(document);
    document.verification = verification;

    let lineItems = [];
    if (document.bill_id) {
      const itemsResult = await pool.query(
        `SELECT description, sku_code, quantity, unit_price, amount, line_number
         FROM bill_items
         WHERE bill_id = $1
         ORDER BY line_number ASC`,
        [document.bill_id]
      );
      lineItems = itemsResult.rows;
    }

    res.json({
      success: true,
      document: {
        ...document,
        line_items: lineItems
      }
    });
  } catch (error) {
    console.error('Get document error:', error);
    res.status(500).json({ error: error.message });
  }
};

const getVerificationSummary = async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT 
         d.document_id,
         d.status,
         d.uploaded_at,
         d.gemini_data,
         d.extraction_state,
         d.quality_score,
         d.verification_status,
         d.raw_text,
         d.bill_date_locked,
         d.total_locked,
         b.bill_date,
         b.total_amount AS bill_total_amount
       FROM documents d
       LEFT JOIN bills b ON b.document_id = d.document_id`
    );

    const summary = {
      verified: 0,
      needs_review: 0,
      processing: 0,
      unverified: 0,
      missing_date: 0,
      missing_total: 0,
      low_quality: 0,
      total: result.rowCount
    };

    for (const row of result.rows) {
      const parsedGemini = safeParseJSON(row.gemini_data);
      if (parsedGemini) {
        row.gemini_data = parsedGemini;
      }

      const snapshot = buildVerificationSnapshot(row);
      summary[snapshot.status] = (summary[snapshot.status] || 0) + 1;

      const gemData = row.gemini_data || {};
      const hasBillDate = Boolean(row.bill_date || gemData.bill_date);
      const explicitTotal = row.bill_total_amount != null ? Number(row.bill_total_amount) : null;
      const aiTotal = gemData?.amounts?.total != null ? Number(gemData.amounts.total) : null;
      const hasTotal = (explicitTotal != null && explicitTotal > 0) || (aiTotal != null && aiTotal > 0);

      if (!hasBillDate) summary.missing_date += 1;
      if (!hasTotal) summary.missing_total += 1;

      const quality = snapshot.quality_score != null
        ? snapshot.quality_score
        : (row.quality_score != null ? Number(row.quality_score) : null);
      if (quality != null && quality < 60) summary.low_quality += 1;
    }

    res.json({
      success: true,
      summary
    });
  } catch (error) {
    console.error('Verification summary error:', error);
    res.status(500).json({ error: error.message });
  }
};

const deleteDocument = async (req, res) => {
  try {
    const { id } = req.params;
    const doc = await pool.query('SELECT file_path, uploaded_by FROM documents WHERE document_id = $1', [id]);
    
    if (doc.rows.length === 0) {
      return res.status(404).json({ error: 'Document not found' });
    }
    const role = req.user?.role || 'uploader';
    const userId = req.user?.userId;
    const ownsDoc = doc.rows[0].uploaded_by === userId;
    const canDeleteAny = role === 'manager' || role === 'admin';
    if (!canDeleteAny && !ownsDoc) {
      return res.status(403).json({ error: 'You can only delete documents you uploaded' });
    }
    
    await pool.query('DELETE FROM documents WHERE document_id = $1', [id]);
    
    if (fs.existsSync(doc.rows[0].file_path)) {
      fs.unlinkSync(doc.rows[0].file_path);
    }
    
    res.json({ success: true, message: 'Document deleted successfully' });
  } catch (error) {
    console.error('Delete document error:', error);
    res.status(500).json({ error: error.message });
  }
};

async function rerunAIForDocuments(req, res) {
  try {
    const role = req.user?.role || 'uploader';
    if (role === 'uploader') {
      return res.status(403).json({ error: 'Only managers/admins can re-run AI processing' });
    }
    const { limit = 50, scope = 'all' } = req.body || {};
    const lim = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 500);
    const conditions = [`COALESCE(d.status, 'uploaded') <> 'deleted'`];
    if (scope === 'pending') {
      conditions.push(`COALESCE(d.status, 'uploaded') IN ('uploaded','processing','manual_required')`);
    } else if (scope === 'missing_dates') {
      conditions.push(`info.bill_date IS NULL`);
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const docsResult = await pool.query(
      `SELECT d.*, 
              info.payment_method AS effective_payment_method,
              info.drop_name AS effective_drop_name,
              info.confidence_score AS bill_confidence,
              info.bill_date AS existing_bill_date
       FROM documents d
       LEFT JOIN LATERAL (
         SELECT payment_method, drop_name, confidence_score, bill_date
         FROM bills
         WHERE document_id = d.document_id
         ORDER BY bill_id DESC
         LIMIT 1
       ) info ON true
       ${where}
       ORDER BY d.uploaded_at DESC
       LIMIT $1`,
      [lim]
    );
    let processed = 0;
    let skipped = 0;
    let datesUpdated = 0;
    let datesStillMissing = 0;
    let flaggedManual = 0;
    let blockedRetry = 0;
    for (const row of docsResult.rows) {
      const gemData = safeParseJSON(row.gemini_data);
      if (gemData) {
        row.gemini_data = gemData;
      }
      const manualLocked =
        (gemData && gemData.manual === true) ||
        (row.bill_confidence && parseFloat(row.bill_confidence) >= 0.99);
      if (!canAttemptReprocess(row)) {
        blockedRetry += 1;
        continue;
      }
      if (manualLocked) {
        skipped += 1;
        continue;
      }
      const rawText = getRawTextFromDoc(row);
      const effectivePayment = row.effective_payment_method || row.payment_method || 'UNSPECIFIED';
      const docPayload = {
        ...row,
        payment_method: effectivePayment,
        drop_name: row.effective_drop_name || null
      };
      const result = await processDocumentWithAI(docPayload, rawText, effectivePayment, {
        actorType: 'system',
        actorId: req.user?.userId || null,
        sourceAction: 'reprocess'
      });
      if (!result || !result.success) {
        flaggedManual += 1;
        continue;
      }
      processed += 1;
      const billCheck = await pool.query(
        'SELECT bill_date FROM bills WHERE document_id = $1',
        [row.document_id]
      );
      if (billCheck.rows.length && billCheck.rows[0].bill_date) {
        datesUpdated += 1;
      } else {
        datesStillMissing += 1;
        flaggedManual += 1;
        await pool.query(
          'UPDATE documents SET status = $1, notes = COALESCE(notes, $2) WHERE document_id = $3',
          ['manual_required', 'Bill date missing after AI re-run', row.document_id]
        );
      }
    }
    res.json({
      success: true,
      scanned: docsResult.rowCount,
      processed,
      skipped_manual: skipped,
      dates_updated: datesUpdated,
      dates_still_missing: datesStillMissing,
      flagged_manual: flaggedManual,
      blocked_retry: blockedRetry
    });
  } catch (error) {
    console.error('Rerun AI error:', error);
    res.status(500).json({ error: error.message });
  }
}

module.exports = {
  upload,
  uploadBill,
  getDocuments,
  getDocument,
  getVerificationSummary,
  deleteDocument,
  rerunAIForDocuments,
  processDocumentWithAI,
  canAttemptReprocess,
  buildVerificationSnapshot
};
