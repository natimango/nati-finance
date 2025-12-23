const pool = require('../config/database');
const { getContributionMarginData } = require('../services/skuCostService');
const { getMaxCacByTier, getMaxCacBySize } = require('../services/unitEconomicsService');

const ALERT_TYPES = {
  agedNeedsReview: 'DOC_NEEDS_REVIEW_AGED',
  lowQuality: 'DOC_LOW_QUALITY',
  highValue: 'DOC_HIGH_VALUE_NEEDS_REVIEW',
  duplicateFile: 'DOC_DUPLICATE_FILE',
  budgetVariance: 'BUDGET_VARIANCE'
};
const HIGH_VALUE_THRESHOLD = 5000;

function formatRupees(value) {
  const num = Number(value);
  if (Number.isNaN(num) || num <= 0) return '₹0';
  return `₹${num.toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;
}

async function upsertDocumentAlert({ alertType, severity, message, documentId, billId = null, metadata = {} }) {
  if (!documentId) return 0;
  const existing = await pool.query(
    `SELECT alert_id FROM alerts WHERE alert_type = $1 AND document_id = $2 AND resolved_at IS NULL LIMIT 1`,
    [alertType, documentId]
  );
  if (existing.rowCount > 0) return 0;
  await pool.query(
    `INSERT INTO alerts (alert_type, severity, message, document_id, bill_id, metadata)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
    [alertType, severity, message, documentId, billId, JSON.stringify(metadata || {})]
  );
  return 1;
}

async function resolveClearedDocumentAlerts(alertType, activeDocumentIds = [], actor = 'system') {
  await pool.query(
    `
    UPDATE alerts
    SET resolved_at = NOW(),
        resolved_by = $3
    WHERE alert_type = $1
      AND resolved_at IS NULL
      AND (document_id IS NULL OR document_id <> ALL($2::int[]))
    `,
    [alertType, activeDocumentIds, actor]
  );
}

