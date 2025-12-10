const pool = require('../config/database');
const { parseInvoiceText } = require('../services/aiParser');
const { preprocessFile } = require('../services/preprocessService');
const fs = require('fs');
const path = require('path');
const { normalizeCategory } = require('../utils/categoryMap');

const DEFAULT_JOURNAL_USER_ID = parseInt(process.env.SYSTEM_USER_ID || '1', 10);
const resolveJournalUser = (preferred) => preferred || DEFAULT_JOURNAL_USER_ID;

function validateDimensions(category, dropName, channel, campaign) {
  const isCOGS = false; // drop/channel validation removed
  return null;
}

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

// Process bill with AI (OpenAI primary, heuristic fallback)
async function processBillWithAI(req, res) {
  try {
    const { document_id } = req.params;
    const { drop_name, trip_name, channel, campaign, department, tags, payment_method } = req.body || {};
    const paymentMethod = (payment_method || 'UNSPECIFIED').toUpperCase();
    let rawTextHint = null;
    let tagsValue = null;
    if (Array.isArray(tags)) {
      tagsValue = tags;
    } else if (typeof tags === 'string') {
      tagsValue = tags.split(',').map(t => t.trim()).filter(Boolean);
    }
    
    // Get document info
    const docResult = await pool.query(
      'SELECT * FROM documents WHERE document_id = $1',
      [document_id]
    );
    
    if (docResult.rows.length === 0) {
      return res.status(404).json({ error: 'Document not found' });
    }
    
    const document = docResult.rows[0];

    // Try to reuse preprocessed raw text if present
    if (document.gemini_data && document.gemini_data.raw_text) {
      rawTextHint = document.gemini_data.raw_text;
    } else if (typeof document.gemini_data === 'string') {
      try {
        const parsed = JSON.parse(document.gemini_data);
        if (parsed.raw_text) rawTextHint = parsed.raw_text;
      } catch (_) {}
    }
    // If no raw text cached, preprocess now to get text for heuristic fallback
    if (!rawTextHint) {
      try {
        const pre = await preprocessFile(document.file_path, document.file_type);
        rawTextHint = pre.raw_text || null;
      } catch (err) {
        console.error('Preprocess (processBillWithAI) error:', err.message);
      }
    }
    if (!rawTextHint || rawTextHint.length < 10) {
      await pool.query(
        'UPDATE documents SET status = $1, notes = COALESCE(notes, $2) WHERE document_id = $3',
        ['manual_required', 'OCR text missing; manual review needed', document_id]
      );
      return res.status(400).json({ error: 'OCR text missing; manual review needed' });
    }
    
    // Extract data using AI
    console.log('Processing with AI:', document.file_name);
    let extraction = await parseInvoiceText(rawTextHint, {
      filePath: document.file_path,
      fileType: document.file_type
    });

    if (!extraction || !extraction.success) {
      // Mark document for manual processing if AI fails
      await pool.query(
        'UPDATE documents SET status = $1, notes = COALESCE(notes, $2) WHERE document_id = $3',
        ['manual_required', 'AI extraction failed, manual processing needed', document_id]
      );
      return res.status(500).json({ error: 'AI extraction failed', details: extraction?.error });
    }
    
    const provider = extraction.provider || 'openai';
    const data = { 
      ...extraction.data, 
      _provider: provider, 
      _fallback: provider !== 'openai' 
    };

    const dimError = validateDimensions(
      data.category || document.document_category,
      drop_name || data.drop_name,
      channel || data.channel,
      campaign || data.campaign
    );
    if (dimError) {
      await pool.query(
        'UPDATE documents SET status = $1, notes = COALESCE(notes, $2) WHERE document_id = $3',
        ['manual_required', dimError, document_id]
      );
      return res.status(400).json({ error: dimError });
    }
    
    // Update document with extracted data
    await pool.query(
      'UPDATE documents SET gemini_data = $1, status = $2 WHERE document_id = $3',
      [JSON.stringify(data), 'processed', document_id]
    );
    
    // Create or update vendor
    let vendorId = null;
    if (data.vendor_name) {
      const vendorResult = await pool.query(
        `INSERT INTO vendors (vendor_name, gstin, pan, address, contact_person, vendor_type)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (vendor_code) DO UPDATE SET vendor_name = EXCLUDED.vendor_name
         RETURNING vendor_id`,
        [
          data.vendor_name,
          data.vendor_gstin || null,
          data.vendor_pan || null,
          data.vendor_address || null,
          data.vendor_contact || null,
          data.category || 'vendor'
        ]
      );
      vendorId = vendorResult.rows[0]?.vendor_id || null;
    }
    
    // Create bill entry
    const billResult = await pool.query(
      `INSERT INTO bills 
       (document_id, vendor_id, bill_number, bill_date, subtotal, tax_amount, total_amount, 
        category, confidence_score, status, drop_name, trip_name, channel, campaign, department, tags, payment_method, payment_status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16::jsonb, $17, $18)
       RETURNING bill_id`,
      [
        document_id,
        vendorId,
        data.bill_number || null,
        data.bill_date || null,
        data.amounts?.subtotal || 0,
        data.amounts?.tax_amount || 0,
        data.amounts?.total || 0,
        data.category || 'misc',
        data.confidence || 0.8,
        'pending',
        drop_name || data.drop_name || null,
        trip_name || data.trip_name || null,
        channel || data.channel || null,
        campaign || data.campaign || null,
        department || data.department || null,
        tagsValue ? JSON.stringify(tagsValue) : (data.tags ? JSON.stringify(data.tags) : null),
        paymentMethod,
        'pending'
      ]
    );
    
    const billId = billResult.rows[0].bill_id;
    
    const aiScheduleCreated = await createPaymentSchedule(billId, {
      bill_date: data.bill_date,
      amounts: data.amounts || { total: data.total_amount || 0 },
      payment_terms: data.payment_terms
    });
    const aiPaymentStatus = aiScheduleCreated ? 'pending' : 'paid';
    await pool.query('UPDATE bills SET payment_status = $1 WHERE bill_id = $2', [aiPaymentStatus, billId]);
    
    // Save line items
    if (data.line_items && data.line_items.length > 0) {
      for (let i = 0; i < data.line_items.length; i++) {
        const item = data.line_items[i];
        await pool.query(
          `INSERT INTO bill_items (bill_id, description, quantity, unit_price, amount, line_number)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [billId, item.description, item.quantity, item.rate, item.amount, i + 1]
        );
      }
    }
    
    res.json({
      success: true,
      message: 'Bill processed successfully',
      bill_id: billId,
      extracted_data: data
    });
    
  } catch (error) {
    console.error('Bill processing error:', error);
    res.status(500).json({ error: error.message });
  }
}

// Import bank PDF with password and auto-match (non-cash)
async function importBankPDF(req, res) {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'PDF file is required (field name: file)' });
    }
    const password = req.body?.password || '';
    const text = await parsePdfBuffer(req.file.buffer, password);
    if (!text || text.length < 10) {
      return res.status(400).json({ error: 'Could not extract text from PDF (check password)' });
    }
    const rows = parseBankTextStrict(text);
    const matches = [];
    const unmatched = [];

    for (const row of rows) {
      const amount = Math.abs(row.amount || 0);
      if (!amount) {
        unmatched.push({ ...row, reason: 'Amount missing/zero' });
        continue;
      }
      const match = await findScheduleMatch(amount);
      if (!match) {
        unmatched.push({ ...row, reason: 'No schedule match' });
        continue;
      }
      // Record payment
      const paymentResult = await pool.query(
        `INSERT INTO payments (bill_id, schedule_id, payment_date, amount_paid, payment_method, notes, reference_number, recorded_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING payment_id`,
        [
          match.bill_id,
          match.schedule_id,
          row.date || new Date(),
          amount,
          'BANK_IMPORT',
          row.description || row.reference || null,
          row.reference || null,
          1
        ]
      );
      await pool.query(
        `UPDATE payment_schedule 
         SET amount_paid = amount_paid + $1,
             payment_status = CASE 
               WHEN amount_paid + $1 >= amount_due THEN 'PAID'
               ELSE 'PARTIAL'
             END
         WHERE schedule_id = $2`,
        [amount, match.schedule_id]
      );
      matches.push({
        payment_id: paymentResult.rows[0].payment_id,
        schedule_id: match.schedule_id,
        bill_id: match.bill_id,
        amount,
        withdrawal: row.withdrawal,
        deposit: row.deposit,
        balance: row.balance,
        reference: row.reference,
        description: row.description
      });
    }

    res.json({
      success: true,
      matched: matches.length,
      unmatched: unmatched.length,
      matches,
      unmatched
    });
  } catch (error) {
    console.error('Bank PDF import error:', error);
    res.status(500).json({ error: error.message });
  }
}

async function parsePdfBuffer(buffer, password) {
  // Try pdfjs-dist first (position-aware), then pdf-parse, then OCR fallback.
  let text = '';
  try {
    const pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const uint8Data = Buffer.isBuffer(buffer)
      ? new Uint8Array(buffer)
      : buffer instanceof Uint8Array
        ? buffer
        : new Uint8Array(buffer.buffer || buffer, buffer.byteOffset || 0, buffer.byteLength || buffer.length);
    const loadingTask = pdfjsLib.getDocument({
      data: uint8Data,
      password: password || undefined,
      useSystemFonts: true
    });
    const pdfDoc = await loadingTask.promise;
    for (let i = 1; i <= pdfDoc.numPages; i++) {
      const page = await pdfDoc.getPage(i);
      const content = await page.getTextContent({ normalizeWhitespace: true, disableCombineTextItems: false });
      const lines = [];
      for (const item of content.items) {
        const y = Math.round(item.transform[5]);
        const x = Math.round(item.transform[4]);
        lines.push({ y, x, str: (item.str || '').trim() });
      }
      const grouped = lines.reduce((acc, item) => {
        if (!item.str) return acc;
        const key = item.y;
        if (!acc[key]) acc[key] = [];
        acc[key].push(item);
        return acc;
      }, {});
      const sortedLines = Object.keys(grouped)
        .map(y => ({ y: Number(y), parts: grouped[y].sort((a, b) => a.x - b.x) }))
        .sort((a, b) => b.y - a.y);
      const pageText = sortedLines.map(line => line.parts.map(p => p.str).join(' ')).join('\n');
      text += pageText + '\n';
    }
  } catch (err) {
    console.error('pdfjs parse error:', err.message);
  }

  if (!text || text.trim().length < 20) {
    try {
      const pdfParse = require('pdf-parse');
      const parsed = await pdfParse(buffer, { password: password || undefined });
      if (parsed && parsed.text && parsed.text.trim().length > 10) {
        text = parsed.text;
      }
    } catch (err) {
      console.error('pdf-parse fallback error:', err.message);
    }
  }

  if (!text || text.trim().length < 20) {
    const tmpPath = path.join(__dirname, `../../uploads/tmp-bank-${Date.now()}.pdf`);
    fs.writeFileSync(tmpPath, Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer));
    try {
      const pre = await preprocessFile(tmpPath, 'application/pdf');
      if (pre && pre.raw_text) return pre.raw_text;
    } finally {
      fs.unlink(tmpPath, () => {});
    }
  }
  return text;
}

function parseBankText(text) {
  const lines = text.split('\n')
    .map(l => l.trim().replace(/\s+/g, ' '))
    .filter(Boolean);
  const rows = [];
  const seen = new Set();
  for (const line of lines) {
    // Skip obvious headers/summaries to avoid hallucinated rows.
    if (/(date\s*amount\s*ref|statement of account|opening balance|closing balance|available balance|summary|page \d+)/i.test(line)) continue;
    // Require a date near the start of the line.
    const dateMatch = line.match(/^(\d{1,2}[./-]\d{1,2}[./-]\d{2,4}|\d{4}[./-]\d{1,2}[./-]\d{1,2})\b/);
    if (!dateMatch) continue;
    const cleaned = line.replace(/,/g, '');
    const numberMatches = [...cleaned.matchAll(/-?\d+(?:\.\d+)?/g)];
    if (!numberMatches.length) continue;

    // Try to pick the transaction amount (not balance).
    let amount = null;
    // Look for explicit DR/CR markers near numbers.
    const drcrMatch = cleaned.match(/(-?\d+(?:\.\d+)?)[ ]*(DR|CR|Cr|Dr|D|C)\b/);
    if (drcrMatch) {
      amount = parseFloat(drcrMatch[1]);
      if (drcrMatch[2].toUpperCase().startsWith('D')) amount = -Math.abs(amount);
    }
    // If two or more numbers and no DR/CR, prefer the first non-date number as txn and assume the last is balance.
    if (amount === null && numberMatches.length >= 2) {
      const nums = numberMatches.map(m => parseFloat(m[0])).filter(n => !Number.isNaN(n));
      if (nums.length >= 2) {
        amount = nums[0];
      }
    }
    // Fallback: use the last number.
    if (amount === null) {
      amount = parseFloat(numberMatches[numberMatches.length - 1][0]);
    }
    if (Number.isNaN(amount)) continue;

    // Capture a short reference without the chosen amount token.
    let amountToken = numberMatches[numberMatches.length - 1][0];
    if (drcrMatch) {
      amountToken = drcrMatch[1];
    } else if (numberMatches.length >= 2) {
      amountToken = numberMatches[0][0];
    }
    const ref = line.includes(amountToken)
      ? line.slice(line.indexOf(dateMatch[1]) + dateMatch[1].length).replace(amountToken, '').trim()
      : line.substring(0, 80);
    const key = `${dateMatch[1]}_${amount}_${ref}`;
    if (seen.has(key)) continue;
    seen.add(key);

    rows.push({
      date: dateMatch[1],
      amount,
      reference: ref || line.substring(0, 80),
      description: line.substring(0, 160)
    });
  }
  return rows;
}

// Deterministic parser: date at start + first number as txn amount.
function parseBankTextStrict(text) {
  const lines = text.split('\n')
    .map(l => l.trim().replace(/\s+/g, ' '))
    .filter(Boolean);
  const rows = [];
  const seen = new Set();
  for (const line of lines) {
    if (!line) continue;
    if (/(opening balance|closing balance|available balance|page \d+)/i.test(line)) continue;
    const dateMatch = line.match(/^(\d{1,2}[./-]\d{1,2}[./-]\d{2,4}|\d{4}[./-]\d{1,2}[./-]\d{1,2})\b/);
    if (!dateMatch) continue;
    const cleaned = line.replace(/,/g, '').replace(/₹/gi, '').replace(/\b(rs|inr)\b/gi, '');
    const rest = cleaned.slice(dateMatch[0].length).trim();

    // Capture numeric tokens (with commas) and pick the last three as balance/deposit/withdrawal.
    const numberMatches = [...rest.matchAll(/-?\d[\d,]*(?:\.\d+)?/g)];
    if (!numberMatches.length) continue;
    let balanceTok = null;
    let depositTok = null;
    let withdrawalTok = null;

    if (numberMatches.length >= 3) {
      balanceTok = numberMatches[numberMatches.length - 1][0];
      depositTok = numberMatches[numberMatches.length - 2][0];
      withdrawalTok = numberMatches[numberMatches.length - 3][0];
    } else if (numberMatches.length === 2) {
      // Assume: [amount] [balance]
      withdrawalTok = numberMatches[0][0];
      balanceTok = numberMatches[1][0];
    } else {
      // Single number -> treat as amount/withdrawal
      withdrawalTok = numberMatches[0][0];
    }

    const balance = balanceTok ? parseFloat(balanceTok.replace(/,/g, '')) : null;
    const deposit = depositTok ? parseFloat(depositTok.replace(/,/g, '')) : null;
    const withdrawal = withdrawalTok ? parseFloat(withdrawalTok.replace(/,/g, '')) : null;

    // Decide amount: prefer withdrawal when present/non-zero, else deposit.
    let amount = null;
    const hasWithdrawal = withdrawal !== null && !Number.isNaN(withdrawal) && withdrawal !== 0;
    const hasDeposit = deposit !== null && !Number.isNaN(deposit) && deposit !== 0;

    if (hasWithdrawal) {
      amount = -Math.abs(withdrawal);
    } else if (hasDeposit) {
      amount = Math.abs(deposit);
    } else if (withdrawal !== null && !Number.isNaN(withdrawal)) {
      // Two-number rows with a single amount: default to withdrawal to avoid missing debits.
      amount = -Math.abs(withdrawal);
    } else {
      continue; // nothing usable
    }

    // Reference: remove the numeric tokens (withdrawal/deposit/balance) from the tail, keep particulars.
    let refText = rest;
    if (withdrawalTok) refText = refText.replace(withdrawalTok, '');
    if (depositTok) refText = refText.replace(depositTok, '');
    refText = refText.replace(balanceTok, '');
    const referenceText = refText
      .replace(/\b\d{1,2}[./-]\d{1,2}[./-]\d{2,4}\b/g, '') // dates
      .replace(/-?\d[\d,]*(?:\.\d+)?/g, '') // numbers
      .replace(/₹/gi, '')
      .replace(/\b(rs|inr)\b/gi, '')
      .replace(/\s+/g, ' ')
      .trim();

    if (Number.isNaN(amount)) continue;

    const key = `${dateMatch[1]}_${amount}_${referenceText}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({
      date: dateMatch[1],
      amount,
      withdrawal: !Number.isNaN(withdrawal) ? withdrawal : null,
      deposit: !Number.isNaN(deposit) ? deposit : null,
      balance: !Number.isNaN(balance) ? balance : null,
      reference: referenceText || '',
      description: referenceText || ''
    });
  }
  return rows;
}
// Manual processing when AI is unavailable or needs override
async function processBillManual(req, res) {
  const { document_id } = req.params;
    const {
      vendor_name,
    vendor_gstin,
    vendor_pan,
    vendor_address,
    vendor_contact,
    bill_number,
    bill_date,
    category,
    drop_name,
    trip_name,
    channel,
    campaign,
      department,
      tags,
      subtotal,
    tax_amount,
    total_amount,
    payment_terms,
    line_items = [],
    notes,
    payment_method
  } = req.body;

  try {
    // Validate document
    const docResult = await pool.query(
      'SELECT * FROM documents WHERE document_id = $1',
      [document_id]
    );
    if (docResult.rows.length === 0) {
      return res.status(404).json({ error: 'Document not found' });
    }
    const document = docResult.rows[0];

    if (!vendor_name) {
      return res.status(400).json({ error: 'vendor_name is required for manual processing' });
    }
    if (!total_amount || Number(total_amount) <= 0) {
      return res.status(400).json({ error: 'total_amount must be provided and greater than zero' });
    }
    const normalizedPayment = (payment_method || '').toUpperCase();
    if (!normalizedPayment || normalizedPayment === 'UNSPECIFIED') {
      return res.status(400).json({ error: 'payment_method is required' });
    }
    if (!category && !document.document_category) {
      return res.status(400).json({ error: 'category is required' });
    }

    if (payment_terms?.type === 'ADVANCE') {
      const adv = Number(payment_terms.advance_percentage || 0);
      if (!adv || adv <= 0) {
        return res.status(400).json({ error: 'Advance payment terms require an advance percentage' });
      }
      if (!payment_terms.due_date) {
        return res.status(400).json({ error: 'Advance payment terms require a due date for the balance' });
      }
    }

    const categoryInfo = normalizeCategory(category || document.document_category || 'misc');
    const normalizedCategory = categoryInfo.category;
    const categoryGroup = categoryInfo.category_group;

    const dimError = validateDimensions(normalizedCategory, drop_name, channel, campaign);
    if (dimError) {
      await pool.query(
        'UPDATE documents SET status = $1, notes = COALESCE(notes, $2) WHERE document_id = $3',
        ['manual_required', dimError, document_id]
      );
      return res.status(400).json({ error: dimError });
    }

    // Create or update vendor
    let vendorId = null;
    const vendorResult = await pool.query(
      `INSERT INTO vendors (vendor_name, vendor_code, gstin, pan, address, phone, vendor_type, is_active)
       VALUES ($1, $2, $3, $4, $5, $6, $7, true)
       ON CONFLICT (vendor_code) DO UPDATE SET vendor_name = EXCLUDED.vendor_name, gstin = EXCLUDED.gstin
       RETURNING vendor_id`,
      [
        vendor_name,
        vendor_name.toUpperCase().replace(/[^A-Z0-9]/g, '').substring(0, 10),
        vendor_gstin || null,
        vendor_pan || null,
        vendor_address || null,
        vendor_contact || null,
        normalizedCategory || 'vendor'
      ]
    );
    vendorId = vendorResult.rows[0]?.vendor_id || null;

    // Normalize tags to JSON array
    let tagsValue = null;
    if (Array.isArray(tags)) {
      tagsValue = tags;
    } else if (typeof tags === 'string') {
      tagsValue = tags.split(',').map(t => t.trim()).filter(Boolean);
    }

    // Upsert bill (if a bill already exists for this document_id, update it instead of creating a duplicate)
    const existingBill = await pool.query('SELECT bill_id FROM bills WHERE document_id = $1', [document_id]);
    let billId = null;
    if (existingBill.rows.length > 0) {
      billId = existingBill.rows[0].bill_id;
      await pool.query(
        `UPDATE bills SET 
           vendor_id = $1,
           bill_number = $2,
           bill_date = $3,
           subtotal = $4,
           tax_amount = $5,
           total_amount = $6,
           category = $7,
           category_group = $8,
           confidence_score = $9,
           status = $10,
           payment_status = $11,
           drop_name = $12,
           trip_name = $13,
           channel = $14,
           campaign = $15,
           department = $16,
           tags = $17::jsonb,
           payment_method = $18
         WHERE bill_id = $19`,
        [
          vendorId,
          bill_number || null,
          bill_date || null,
          subtotal || 0,
          tax_amount || 0,
          total_amount,
          normalizedCategory || 'misc',
          categoryGroup,
          1.0, // manual entry confidence
          'approved',
          'pending',
          drop_name || null,
          trip_name || null,
          channel || null,
          campaign || null,
          department || null,
          tagsValue ? JSON.stringify(tagsValue) : null,
          normalizedPayment,
          billId
        ]
      );
      // Clear old line items so we can replace with the manual ones
      await pool.query('DELETE FROM bill_items WHERE bill_id = $1', [billId]);
    } else {
      const billResult = await pool.query(
        `INSERT INTO bills 
         (document_id, vendor_id, bill_number, bill_date, subtotal, tax_amount, total_amount, 
          category, category_group, confidence_score, status, payment_status, drop_name, trip_name, channel, campaign, department, tags, payment_method)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18::jsonb, $19)
         RETURNING bill_id`,
        [
          document_id,
          vendorId,
          bill_number || null,
          bill_date || null,
          subtotal || 0,
          tax_amount || 0,
          total_amount,
          normalizedCategory || 'misc',
          categoryGroup,
          1.0, // manual entry confidence
          'approved',
          'pending',
          drop_name || null,
          trip_name || null,
          channel || null,
          campaign || null,
          department || null,
          tagsValue ? JSON.stringify(tagsValue) : null,
          normalizedPayment
        ]
      );
      billId = billResult.rows[0].bill_id;
    }

    const manualScheduleCreated = await createPaymentSchedule(billId, {
      bill_date,
      amounts: { total: total_amount },
      payment_terms
    });
    const manualPaymentStatus = manualScheduleCreated ? 'pending' : 'paid';
    await pool.query('UPDATE bills SET payment_status = $1 WHERE bill_id = $2', [manualPaymentStatus, billId]);

    // Save line items
    if (Array.isArray(line_items) && line_items.length > 0) {
      for (let i = 0; i < line_items.length; i++) {
        const item = line_items[i];
        await pool.query(
          `INSERT INTO bill_items (bill_id, description, sku_code, quantity, unit_price, amount, line_number)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [
            billId,
            item.description || 'Line item',
            item.sku_code || null,
            item.quantity || 0,
            item.rate || 0,
            item.amount || 0,
            i + 1
          ]
        );
      }
    }

    // Create accounting entries
    await createAccountingEntries(billId, {
      vendor_name,
      bill_number,
      bill_date,
      category: normalizedCategory,
      category_group: categoryGroup,
      amounts: {
        subtotal: subtotal || 0,
        tax_amount: tax_amount || 0,
        total: total_amount
      }
    }, vendorId, { createdBy: resolveJournalUser(req.user?.userId || null) });

    // Update document status and stash manual data
    await pool.query(
      `UPDATE documents 
       SET status = $1, gemini_data = $2, notes = COALESCE($3, notes)
       WHERE document_id = $4`,
      [
        'processed',
        JSON.stringify({
          manual: true,
          vendor_name,
          bill_number,
          bill_date,
          category: normalizedCategory,
          category_group: categoryGroup,
          drop_name,
          trip_name,
          channel,
          campaign,
          department,
          amounts: { subtotal, tax_amount, total: total_amount },
          line_items,
          payment_terms: payment_terms || null
        }),
        notes || null,
        document_id
      ]
    );

    res.json({
      success: true,
      message: 'Bill processed manually',
      bill_id: billId,
      vendor_id: vendorId
    });
  } catch (error) {
    console.error('Manual bill processing error:', error);
    res.status(500).json({ error: error.message });
  }
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

// Double-entry accounting for a bill
async function createAccountingEntries(billId, data, vendorId, options = {}) {
  const category = data.category || 'misc';
  const subtotal = data.amounts?.subtotal || 0;
  const taxAmount = data.amounts?.tax_amount || 0;
  const total = data.amounts?.total || 0;
  const createdBy = resolveJournalUser(options.createdBy || data.created_by || null);

  const expenseAccount = await getGLAccount(category);
  const inputTaxAccount = await getGLAccount('input_tax');
  const payableAccount = await getGLAccount('accounts_payable');

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

  // Debit: Expense
  await pool.query(
    `INSERT INTO journal_entry_lines (journal_id, account_id, debit_amount, credit_amount, description, line_number)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [journalId, expenseAccount, subtotal, 0, `${category} expense`, 1]
  );

  // Debit: Input Tax (if any)
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

// Get payment dashboard
async function getPaymentDashboard(req, res) {
  try {
    const today = new Date().toISOString().split('T')[0];
    const next7Days = new Date(Date.now() + 7*24*60*60*1000).toISOString().split('T')[0];
    const next30Days = new Date(Date.now() + 30*24*60*60*1000).toISOString().split('T')[0];
    
    // Overdue payments
    const overdue = await pool.query(`
      SELECT ps.*, b.bill_number, v.vendor_name, b.total_amount
      FROM payment_schedule ps
      JOIN bills b ON ps.bill_id = b.bill_id
      LEFT JOIN vendors v ON b.vendor_id = v.vendor_id
      WHERE ps.payment_status IN ('PENDING', 'PARTIAL')
      AND ps.due_date < $1
      ORDER BY ps.due_date ASC
    `, [today]);
    
    // Due this week
    const thisWeek = await pool.query(`
      SELECT ps.*, b.bill_number, v.vendor_name, b.total_amount
      FROM payment_schedule ps
      JOIN bills b ON ps.bill_id = b.bill_id
      LEFT JOIN vendors v ON b.vendor_id = v.vendor_id
      WHERE ps.payment_status IN ('PENDING', 'PARTIAL')
      AND ps.due_date >= $1 AND ps.due_date <= $2
      ORDER BY ps.due_date ASC
    `, [today, next7Days]);
    
    // Due this month
    const thisMonth = await pool.query(`
      SELECT ps.*, b.bill_number, v.vendor_name, b.total_amount
      FROM payment_schedule ps
      JOIN bills b ON ps.bill_id = b.bill_id
      LEFT JOIN vendors v ON b.vendor_id = v.vendor_id
      WHERE ps.payment_status IN ('PENDING', 'PARTIAL')
      AND ps.due_date > $1 AND ps.due_date <= $2
      ORDER BY ps.due_date ASC
    `, [next7Days, next30Days]);
    
    // Cash outflow forecast
    const forecast7Days = await pool.query(`
      SELECT SUM(amount_due - amount_paid) as total
      FROM payment_schedule
      WHERE payment_status IN ('PENDING', 'PARTIAL')
      AND due_date >= $1 AND due_date <= $2
    `, [today, next7Days]);
    
    const forecast30Days = await pool.query(`
      SELECT SUM(amount_due - amount_paid) as total
      FROM payment_schedule
      WHERE payment_status IN ('PENDING', 'PARTIAL')
      AND due_date >= $1 AND due_date <= $2
    `, [today, next30Days]);
    
    res.json({
      success: true,
      overdue: overdue.rows,
      due_this_week: thisWeek.rows,
      due_this_month: thisMonth.rows,
      forecast: {
        next_7_days: parseFloat(forecast7Days.rows[0].total || 0),
        next_30_days: parseFloat(forecast30Days.rows[0].total || 0)
      }
    });
    
  } catch (error) {
    console.error('Dashboard error:', error);
    res.status(500).json({ error: error.message });
  }
}

// Record a payment
async function recordPayment(req, res) {
  try {
    const { bill_id, schedule_id, amount, payment_date, payment_method, notes } = req.body;
    const method = (payment_method || 'OTHER').toUpperCase();
    
    // Record payment
    const paymentResult = await pool.query(
      `INSERT INTO payments (bill_id, schedule_id, payment_date, amount_paid, payment_method, notes, recorded_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING payment_id`,
      [bill_id, schedule_id, payment_date, amount, method, notes, 1]
    );
    
    // Update payment schedule
    await pool.query(
      `UPDATE payment_schedule 
       SET amount_paid = amount_paid + $1,
           payment_status = CASE 
             WHEN amount_paid + $1 >= amount_due THEN 'PAID'
             ELSE 'PARTIAL'
           END
       WHERE schedule_id = $2`,
      [amount, schedule_id]
    );
    
    res.json({
      success: true,
      payment_id: paymentResult.rows[0].payment_id,
      message: 'Payment recorded successfully'
    });
    
  } catch (error) {
    console.error('Payment recording error:', error);
    res.status(500).json({ error: error.message });
  }
}

// Record payment against earliest pending schedule for a bill (simple mode)
async function recordSimplePayment(req, res) {
  try {
    const { bill_id, amount, payment_date, payment_method, notes } = req.body;
    const method = (payment_method || 'OTHER').toUpperCase();
    if (!bill_id || !amount) {
      return res.status(400).json({ error: 'bill_id and amount are required' });
    }

    const sched = await pool.query(
      `SELECT schedule_id, amount_due, amount_paid
       FROM payment_schedule
       WHERE bill_id = $1 AND payment_status IN ('PENDING','PARTIAL')
       ORDER BY due_date ASC
       LIMIT 1`,
      [bill_id]
    );
    if (sched.rows.length === 0) {
      return res.status(404).json({ error: 'No pending schedule for this bill' });
    }
    const schedule_id = sched.rows[0].schedule_id;

    const paymentResult = await pool.query(
      `INSERT INTO payments (bill_id, schedule_id, payment_date, amount_paid, payment_method, notes, recorded_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING payment_id`,
      [bill_id, schedule_id, payment_date, amount, method, notes, 1]
    );

    await pool.query(
      `UPDATE payment_schedule 
       SET amount_paid = amount_paid + $1,
           payment_status = CASE 
             WHEN amount_paid + $1 >= amount_due THEN 'PAID'
             ELSE 'PARTIAL'
           END
       WHERE schedule_id = $2`,
      [amount, schedule_id]
    );

    res.json({
      success: true,
      payment_id: paymentResult.rows[0].payment_id,
      message: 'Payment recorded successfully'
    });
  } catch (error) {
    console.error('Simple payment error:', error);
    res.status(500).json({ error: error.message });
  }
}

// Import bank CSV and auto-match to payment schedules
async function importBankCSV(req, res) {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'CSV file is required (field name: file)' });
    }

    const csvText = req.file.buffer.toString('utf8');
    const rows = parseCSV(csvText);
    const matches = [];
    const unmatched = [];

    for (const row of rows) {
      // Consider only debits/outflows (amount > 0)
      const amount = Math.abs(row.amount || 0);
      if (!amount) {
        unmatched.push({ ...row, reason: 'Amount missing/zero' });
        continue;
      }
      const match = await findScheduleMatch(amount, true);
      if (!match) {
        unmatched.push({ ...row, reason: 'No schedule match' });
        continue;
      }

      // Record payment
      const paymentResult = await pool.query(
        `INSERT INTO payments (bill_id, schedule_id, payment_date, amount_paid, payment_method, notes, reference_number, recorded_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING payment_id`,
        [
          match.bill_id,
          match.schedule_id,
          row.date || new Date(),
          amount,
          'BANK_IMPORT',
          row.description || row.reference || null,
          row.reference || null,
          1
        ]
      );

      // Update schedule
      await pool.query(
        `UPDATE payment_schedule 
         SET amount_paid = amount_paid + $1,
             payment_status = CASE 
               WHEN amount_paid + $1 >= amount_due THEN 'PAID'
               ELSE 'PARTIAL'
             END
         WHERE schedule_id = $2`,
        [amount, match.schedule_id]
      );

      matches.push({
        payment_id: paymentResult.rows[0].payment_id,
        schedule_id: match.schedule_id,
        bill_id: match.bill_id,
        amount,
        reference: row.reference,
        description: row.description
      });
    }

    res.json({
      success: true,
      matched: matches.length,
      unmatched: unmatched.length,
      matches,
      unmatched
    });
  } catch (error) {
    console.error('Bank CSV import error:', error);
    res.status(500).json({ error: error.message });
  }
}

// Helpers
function parseCSV(text) {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length === 0) return [];
  const headers = lines[0].split(',').map(h => h.trim().toLowerCase());
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = splitCSVLine(lines[i]);
    const row = {};
    headers.forEach((h, idx) => {
      row[h] = cols[idx];
    });
    rows.push({
      date: row.date ? new Date(row.date) : null,
      amount: row.amount ? parseFloat(row.amount) : null,
      reference: row.reference || row.ref || row.utr || null,
      description: row.description || row.narration || row.remark || ''
    });
  }
  return rows;
}

function splitCSVLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"' && line[i + 1] === '"' && inQuotes) {
      current += '"';
      i++;
    } else if (ch === '"') {
      inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) {
      result.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  result.push(current);
  return result.map(s => s.trim());
}

async function findScheduleMatch(amount) {
  const result = await pool.query(
    `SELECT ps.schedule_id, ps.bill_id, ps.amount_due, ps.amount_paid, ps.due_date, b.payment_method
     FROM payment_schedule ps
     JOIN bills b ON ps.bill_id = b.bill_id
     WHERE ps.payment_status IN ('PENDING','PARTIAL')
       AND COALESCE(b.payment_method, 'UNSPECIFIED') <> 'CASH'
     ORDER BY ps.due_date ASC`
  );

  let best = null;
  let bestDelta = Infinity;
  for (const row of result.rows) {
    const outstanding = parseFloat(row.amount_due) - parseFloat(row.amount_paid);
    const delta = Math.abs(outstanding - amount);
    if (delta < 1 && delta < bestDelta) {
      best = row;
      bestDelta = delta;
    }
  }
  return best;
}

// Delete bill and reset associated document
async function deleteBill(req, res) {
  try {
    const { bill_id } = req.params;
    const bill = await pool.query('SELECT bill_id, document_id FROM bills WHERE bill_id = $1', [bill_id]);
    if (bill.rows.length === 0) {
      return res.status(404).json({ error: 'Bill not found' });
    }
    const documentId = bill.rows[0].document_id;

    // Delete bill row
    await pool.query('DELETE FROM bills WHERE bill_id = $1', [bill_id]);

    // Delete associated document and file if present
    if (documentId) {
      const doc = await pool.query('SELECT file_path FROM documents WHERE document_id = $1', [documentId]);
      await pool.query('DELETE FROM documents WHERE document_id = $1', [documentId]);
      if (doc.rows.length && doc.rows[0].file_path) {
        try {
          const fs = require('fs');
          if (fs.existsSync(doc.rows[0].file_path)) {
            fs.unlinkSync(doc.rows[0].file_path);
          }
        } catch (err) {
          console.error('File delete error:', err.message);
        }
      }
    }

    res.json({ success: true, message: 'Bill deleted', bill_id: Number(bill_id) });
  } catch (error) {
    console.error('Delete bill error:', error);
    res.status(500).json({ error: error.message });
  }
}

// Update bill/document dimensions/metadata
async function updateBillMeta(req, res) {
  try {
    const { bill_id } = req.params;
    const { drop_name, trip_name, channel, campaign, department, category, notes } = req.body || {};

    const bill = await pool.query('SELECT bill_id, document_id FROM bills WHERE bill_id = $1', [bill_id]);
    if (bill.rows.length === 0) {
      return res.status(404).json({ error: 'Bill not found' });
    }
    const documentId = bill.rows[0].document_id;

    await pool.query(
      `UPDATE bills 
       SET drop_name = COALESCE($1, drop_name),
           trip_name = COALESCE($2, trip_name),
           channel = COALESCE($3, channel),
           campaign = COALESCE($4, campaign),
           department = COALESCE($5, department),
           category = COALESCE($6, category)
       WHERE bill_id = $7`,
      [drop_name || null, trip_name || null, channel || null, campaign || null, department || null, category || null, bill_id]
    );

    if (documentId) {
      await pool.query(
        `UPDATE documents 
         SET drop_name = COALESCE($1, drop_name),
             trip_name = COALESCE($2, trip_name),
             channel = COALESCE($3, channel),
             campaign = COALESCE($4, campaign),
             document_category = COALESCE($5, document_category),
             notes = COALESCE($6, notes)
         WHERE document_id = $7`,
        [drop_name || null, trip_name || null, channel || null, campaign || null, category || null, notes || null, documentId]
      );
    }

    res.json({ success: true, message: 'Bill metadata updated' });
  } catch (error) {
    console.error('Update bill meta error:', error);
    res.status(500).json({ error: error.message });
  }
}

module.exports = {
  processBillWithAI,
  processBillManual,
  getPaymentDashboard,
  recordPayment,
  deleteBill,
  updateBillMeta,
  recordSimplePayment
};
