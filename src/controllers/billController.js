const pool = require('../config/database');
const { preprocessFile } = require('../services/preprocessService');
const fs = require('fs');
const path = require('path');
const { normalizeCategory } = require('../utils/categoryMap');
const { safeParseJSON } = require('../utils/json');
const { getRawTextFromDoc } = require('../utils/ocrCache');
const { logDocumentFieldChange } = require('../utils/documentAudit');
const { processDocumentWithAI } = require('./uploadController');

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

function normalizeISODate(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return String(value);
  return parsed.toISOString().slice(0, 10);
}

// Process bill with AI
async function processBillWithAI(req, res) {
  try {
    const { document_id } = req.params;
    const { payment_method, drop_name } = req.body || {};

    const docResult = await pool.query(
      'SELECT * FROM documents WHERE document_id = $1',
      [document_id]
    );
    if (docResult.rows.length === 0) {
      return res.status(404).json({ error: 'Document not found' });
    }

    const document = docResult.rows[0];
    const parsedGemini = safeParseJSON(document.gemini_data);
    if (parsedGemini) {
      document.gemini_data = parsedGemini;
    }

    const effectivePayment = (payment_method || document.payment_method || 'UNSPECIFIED').toUpperCase();
    const payload = {
      ...document,
      drop_name: drop_name || document.drop_name || null,
      payment_method: effectivePayment
    };
    const rawTextHint = getRawTextFromDoc(document);
    const actorMeta = { actorType: req.user?.role || 'user', actorId: req.user?.userId || null };
    const result = await processDocumentWithAI(payload, rawTextHint, effectivePayment, actorMeta);
    if (!result || !result.success) {
      return res.status(400).json({
        error: result?.reason || 'AI extraction failed',
        details: result?.error || null
      });
    }

    res.json({
      success: true,
      message: 'Bill processed by AI',
      bill_id: result.bill_id,
      document_id
    });
  } catch (error) {
    console.error('AI bill processing error:', error);
    res.status(500).json({ error: error.message });
  }
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
    const existingBill = await pool.query(
      'SELECT bill_id, bill_date, total_amount, bill_date_locked, total_locked FROM bills WHERE document_id = $1',
      [document_id]
    );
    let billId = null;
    const previousBill = existingBill.rows[0] || null;
    const previousBillDate = normalizeISODate(previousBill?.bill_date);
    const previousTotalAmount = previousBill && previousBill.total_amount != null
      ? Number(previousBill.total_amount)
      : null;
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

    const actorType = (req.user?.role || 'user').toLowerCase();
    const actorId = req.user?.userId || null;
    const lockActor = actorId || DEFAULT_JOURNAL_USER_ID;
    const lockBillDate = Boolean(bill_date);
    if (bill_date) {
      await pool.query('UPDATE bills SET bill_date_locked = TRUE WHERE bill_id = $1', [billId]);
      await logDocumentFieldChange({
        documentId: document_id,
        fieldName: 'bill_date',
        oldValue: previousBillDate,
        newValue: bill_date,
        actorType: actorType === 'admin' ? 'admin' : 'user',
        actorId,
        reason: 'manual_update',
        confidence: 1,
        evidence: 'manual entry'
      });
    }
    if (total_amount) {
      await pool.query('UPDATE bills SET total_locked = TRUE WHERE bill_id = $1', [billId]);
      await logDocumentFieldChange({
        documentId: document_id,
        fieldName: 'total_amount',
        oldValue: previousTotalAmount,
        newValue: total_amount,
        actorType: actorType === 'admin' ? 'admin' : 'user',
        actorId,
        reason: 'manual_update',
        confidence: 1,
        evidence: 'manual entry'
      });
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

    const manualExtractionState = {
      run_at: new Date().toISOString(),
      provider: 'manual',
      manual: true,
      ai: {
        vendor_name,
        bill_date: bill_date || null,
        total_amount: total_amount || null,
        confidence: 1
      }
    };
    const verificationStatus = bill_date ? 'verified' : 'needs_review';
    const qualityScore = bill_date ? 100 : 90;
    const verificationReason = bill_date ? null : 'Manual: missing bill date';

    // Update document status and stash manual data
    await pool.query(
      `UPDATE documents 
       SET status = $1,
           gemini_data = $2,
           notes = COALESCE($3, notes),
           document_category = $4,
           payment_method = COALESCE($5, payment_method),
           verification_status = $6,
           quality_score = $7,
           extraction_state = $8,
           verification_reason = $9,
           bill_date_locked = CASE WHEN $10 THEN TRUE ELSE bill_date_locked END,
           total_locked = CASE WHEN $11 THEN TRUE ELSE total_locked END,
           locked_by_user_id = $12,
           locked_at = NOW()
       WHERE document_id = $13`,
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
        normalizedCategory || document.document_category || 'misc',
        normalizedPayment,
        verificationStatus,
        qualityScore,
        JSON.stringify(manualExtractionState),
        verificationReason,
        lockBillDate,
        true,
        lockActor,
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