async function evaluateVerificationAlerts(actor = 'system') {
  let created = 0;

  const agedResult = await pool.query(
    `
    WITH doc_meta AS (
      SELECT d.document_id,
             d.file_name,
             d.uploaded_at,
             d.verification_status,
             b.bill_id,
             COALESCE(
               to_char(b.bill_date, 'YYYY-MM-DD'),
               NULLIF(d.gemini_data->>'bill_date', '')
             ) AS resolved_bill_date,
             COALESCE(
               b.total_amount,
               NULLIF(REGEXP_REPLACE(COALESCE(d.gemini_data->'amounts'->>'total',''), '[^0-9.]', '', 'g'), '')::numeric
             ) AS resolved_total
      FROM documents d
      LEFT JOIN bills b ON b.document_id = d.document_id
    )
    SELECT * FROM doc_meta
    WHERE (verification_status = 'needs_review' OR resolved_bill_date IS NULL OR resolved_total IS NULL OR resolved_total <= 0)
      AND uploaded_at < NOW() - INTERVAL '24 HOURS'
    ORDER BY uploaded_at ASC
    LIMIT 50
    `
  );
  const agedIds = [];
  for (const row of agedResult.rows) {
    agedIds.push(row.document_id);
    const message = `#${String(row.document_id).padStart(4, '0')} missing date/total for 24h+`;
    created += await upsertDocumentAlert({
      alertType: ALERT_TYPES.agedNeedsReview,
      severity: 'warning',
      message,
      documentId: row.document_id,
      billId: row.bill_id,
      metadata: {
        uploaded_at: row.uploaded_at,
        bill_date: row.resolved_bill_date,
        total_amount: row.resolved_total
      }
    });
  }
  await resolveClearedDocumentAlerts(ALERT_TYPES.agedNeedsReview, agedIds, actor);

  const lowQualityResult = await pool.query(
    `
    SELECT d.document_id,
           d.file_name,
           d.quality_score,
           d.uploaded_at,
           d.verification_status,
           b.bill_id
    FROM documents d
    LEFT JOIN bills b ON b.document_id = d.document_id
    WHERE COALESCE(d.quality_score, 0) < 60
      AND COALESCE(d.status, '') NOT IN ('deleted','void')
    ORDER BY d.uploaded_at DESC
    LIMIT 50
    `
  );
  const lowQualityIds = [];
  for (const row of lowQualityResult.rows) {
    lowQualityIds.push(row.document_id);
    const message = `#${String(row.document_id).padStart(4, '0')} low quality (${row.quality_score || 0})`;
    created += await upsertDocumentAlert({
      alertType: ALERT_TYPES.lowQuality,
      severity: 'warning',
      message,
      documentId: row.document_id,
      billId: row.bill_id,
      metadata: {
        uploaded_at: row.uploaded_at,
        quality_score: row.quality_score,
        verification_status: row.verification_status
      }
    });
  }
  await resolveClearedDocumentAlerts(ALERT_TYPES.lowQuality, lowQualityIds, actor);

  const highValueResult = await pool.query(
    `
    WITH doc_meta AS (
      SELECT d.document_id,
             d.file_name,
             d.verification_status,
             b.bill_id,
             COALESCE(
               b.total_amount,
               NULLIF(REGEXP_REPLACE(COALESCE(d.gemini_data->'amounts'->>'total',''), '[^0-9.]', '', 'g'), '')::numeric
             ) AS resolved_total
      FROM documents d
      LEFT JOIN bills b ON b.document_id = d.document_id
    )
    SELECT * FROM doc_meta
    WHERE verification_status = 'needs_review'
      AND resolved_total IS NOT NULL
      AND resolved_total >= $1
    ORDER BY resolved_total DESC
    LIMIT 50
    `,
    [HIGH_VALUE_THRESHOLD]
  );
  const highValueIds = [];
  for (const row of highValueResult.rows) {
    highValueIds.push(row.document_id);
    const message = `#${String(row.document_id).padStart(4, '0')} needs review (${formatRupees(row.resolved_total)})`;
    created += await upsertDocumentAlert({
      alertType: ALERT_TYPES.highValue,
      severity: 'critical',
      message,
      documentId: row.document_id,
      billId: row.bill_id,
      metadata: {
        total_amount: row.resolved_total
      }
    });
  }
  await resolveClearedDocumentAlerts(ALERT_TYPES.highValue, highValueIds, actor);

  const duplicateResult = await pool.query(
    `
    WITH duplicates AS (
      SELECT file_hash, COUNT(*) AS occurrences
      FROM documents
      WHERE file_hash IS NOT NULL
        AND file_hash <> ''
        AND COALESCE(status, 'uploaded') <> 'deleted'
      GROUP BY file_hash
      HAVING COUNT(*) > 1
    )
    SELECT d.document_id,
           d.file_name,
           d.uploaded_at,
            d.file_hash,
            dup.occurrences,
            v.vendor_name,
            b.bill_id,
            b.bill_number
    FROM duplicates dup
    JOIN documents d ON d.file_hash = dup.file_hash
    LEFT JOIN bills b ON b.document_id = d.document_id
    LEFT JOIN vendors v ON v.vendor_id = b.vendor_id
    ORDER BY dup.occurrences DESC, d.uploaded_at DESC
    LIMIT 50
    `
  );
  const duplicateIds = [];
  for (const row of duplicateResult.rows) {
    duplicateIds.push(row.document_id);
    const baseLabel = row.vendor_name || 'Vendor';
    const message = `${baseLabel} • Duplicate file hash (${row.file_hash}) seen ${row.occurrences}x`;
    created += await upsertDocumentAlert({
      alertType: ALERT_TYPES.duplicateFile,
      severity: 'warning',
      message,
      documentId: row.document_id,
      billId: row.bill_id || null,
      metadata: {
        file_hash: row.file_hash,
        bill_number: row.bill_number || null,
        occurrences: Number(row.occurrences || 0)
      }
    });
  }
  await resolveClearedDocumentAlerts(ALERT_TYPES.duplicateFile, duplicateIds, actor);

  return created;
}

// Finance snapshot with drops, vendors, SKU COGS, doc health.
async function getFinanceSummary(req, res) {
  try {
    const days = Number(req.query.days || 90);
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);
    const startISO = startDate.toISOString().slice(0, 10);

    const [
      spendTotals,
      dropTotals,
      vendorTotals,
      skuTotals,
      docStatus
    ] = await Promise.all([
      pool.query(
        `
        SELECT
          SUM(total_amount) AS total_spend,
          SUM(CASE WHEN department ILIKE 'marketing%' THEN total_amount ELSE 0 END) AS marketing,
          SUM(CASE WHEN (department ILIKE 'cogs%' OR department ILIKE 'manufacturing%' OR category ILIKE 'logistics%' OR category ILIKE 'stitch%') THEN total_amount ELSE 0 END) AS cogs_ops
        FROM bills
        WHERE bill_date >= $1
        `,
        [startISO]
      ),
      pool.query(
        `
        SELECT COALESCE(drop_name, 'Unassigned') AS drop_name,
               SUM(total_amount) AS total
        FROM bills
        WHERE bill_date >= $1
        GROUP BY COALESCE(drop_name, 'Unassigned')
        ORDER BY total DESC
        LIMIT 12
        `,
        [startISO]
      ),
      pool.query(
        `
        SELECT v.vendor_name, SUM(b.total_amount) AS total
        FROM bills b
        LEFT JOIN vendors v ON v.vendor_id = b.vendor_id
        WHERE b.bill_date >= $1
        GROUP BY v.vendor_name
        ORDER BY total DESC
        LIMIT 10
        `,
        [startISO]
      ),
      pool.query(
        `
        SELECT sku_code,
               SUM(amount) AS total_amount,
               SUM(quantity) AS total_qty
        FROM bill_items
        WHERE sku_code IS NOT NULL
        GROUP BY sku_code
        ORDER BY total_amount DESC
        LIMIT 15
        `
      ),
      pool.query(
        `
        SELECT status, COUNT(*) AS count
        FROM documents
        GROUP BY status
        `
      )
    ]);

    res.json({
      period: { days, start: startISO },
      totals: {
        spend: Number(spendTotals.rows[0]?.total_spend || 0),
        marketing: Number(spendTotals.rows[0]?.marketing || 0),
        cogs_ops: Number(spendTotals.rows[0]?.cogs_ops || 0)
      },
      drops: dropTotals.rows,
      vendors: vendorTotals.rows,
      skus: skuTotals.rows,
      documents: docStatus.rows
    });
  } catch (err) {
    console.error('Finance summary error', err);
    res.status(500).json({ error: 'Failed to load finance summary' });
  }
}

