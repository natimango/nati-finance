const pool = require('../config/database');

async function getDropGoLive(req, res) {
  const dropId = Number(req.params.dropId);
  if (Number.isNaN(dropId)) {
    return res.status(400).json({ success: false, error: 'dropId must be numeric' });
  }

  const dropResult = await pool.query('SELECT drop_name FROM drops WHERE drop_id = $1 AND is_active', [dropId]);
  if (!dropResult.rows.length) {
    return res.status(404).json({ success: false, error: 'Drop not found' });
  }
  const dropName = dropResult.rows[0].drop_name;

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

  const byDepartment = await pool.query(
    `
    SELECT d.department_name, COALESCE(SUM(bi.amount), 0) AS amount
    FROM bill_items bi
    LEFT JOIN departments d ON d.department_id = bi.department_id
    WHERE bi.drop_id = $1
      AND bi.is_postable
      AND bi.go_live_eligible
      AND bi.posting_status = 'posted'
    GROUP BY d.department_name
    ORDER BY amount DESC
    `,
    [dropId]
  );

  const byCoa = await pool.query(
    `
    SELECT ca.account_code, ca.account_name, COALESCE(SUM(bi.amount), 0) AS amount
    FROM bill_items bi
    LEFT JOIN coa_accounts ca ON ca.coa_account_id = bi.coa_account_id
    WHERE bi.drop_id = $1
      AND bi.is_postable
      AND bi.go_live_eligible
      AND bi.posting_status = 'posted'
    GROUP BY ca.account_code, ca.account_name
    ORDER BY amount DESC
    `,
    [dropId]
  );

  const byVendor = await pool.query(
    `
    SELECT COALESCE(v.vendor_name, 'Unassigned') AS vendor_name, COALESCE(SUM(bi.amount), 0) AS amount
    FROM bill_items bi
    JOIN bills b ON b.bill_id = bi.bill_id
    LEFT JOIN vendors v ON v.vendor_id = b.vendor_id
    WHERE bi.drop_id = $1
      AND bi.is_postable
      AND bi.go_live_eligible
      AND bi.posting_status = 'posted'
    GROUP BY vendor_name
    ORDER BY amount DESC
    `,
    [dropId]
  );

  const byNature = await pool.query(
    `
    SELECT bi.cost_nature, COALESCE(SUM(bi.amount), 0) AS amount
    FROM bill_items bi
    WHERE bi.drop_id = $1
      AND bi.is_postable
      AND bi.go_live_eligible
      AND bi.posting_status = 'posted'
      AND bi.cost_nature IS NOT NULL
    GROUP BY bi.cost_nature
    ORDER BY amount DESC
    `,
    [dropId]
  );

  const byStage = await pool.query(
    `
    SELECT bi.cost_stage, COALESCE(SUM(bi.amount), 0) AS amount
    FROM bill_items bi
    WHERE bi.drop_id = $1
      AND bi.is_postable
      AND bi.go_live_eligible
      AND bi.posting_status = 'posted'
      AND bi.cost_stage IS NOT NULL
    GROUP BY bi.cost_stage
    ORDER BY amount DESC
    `,
    [dropId]
  );

  res.json({
    success: true,
    drop: {
      drop_id: dropId,
      drop_name: dropName
    },
    totals: {
      total_go_live_cost: Number(totals.rows[0]?.total_go_live_cost || 0),
      excluded_unposted_amount: Number(unposted.rows[0]?.excluded_unposted_amount || 0),
      unposted_go_live_count: Number(unposted.rows[0]?.unposted_go_live_count || 0)
    },
    breakdowns: {
      by_department: byDepartment.rows,
      by_coa_account: byCoa.rows,
      by_vendor: byVendor.rows,
      by_cost_nature: byNature.rows,
      by_cost_stage: byStage.rows
    }
  });
}

module.exports = { getDropGoLive };
