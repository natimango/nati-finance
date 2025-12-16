const pool = require('../config/database');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { preprocessFile } = require('../services/preprocessService');
const mime = require('mime-types');
const sharp = require('sharp');
const { extractWithRules } = require('../services/ruleExtractor');
const { parseInvoiceText } = require('../services/aiParser');
const { normalizeCategory } = require('../utils/categoryMap');

const uploadDir = path.join(__dirname, '../../uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const DEFAULT_JOURNAL_USER_ID = parseInt(process.env.SYSTEM_USER_ID || '1', 10);

function safeParseJSON(value) {
  if (!value) return null;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch (err) {
    return null;
  }
}

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

    // 2. Preprocess (OCR/text extraction) and store raw text
    let rawText = '';
    try {
      const pre = await preprocessFile(file.path, file.mimetype);
      rawText = pre.raw_text || '';
      await pool.query('UPDATE documents SET notes = COALESCE(notes, $1) WHERE document_id = $2', [
        `Preprocessed (${pre.meta?.type || 'unknown'})`, document.document_id
      ]);
      if (rawText) {
        await pool.query('UPDATE documents SET gemini_data = $1 WHERE document_id = $2', [
          JSON.stringify({ raw_text: rawText, preprocess_meta: pre.meta || {} }),
          document.document_id
        ]);
      }
    } catch (err) {
      console.error('Preprocess error:', err.message);
      // Attempt to coerce PDF if MIME is ambiguous
      if (file.mimetype === 'application/octet-stream' && path.extname(file.path).toLowerCase() === '.pdf') {
        try {
          const pre = await preprocessFile(file.path, 'application/pdf');
          rawText = pre.raw_text || '';
          if (rawText) {
            await pool.query('UPDATE documents SET gemini_data = $1 WHERE document_id = $2', [
              JSON.stringify({ raw_text: rawText, preprocess_meta: pre.meta || {} }),
              document.document_id
            ]);
          }
        } catch (pdfErr) {
          console.error('Fallback PDF preprocess failed:', pdfErr.message);
        }
      }
    }

    // 3. AUTO-PROCESS with AI abstraction (background)
    processDocumentWithAI(document, rawText, paymentMethod);
    
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

// Background AI processing with accounting entries
async function processDocumentWithAI(document, rawTextFromPreprocess, paymentMethod = 'UNSPECIFIED') {
  try {
    console.log(`\n🤖 AI Processing: ${document.file_name}`);
    let rawText = rawTextFromPreprocess;

    // If we have no usable text, try preprocessing again
    if (!rawText || rawText.length < 10) {
      try {
        const pre = await preprocessFile(document.file_path, document.file_type);
        rawText = pre.raw_text || '';
      } catch (err) {
        console.error('Re-preprocess error:', err.message);
      }
    }

    if (!rawText || rawText.length < 10) {
      await pool.query(
        'UPDATE documents SET status = $1, notes = COALESCE(notes, $2) WHERE document_id = $3',
        ['manual_required', 'OCR text missing; manual review needed', document.document_id]
      );
      return;
    }
    
    let extraction = await parseInvoiceText(rawText, {
      filePath: document.file_path,
      fileType: document.file_type
    });
    
    if (!extraction.success && rawText) {
      const ruleFallback = extractWithRules(rawText);
      if (ruleFallback && ruleFallback.vendor_name && ruleFallback.amounts?.total) {
        extraction = {
          success: true,
          provider: 'rule',
          data: ruleFallback
        };
      }
    }

    if (!extraction.success) {
      console.error('AI extraction failed:', extraction.error);
      await pool.query(
        'UPDATE documents SET status = $1, notes = COALESCE(notes, $2) WHERE document_id = $3',
        ['manual_required', 'AI extraction failed, manual processing needed', document.document_id]
      );
      return;
    }
    
    let provider = extraction.provider || 'openai';
    const rawData = extraction.data || {};
    if ((!rawData.vendor_name || !rawData.amounts?.total) && rawText) {
      const heuristics = extractWithRules(rawText);
      if (heuristics && heuristics.vendor_name && heuristics.amounts?.total) {
        rawData.vendor_name = rawData.vendor_name || heuristics.vendor_name;
        rawData.bill_date = rawData.bill_date || heuristics.bill_date;
        rawData.amounts = rawData.amounts || {};
        rawData.amounts.total = rawData.amounts.total || heuristics.amounts.total;
        rawData.amounts.subtotal = rawData.amounts.subtotal || heuristics.amounts.subtotal;
        provider = provider === 'openai' ? 'hybrid' : 'rule';
      }
    }
    const vendorName =
      rawData.vendor_name ||
      rawData.vendor ||
      rawData.supplier ||
      rawData.merchant ||
      null;
    const totalAmount = Number(
      rawData?.amounts?.total ??
      rawData.total_amount ??
      rawData.amount ??
      rawData.total ??
      0
    );

    if (!vendorName || !totalAmount || Number.isNaN(totalAmount)) {
      await pool.query(
        'UPDATE documents SET status = $1, notes = COALESCE(notes, $2) WHERE document_id = $3',
        ['manual_required', 'AI could not extract vendor/total reliably', document.document_id]
      );
      return;
    }

    const data = {
      vendor_name: vendorName,
      bill_number: rawData.bill_number || null,
      bill_date: rawData.bill_date || null,
      amounts: {
        subtotal: totalAmount,
        tax_amount: 0,
        total: totalAmount
      },
      payment_terms: null,
      _provider: provider,
      _fallback: provider !== 'openai'
    };
    console.log('✓ Extracted:', data.vendor_name, '₹' + data.amounts.total);

    // Respect user-selected category first; AI suggestion only fills gaps
    const chosenCategory = document.document_category || data.category || 'misc';
    const categoryInfo = normalizeCategory(chosenCategory);
    data.category = categoryInfo.category;
    data.category_group = categoryInfo.category_group;
    const effectiveCategory = categoryInfo.category;
    if (!['fabric', 'manufacturing'].includes(effectiveCategory)) {
      if (data.line_items) delete data.line_items;
    }
    
    // Normalize payment and drop
    const effectivePayment = paymentMethod || document.payment_method || 'UNSPECIFIED';
    const dropName = document.drop_name || null;

    // Update document with extracted data
    await pool.query(
      'UPDATE documents SET gemini_data = $1, status = $2, payment_method = COALESCE(payment_method, $3) WHERE document_id = $4',
      [JSON.stringify(data), 'processed', effectivePayment, document.document_id]
    );
    
    // Create/update vendor
    let vendorId = await createOrUpdateVendor(data);
    
    // Upsert bill for this document
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
       RETURNING bill_id`,
      [
        document.document_id, vendorId, data.bill_number || null, data.bill_date || new Date(),
        data.amounts?.subtotal || 0, data.amounts?.tax_amount || 0, data.amounts?.total || 0,
        data.category || document.document_category || 'misc',
        categoryInfo.category_group,
        dropName,
        data.confidence || 0.8,
        'approved', 'pending', effectivePayment
      ]
    );
    const billId = billUpsert.rows[0].bill_id;
    
    // Replace line items
    await pool.query('DELETE FROM bill_items WHERE bill_id = $1', [billId]);
    
    // Save line items
    if (data.line_items && data.line_items.length > 0) {
      for (let i = 0; i < data.line_items.length; i++) {
        const item = data.line_items[i];
        await pool.query(
          `INSERT INTO bill_items (bill_id, description, quantity, unit_price, amount, line_number)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [billId, item.description, item.quantity || 0, item.rate || 0, item.amount || 0, i + 1]
        );
      }
    }
    
    // Create payment terms/schedule and determine payment status
    const scheduleCreated = await createPaymentSchedule(billId, {
      bill_date: data.bill_date || document.bill_date,
      amounts: data.amounts || { total: data.total_amount || 0 },
      payment_terms: data.payment_terms
    });
    const paymentStatus = scheduleCreated ? 'pending' : 'paid';
    await pool.query('UPDATE bills SET payment_status = $1 WHERE bill_id = $2', [paymentStatus, billId]);
    
    // 🎯 CREATE ACCOUNTING ENTRIES (Double Entry)
    await createAccountingEntries(
      billId,
      data,
      vendorId,
      { createdBy: resolveJournalUser(document.uploaded_by) }
    );
    
    console.log('✅ Complete: Bill recorded with accounting entries\n');
    
  } catch (error) {
    console.error('AI Processing error:', error);
    await pool.query(
      'UPDATE documents SET status = $1, notes = COALESCE(notes, $2) WHERE document_id = $3',
      ['manual_required', 'AI extraction failed, manual processing needed', document.document_id]
    );
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
        ps.due_date AS bill_payment_due_date
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
      return {
        ...row,
        can_delete: canManageAll || ownsDoc,
        can_manual: canManageAll,
        can_process: canManageAll
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

module.exports = {
  upload,
  uploadBill,
  getDocuments,
  getDocument,
  deleteDocument
};