// Drop deep dive: budgets vs actual.
async function getDropOverview(req, res) {
  try {
    const dropName = req.params.dropName;
    const [actual, budgets, vendors, skus] = await Promise.all([
      pool.query(
        `
        SELECT
          SUM(total_amount) AS total_spend,
          SUM(CASE WHEN department ILIKE 'marketing%' THEN total_amount ELSE 0 END) AS marketing_spend,
          SUM(CASE WHEN department ILIKE 'cogs%' OR category ILIKE 'stitch%' OR category ILIKE 'logistics%' THEN total_amount ELSE 0 END) AS cogs_spend
        FROM bills
        WHERE drop_name ILIKE $1
        `,
        [dropName]
      ),
      pool.query(
        `
        SELECT department, amount
        FROM drop_budgets
        WHERE drop_name ILIKE $1
        `,
        [dropName]
      ),
      pool.query(
        `
        SELECT v.vendor_name, SUM(b.total_amount) AS total
        FROM bills b
        LEFT JOIN vendors v ON v.vendor_id = b.vendor_id
        WHERE b.drop_name ILIKE $1
        GROUP BY v.vendor_name
        ORDER BY total DESC
        LIMIT 10
        `,
        [dropName]
      ),
      pool.query(
        `
        SELECT sku_code, SUM(amount) AS total_amount, SUM(quantity) AS total_qty
        FROM bill_items bi
        JOIN bills b ON b.bill_id = bi.bill_id
        WHERE b.drop_name ILIKE $1 AND bi.sku_code IS NOT NULL
        GROUP BY sku_code
        ORDER BY total_amount DESC
        LIMIT 20
        `,
        [dropName]
      )
    ]);

    res.json({
      drop: dropName,
      actual: actual.rows[0] || {},
      budgets: budgets.rows,
      vendors: vendors.rows,
      skus: skus.rows
    });
  } catch (err) {
    console.error('Drop overview error', err);
    res.status(500).json({ error: 'Failed to load drop overview' });
  }
}

// SKU COGS view.
async function getSkuOverview(req, res) {
  try {
    const sku = req.params.skuCode;
    const { rows } = await pool.query(
      `
      SELECT
        sku_code,
        SUM(amount) AS total_amount,
        SUM(quantity) AS total_qty,
        MIN(amount) AS min_line,
        MAX(amount) AS max_line
      FROM bill_items
      WHERE sku_code ILIKE $1
      GROUP BY sku_code
      `,
      [sku]
    );
    res.json(rows[0] || { sku_code: sku, total_amount: 0, total_qty: 0 });
  } catch (err) {
    console.error('SKU overview error', err);
    res.status(500).json({ error: 'Failed to load SKU overview' });
  }
}

