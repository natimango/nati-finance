const pool = require('../config/database');

const ALERT_TYPES = {
  agedNeedsReview: 'DOC_NEEDS_REVIEW_AGED',
  lowQuality: 'DOC_LOW_QUALITY',
  highValue: 'DOC_HIGH_VALUE_NEEDS_REVIEW',
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
    const [dupes, oversized, staleDocs, agedUnpaid, budgetsOpen] = await Promise.all([
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
    res.json({
      summary: {
        duplicates: dupes.rowCount,
        oversized: oversized.rowCount,
        stale_manual: staleDocs.rowCount,
        aged_unpaid: agedUnpaid.rowCount,
        budget: budgetsOpen.rowCount
      },
      duplicates: dupes.rows,
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

module.exports = {
  getFinanceSummary,
  getDropOverview,
  getSkuOverview,
  getWatchdog,
  getAlerts,
  runBudgetAlerts,
  getDropCostOverview
};