// Simple watchdog: duplicate invoice numbers per vendor + oversized bills.
async function getWatchdog(req, res) {
  try {
    const [billDupes, fileDupes, oversized, staleDocs, agedUnpaid, budgetsOpen] = await Promise.all([
      pool.query(
        `
        SELECT v.vendor_name, bill_number, COUNT(*) AS count
        FROM bills b
        JOIN vendors v ON v.vendor_id = b.vendor_id
        WHERE bill_number IS NOT NULL AND bill_number <> ''
          AND (b.status IS NULL OR b.status NOT IN ('deleted','void'))
        GROUP BY v.vendor_name, bill_number
        HAVING COUNT(*) > 1
        ORDER BY count DESC, v.vendor_name
        LIMIT 25
        `
      ),
      pool.query(
        `
        SELECT
          d.file_hash,
          COUNT(*) AS count,
          MAX(d.uploaded_at) AS latest_uploaded_at,
          (ARRAY_AGG(COALESCE(v.vendor_name, 'Unassigned') ORDER BY d.uploaded_at DESC))[1] AS vendor_name,
          (ARRAY_AGG(b.bill_number ORDER BY d.uploaded_at DESC))[1] AS bill_number,
          (ARRAY_AGG(d.file_name ORDER BY d.uploaded_at DESC))[1] AS file_name
        FROM documents d
        LEFT JOIN bills b ON b.document_id = d.document_id
        LEFT JOIN vendors v ON v.vendor_id = b.vendor_id
        WHERE COALESCE(d.status, 'uploaded') <> 'deleted'
          AND d.file_hash IS NOT NULL
          AND d.file_hash <> ''
        GROUP BY d.file_hash
        HAVING COUNT(*) > 1
        ORDER BY COUNT(*) DESC, MAX(d.uploaded_at) DESC
        LIMIT 25
        `
      ),
      pool.query(
        `
        SELECT b.bill_id, v.vendor_name, b.bill_number, b.total_amount
        FROM bills b
        JOIN vendors v ON v.vendor_id = b.vendor_id
        WHERE (b.status IS NULL OR b.status NOT IN ('deleted','void'))
          AND b.total_amount > (
            SELECT COALESCE(AVG(total_amount) * 3, 0)
            FROM bills b2
            WHERE b2.vendor_id = b.vendor_id
          )
        ORDER BY b.total_amount DESC
        LIMIT 20
        `
      ),
      pool.query(
        `
        SELECT document_id, file_name, status, uploaded_at
        FROM documents
        WHERE status IN ('manual_required','uploaded')
          AND uploaded_at < NOW() - INTERVAL '48 HOURS'
        ORDER BY uploaded_at ASC
        LIMIT 20
        `
      ),
      pool.query(
        `
        SELECT b.bill_id,
               v.vendor_name,
               b.bill_number,
               b.bill_date,
               b.total_amount,
               COALESCE(SUM(p.amount_paid), 0) AS paid,
               COUNT(s.bill_id) AS schedule_rows
        FROM bills b
        LEFT JOIN payments p ON p.bill_id = b.bill_id
        LEFT JOIN payment_schedule s ON s.bill_id = b.bill_id
        LEFT JOIN vendors v ON v.vendor_id = b.vendor_id
        WHERE (b.status IS NULL OR b.status NOT IN ('deleted','void'))
        GROUP BY b.bill_id, v.vendor_name, b.bill_number, b.bill_date, b.total_amount
        HAVING COALESCE(SUM(p.amount_paid), 0) < b.total_amount
           AND (COALESCE(SUM(p.amount_paid), 0) > 0 OR COUNT(s.bill_id) > 0)
           AND b.bill_date < NOW() - INTERVAL '30 DAYS'
        ORDER BY b.bill_date ASC
        LIMIT 20
        `
      ),
      pool.query(
        `
        SELECT alert_id, alert_type, severity, message, drop_name, category_group, metadata, created_at
        FROM alerts
        WHERE alert_type = 'BUDGET_VARIANCE'
          AND resolved_at IS NULL
        ORDER BY created_at DESC
        LIMIT 20
        `
      )
    ]);
    const duplicateRows = [
      ...billDupes.rows.map(row => ({
        vendor_name: row.vendor_name,
        bill_number: row.bill_number,
        count: Number(row.count) || 0,
        is_file_duplicate: false
      })),
      ...fileDupes.rows.map(row => ({
        vendor_name: row.vendor_name,
        bill_number: row.bill_number,
        file_name: row.file_name,
        count: Number(row.count) || 0,
        is_file_duplicate: true
      }))
    ].sort((a, b) => b.count - a.count);

    res.json({
      summary: {
        duplicates: billDupes.rowCount + fileDupes.rowCount,
        oversized: oversized.rowCount,
        stale_manual: staleDocs.rowCount,
        aged_unpaid: agedUnpaid.rowCount,
        budget: budgetsOpen.rowCount
      },
      duplicates: duplicateRows,
      oversized: oversized.rows,
      stale_manual: staleDocs.rows,
      aged_unpaid: agedUnpaid.rows,
      budget_alerts: budgetsOpen.rows
    });
  } catch (err) {
    console.error('Watchdog error', err);
    res.status(500).json({ error: 'Failed to run watchdog' });
  }
}

async function getAlerts(req, res) {
  try {
    const { status = 'open', limit = 50 } = req.query;
    const clauses = [];
    if (status === 'open') clauses.push('resolved_at IS NULL');
    if (status === 'resolved') clauses.push('resolved_at IS NOT NULL');
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const result = await pool.query(
      `
      SELECT alert_id, alert_type, severity, message, drop_name, category_group,
             document_id, bill_id, metadata, resolved_at, resolved_by, created_at
      FROM alerts
      ${where}
      ORDER BY created_at DESC
      LIMIT $1
      `,
      [Number(limit)]
    );
    res.json({ success: true, alerts: result.rows });
  } catch (err) {
    console.error('Get alerts error', err);
    res.status(500).json({ error: 'Failed to load alerts' });
  }
}

async function runBudgetAlerts(req, res) {
  try {
    const actor = (req.user && (req.user.email || req.user.name)) || 'system';
    const budgets = await pool.query(`
      SELECT db.drop_name,
             db.department AS category_group,
             db.amount,
             db.start_date,
             db.end_date,
             COALESCE((
               SELECT SUM(b.total_amount)
               FROM bills b
               WHERE b.drop_name = db.drop_name
                 AND COALESCE(b.department, 'OPERATING') = COALESCE(db.department, 'OPERATING')
                 AND b.bill_date BETWEEN db.start_date AND db.end_date
                 AND (b.status IS NULL OR b.status NOT IN ('deleted','void'))
             ), 0) AS actual_amount
      FROM drop_budgets db
    `);

    let created = 0;
    for (const row of budgets.rows) {
      const budget = Number(row.amount || 0);
      const actual = Number(row.actual_amount || 0);
      if (budget <= 0) {
        await resolveBudgetAlert(row.drop_name, row.category_group, actor);
        continue;
      }
      const ratio = actual / budget;
      if (ratio >= 0.8) {
        const severity = ratio >= 1 ? 'critical' : 'warning';
        const inserted = await createBudgetAlert(
          row.drop_name,
          row.category_group,
          severity,
          budget,
          actual,
          ratio
        );
        if (inserted) created += 1;
      } else {
        await resolveBudgetAlert(row.drop_name, row.category_group, actor);
      }
    }

    const verificationCreated = await evaluateVerificationAlerts(actor);
    res.json({ success: true, created: created + verificationCreated });
  } catch (err) {
    console.error('runBudgetAlerts error', err);
    res.status(500).json({ error: 'Failed to evaluate budgets' });
  }
}

async function getAlertSummary(req, res) {
  try {
    const threshold = Number(process.env.HIGH_VALUE_ALERT_THRESHOLD || HIGH_VALUE_THRESHOLD);
    const docUnposted = await pool.query(
      `
      WITH unposted AS (
        SELECT d.document_id, d.uploaded_at,
               SUM(bi.amount) AS unposted_amount
        FROM bill_items bi
        JOIN bills b ON b.bill_id = bi.bill_id
        JOIN documents d ON d.document_id = b.document_id
        WHERE bi.is_postable
          AND bi.posting_status <> 'posted'
        GROUP BY d.document_id, d.uploaded_at
      )
      SELECT
        COUNT(*) AS total_unposted_docs,
        COALESCE(SUM(unposted_amount), 0) AS unposted_amount,
        COUNT(*) FILTER (WHERE uploaded_at < NOW() - INTERVAL '24 HOURS') AS aged_unposted_docs
      FROM unposted
      `
    );

    const highValue = await pool.query(
      `
      WITH unposted AS (
        SELECT d.document_id, SUM(bi.amount) AS unposted_amount
        FROM bill_items bi
        JOIN bills b ON b.bill_id = bi.bill_id
        JOIN documents d ON d.document_id = b.document_id
        WHERE bi.is_postable
          AND bi.posting_status <> 'posted'
        GROUP BY d.document_id
      )
      SELECT
        COUNT(*) AS high_value_docs,
        COALESCE(SUM(unposted_amount), 0) AS high_value_amount
      FROM unposted
      WHERE unposted_amount >= $1
      `,
      [threshold]
    );

    const goLiveUnposted = await pool.query(
      `
      SELECT
        COUNT(*) AS count,
        COALESCE(SUM(amount), 0) AS amount
      FROM bill_items
      WHERE is_postable
        AND go_live_eligible
        AND posting_status <> 'posted'
      `
    );

    const verifiedWithUnposted = await pool.query(
      `
      SELECT COUNT(DISTINCT d.document_id) AS count
      FROM documents d
      JOIN bills b ON b.document_id = d.document_id
      JOIN bill_items bi ON bi.bill_id = b.bill_id
      WHERE d.verification_status = 'verified'
        AND bi.is_postable
        AND bi.posting_status <> 'posted'
      `
    );

    res.json({
      success: true,
      summary: {
        total_unposted_docs: Number(docUnposted.rows[0]?.total_unposted_docs || 0),
        unposted_amount: Number(docUnposted.rows[0]?.unposted_amount || 0),
        aged_unposted_docs: Number(docUnposted.rows[0]?.aged_unposted_docs || 0),
        high_value_unposted_docs: Number(highValue.rows[0]?.high_value_docs || 0),
        high_value_unposted_amount: Number(highValue.rows[0]?.high_value_amount || 0),
        go_live_unposted_docs: Number(goLiveUnposted.rows[0]?.count || 0),
        go_live_unposted_amount: Number(goLiveUnposted.rows[0]?.amount || 0),
        verified_documents_with_unposted: Number(verifiedWithUnposted.rows[0]?.count || 0)
      }
    });
  } catch (err) {
    console.error('Alert summary error', err);
    res.status(500).json({ success: false, error: err.message });
  }
}

async function getGuardrails(req, res) {
  try {
    const dropId = Number(req.params.dropId);
    if (Number.isNaN(dropId)) {
      return res.status(400).json({ success: false, error: 'dropId must be numeric' });
    }

    const dropRow = await pool.query('SELECT drop_name FROM drops WHERE drop_id = $1 AND is_active', [dropId]);
    if (!dropRow.rows.length) {
      return res.status(404).json({ success: false, error: 'Drop not found' });
    }

    const dropName = dropRow.rows[0].drop_name;
    const totals = await pool.query(
      `
      SELECT COALESCE(SUM(amount), 0) AS total_go_live_cost
      FROM bill_items
      WHERE drop_id = $1
        AND is_postable
        AND go_live_eligible
        AND posting_status = 'posted'
      `,
      [dropId]
    );
    const unposted = await pool.query(
      `
      SELECT
        COALESCE(SUM(amount), 0) AS excluded_unposted_amount,
        COUNT(*) AS unposted_go_live_count
      FROM bill_items
      WHERE drop_id = $1
        AND is_postable
        AND go_live_eligible
        AND posting_status <> 'posted'
      `,
      [dropId]
    );
    const inventoryResult = await pool.query(
      `
      SELECT COALESCE(SUM(it.quantity), 0) AS units
      FROM inventory_transactions it
      JOIN products p ON p.product_id = it.product_id
      JOIN sku_master sm ON sm.sku_code = p.sku_code
      WHERE sm.drop_id = $1
      `,
      [dropId]
    );
    const contribution = await getContributionMarginData(dropId);

    const goLiveCost = Number(totals.rows[0]?.total_go_live_cost || 0);
    const inventoryUnits = Number(inventoryResult.rows[0]?.units || 0);
    const blendedContribution = contribution.blended_contribution_margin || 0;
    const breakEvenUnits =
      blendedContribution > 0 ? Math.ceil(goLiveCost / blendedContribution) : null;
    const allowedMarketingBudget = Number(
      (Math.max(0, contribution.max_cac) * Math.max(1, inventoryUnits)).toFixed(2)
    );

    res.json({
      success: true,
      drop: { drop_id: dropId, drop_name: dropName },
      go_live: {
        total_go_live_cost: goLiveCost,
        excluded_unposted_amount: Number(unposted.rows[0]?.excluded_unposted_amount || 0),
        unposted_go_live_count: Number(unposted.rows[0]?.unposted_go_live_count || 0)
      },
      contribution: {
        blended_contribution_margin: blendedContribution,
        max_cac: contribution.max_cac,
        target_net_margin_buffer: contribution.target_net_margin_buffer
      },
      inventory_units: inventoryUnits,
      break_even_units: breakEvenUnits,
      allowed_marketing_budget: allowedMarketingBudget,
      go_live_payback: null
    });
  } catch (err) {
    console.error('Guardrails error', err);
    res.status(500).json({ success: false, error: err.message });
  }
}

async function checkInvariants(req, res) {
  try {
    const [postMissing, unposted, verifiedUnposted, duplicates] = await Promise.all([
      pool.query(
        `
        SELECT COUNT(*) AS count
        FROM bill_items
        WHERE is_postable
          AND posting_status = 'posted'
          AND (coa_account_id IS NULL OR department_id IS NULL OR drop_id IS NULL)
        `
      ),
      pool.query(
        `
        SELECT COUNT(*) AS count,
               COALESCE(SUM(amount), 0) AS amount
        FROM bill_items
        WHERE is_postable
          AND posting_status <> 'posted'
        `
      ),
      pool.query(
        `
        SELECT COUNT(DISTINCT d.document_id) AS count
        FROM documents d
        JOIN bills b ON b.document_id = d.document_id
        JOIN bill_items bi ON bi.bill_id = b.bill_id
        WHERE d.verification_status = 'verified'
          AND bi.is_postable
          AND bi.posting_status <> 'posted'
        `
      ),
      pool.query(
        `
        WITH duplicates AS (
          SELECT file_hash
          FROM documents
          WHERE file_hash IS NOT NULL
            AND file_hash <> ''
          GROUP BY file_hash
          HAVING COUNT(*) > 1
        )
        SELECT COUNT(*) AS count
        FROM documents
        WHERE file_hash IN (SELECT file_hash FROM duplicates)
        `
      )
    ]);

    const postedMissingDims = Number(postMissing.rows[0]?.count || 0);
    const unpostedCount = Number(unposted.rows[0]?.count || 0);
    const unpostedAmount = Number(unposted.rows[0]?.amount || 0);
    const verifiedWithUnposted = Number(verifiedUnposted.rows[0]?.count || 0);
    const duplicateFileHashCount = Number(duplicates.rows[0]?.count || 0);
    const ok = postedMissingDims === 0 && verifiedWithUnposted === 0 && duplicateFileHashCount === 0;

    res.json({
      success: true,
      invariants: {
        posted_missing_dims: postedMissingDims,
        unposted_postable_items: unpostedCount,
        unposted_amount: unpostedAmount,
        verified_documents_with_unposted: verifiedWithUnposted,
        duplicate_file_hash_count: duplicateFileHashCount
      },
      ok
    });
  } catch (err) {
    console.error('Invariants error', err);
    res.status(500).json({ success: false, error: err.message });
  }
}

async function createBudgetAlert(dropName, group, severity, budget, actual, ratio) {
  const existing = await pool.query(
    `
    SELECT alert_id
    FROM alerts
    WHERE alert_type = 'BUDGET_VARIANCE'
      AND drop_name = $1
      AND category_group = $2
      AND severity = $3
      AND resolved_at IS NULL
    LIMIT 1
    `,
    [dropName, group, severity]
  );
  if (existing.rowCount > 0) return false;

  const message = `${dropName} • ${group || 'Operating'} used ${Math.round(ratio * 100)}% of budget`;
  await pool.query(
    `
    INSERT INTO alerts (alert_type, severity, message, drop_name, category_group, metadata)
    VALUES ('BUDGET_VARIANCE', $1, $2, $3, $4, $5::jsonb)
    `,
    [
      severity,
      message,
      dropName,
      group,
      JSON.stringify({
        budget,
        actual,
        ratio
      })
    ]
  );
  return true;
}

async function resolveBudgetAlert(dropName, group, actor) {
  await pool.query(
    `
    UPDATE alerts
    SET resolved_at = NOW(), resolved_by = $3
    WHERE alert_type = 'BUDGET_VARIANCE'
      AND drop_name = $1
      AND category_group = $2
      AND resolved_at IS NULL
    `,
    [dropName, group, actor]
  );
}

// Drop cost overview: committed vs paid with category/vendor/SKU splits.
async function getDropCostOverview(req, res) {
  const dropName = req.params.dropName;
  const client = await pool.connect();
  try {
    const totalsResult = await client.query(
      `
      SELECT
        COALESCE(SUM(b.total_amount), 0) AS committed,
        COALESCE(SUM(p.amount_paid), 0) AS paid
      FROM bills b
      LEFT JOIN payments p ON p.bill_id = b.bill_id
      WHERE b.drop_name = $1
        AND (b.status IS NULL OR b.status NOT IN ('deleted','void'))
      `,
      [dropName]
    );
    const committed = Number(totalsResult.rows[0]?.committed || 0);
    const paid = Number(totalsResult.rows[0]?.paid || 0);

    const byCategory = await client.query(
      `
      SELECT
        COALESCE(b.category, 'Uncategorized') AS category,
        SUM(b.total_amount) AS committed,
        COALESCE(SUM(p.amount_paid), 0) AS paid
      FROM bills b
      LEFT JOIN payments p ON p.bill_id = b.bill_id
      WHERE b.drop_name = $1
        AND (b.status IS NULL OR b.status NOT IN ('deleted','void'))
      GROUP BY COALESCE(b.category, 'Uncategorized')
      ORDER BY committed DESC
      `,
      [dropName]
    );

    const byVendor = await client.query(
      `
      SELECT
        v.vendor_name,
        SUM(b.total_amount) AS committed,
        COALESCE(SUM(p.amount_paid), 0) AS paid
      FROM bills b
      JOIN vendors v ON v.vendor_id = b.vendor_id
      LEFT JOIN payments p ON p.bill_id = b.bill_id
      WHERE b.drop_name = $1
        AND (b.status IS NULL OR b.status NOT IN ('deleted','void'))
      GROUP BY v.vendor_name
      ORDER BY committed DESC
      LIMIT 20
      `,
      [dropName]
    );

    const perSku = await client.query(
      `
      SELECT
        bi.sku_code,
        SUM(bi.amount) AS spend
      FROM bill_items bi
      JOIN bills b ON b.bill_id = bi.bill_id
      WHERE b.drop_name = $1
        AND bi.sku_code IS NOT NULL
        AND (b.status IS NULL OR b.status NOT IN ('deleted','void'))
      GROUP BY bi.sku_code
      ORDER BY spend DESC
      `,
      [dropName]
    );

    const byGroupResult = await client.query(
      `
      SELECT
        COALESCE(b.category_group, 'OPERATING') AS category_group,
        SUM(b.total_amount) AS committed,
        COALESCE(SUM(p.amount_paid), 0) AS paid
      FROM bills b
      LEFT JOIN payments p ON p.bill_id = b.bill_id
      WHERE b.drop_name = $1
        AND (b.status IS NULL OR b.status NOT IN ('deleted','void'))
      GROUP BY COALESCE(b.category_group, 'OPERATING')
      ORDER BY committed DESC
      `,
      [dropName]
    );

    const budgetRows = await client.query(
      `
      SELECT department AS category_group, amount, start_date, end_date
      FROM drop_budgets
      WHERE drop_name = $1
      ORDER BY department
      `,
      [dropName]
    );

    const groupMap = {};
    byGroupResult.rows.forEach(r => {
      const key = r.category_group || 'OPERATING';
      groupMap[key] = {
        category_group: key,
        committed: Number(r.committed || 0),
        paid: Number(r.paid || 0),
        outstanding: Number(r.committed || 0) - Number(r.paid || 0)
      };
    });

    const budgetSummary = [];
    let totalBudget = 0;
    let totalActual = 0;
    budgetRows.rows.forEach(b => {
      const key = b.category_group || 'OPERATING';
      const actual = groupMap[key] || { committed: 0 };
      const budgetAmount = Number(b.amount || 0);
      const committedActual = Number(actual.committed || 0);
      const variance = budgetAmount - committedActual;
      totalBudget += budgetAmount;
      totalActual += committedActual;
      budgetSummary.push({
        category_group: key,
        budget_amount: budgetAmount,
        actual_amount: committedActual,
        variance,
        start_date: b.start_date,
        end_date: b.end_date
      });
    });

    Object.keys(groupMap).forEach(key => {
      if (!budgetSummary.find(b => b.category_group === key)) {
        const committedActual = Number(groupMap[key].committed || 0);
        budgetSummary.push({
          category_group: key,
          budget_amount: 0,
          actual_amount: committedActual,
          variance: 0 - committedActual,
          start_date: null,
          end_date: null
        });
        totalActual += committedActual;
      }
    });

    res.json({
      dropName,
      totals: {
        committed,
        paid,
        outstanding: committed - paid
      },
      byCategory: byCategory.rows.map(r => ({
        category: r.category,
        committed: Number(r.committed || 0),
        paid: Number(r.paid || 0),
        outstanding: (Number(r.committed || 0) - Number(r.paid || 0))
      })),
      byVendor: byVendor.rows.map(r => ({
        vendor_name: r.vendor_name,
        committed: Number(r.committed || 0),
        paid: Number(r.paid || 0)
      })),
      byGroup: Object.values(groupMap),
      budgetSummary,
      budgetTotals: {
        budgeted: totalBudget,
        actual: totalActual,
        variance: totalBudget - totalActual
      },
      perSku: perSku.rows.map(r => ({
        sku_code: r.sku_code,
        spend: Number(r.spend || 0)
      })),
      budgets: budgetRows.rows
    });
  } catch (err) {
    console.error('Drop cost overview error', err);
    res.status(500).json({ error: 'Failed to load drop cost overview' });
  } finally {
    client.release();
  }
}

async function getMaxCacTiers(req, res) {
  try {
    const dropId = req.query.dropId ? Number(req.query.dropId) : null;
    const data = await getMaxCacByTier(Number.isFinite(dropId) ? dropId : null);
    res.json({ success: true, drop_id: dropId, data });
  } catch (err) {
    console.error('Max CAC tiers error', err);
    res.status(500).json({ success: false, error: err.message });
  }
}

async function getMaxCacSizes(req, res) {
  try {
    const skuId = req.query.sku_id ? Number(req.query.sku_id) : null;
    const data = await getMaxCacBySize(skuId);
    res.json({ success: true, sku_id: skuId, data });
  } catch (err) {
    console.error('Max CAC sizes error', err);
    res.status(500).json({ success: false, error: err.message });
  }
}

module.exports = {
  getFinanceSummary,
  getDropOverview,
  getSkuOverview,
  getWatchdog,
  getAlerts,
  runBudgetAlerts,
  getAlertSummary,
  getGuardrails,
  checkInvariants,
  getDropCostOverview,
  getMaxCacTiers,
  getMaxCacSizes
};
