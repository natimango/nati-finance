const pool = require('../config/database');

// Get Profit & Loss Statement
async function getProfitLoss(req, res) {
  try {
    const { start_date, end_date } = req.query;
    
    const startDate = start_date || new Date(new Date().getFullYear(), 0, 1).toISOString().split('T')[0];
    const endDate = end_date || new Date().toISOString().split('T')[0];
    
    const billAgg = await pool.query(
      `SELECT 
         COALESCE(category_group, 'OPERATING') AS category_group,
         COALESCE(category, 'misc') AS category,
         SUM(total_amount) AS total
       FROM bills
       WHERE bill_date BETWEEN $1 AND $2
       GROUP BY category_group, category`,
      [startDate, endDate]
    );

    let totalRevenue = 0; // placeholder until sales ingestion
    let totalCOGS = 0;
    let totalExpenses = 0;

    const cogsRows = [];
    const expRows = [];
    const groupTotals = {};

    billAgg.rows.forEach(row => {
      const groupKey = (row.category_group || 'OPERATING').toUpperCase();
      const amt = parseFloat(row.total || 0);
      const label = row.category || 'misc';
      groupTotals[groupKey] = (groupTotals[groupKey] || 0) + amt;

      if (groupKey === 'COGS') {
        totalCOGS += amt;
        cogsRows.push({ account_name: label, amount: amt });
      } else {
        totalExpenses += amt;
        expRows.push({ account_name: `${groupKey} - ${label}`, amount: amt });
      }
    });

    const grossProfit = totalRevenue - totalCOGS;
    const netProfit = grossProfit - totalExpenses;
    
    res.json({
      success: true,
      period: { start_date: startDate, end_date: endDate },
      revenue: {
        accounts: [],
        total: totalRevenue
      },
      cogs: {
        accounts: cogsRows,
        total: totalCOGS
      },
      gross_profit: grossProfit,
      expenses: {
        accounts: expRows,
        total: totalExpenses
      },
      net_profit: netProfit,
      group_totals: groupTotals
    });
    
  } catch (error) {
    console.error('P&L error:', error);
    res.status(500).json({ error: error.message });
  }
}

// Get Trial Balance
async function getTrialBalance(req, res) {
  try {
    const { as_of_date } = req.query;
    const asOfDate = as_of_date || new Date().toISOString().split('T')[0];
    
    const result = await pool.query(`
      SELECT 
        a.account_code,
        a.account_name,
        a.account_type,
        COALESCE(SUM(jel.debit_amount), 0) as total_debit,
        COALESCE(SUM(jel.credit_amount), 0) as total_credit,
        COALESCE(SUM(jel.debit_amount - jel.credit_amount), 0) as balance
      FROM accounts a
      LEFT JOIN journal_entry_lines jel ON a.account_id = jel.account_id
      LEFT JOIN journal_entries je ON jel.journal_id = je.journal_id
      WHERE je.entry_date <= $1 OR je.entry_date IS NULL
      AND (je.status = 'posted' OR je.status IS NULL)
      AND a.is_active = true
      GROUP BY a.account_id, a.account_code, a.account_name, a.account_type
      HAVING COALESCE(SUM(jel.debit_amount - jel.credit_amount), 0) != 0
      ORDER BY a.account_code
    `, [asOfDate]);
    
    const totalDebits = result.rows.reduce((sum, r) => sum + parseFloat(r.total_debit), 0);
    const totalCredits = result.rows.reduce((sum, r) => sum + parseFloat(r.total_credit), 0);
    
    res.json({
      success: true,
      as_of_date: asOfDate,
      accounts: result.rows,
      totals: {
        total_debits: totalDebits,
        total_credits: totalCredits,
        difference: totalDebits - totalCredits
      }
    });
    
  } catch (error) {
    console.error('Trial Balance error:', error);
    res.status(500).json({ error: error.message });
  }
}

// Get Balance Sheet
async function getBalanceSheet(req, res) {
  try {
    const { as_of_date } = req.query;
    const asOfDate = as_of_date || new Date().toISOString().split('T')[0];
    
    // Assets
    const assets = await pool.query(`
      SELECT 
        a.account_code,
        a.account_name,
        SUM(jel.debit_amount - jel.credit_amount) as balance
      FROM accounts a
      LEFT JOIN journal_entry_lines jel ON a.account_id = jel.account_id
      LEFT JOIN journal_entries je ON jel.journal_id = je.journal_id
      WHERE a.account_type = 'ASSET'
      AND (je.entry_date <= $1 OR je.entry_date IS NULL)
      AND (je.status = 'posted' OR je.status IS NULL)
      GROUP BY a.account_id, a.account_code, a.account_name
      HAVING SUM(jel.debit_amount - jel.credit_amount) != 0
      ORDER BY a.account_code
    `, [asOfDate]);
    
    // Liabilities
    const liabilities = await pool.query(`
      SELECT 
        a.account_code,
        a.account_name,
        SUM(jel.credit_amount - jel.debit_amount) as balance
      FROM accounts a
      LEFT JOIN journal_entry_lines jel ON a.account_id = jel.account_id
      LEFT JOIN journal_entries je ON jel.journal_id = je.journal_id
      WHERE a.account_type = 'LIABILITY'
      AND (je.entry_date <= $1 OR je.entry_date IS NULL)
      AND (je.status = 'posted' OR je.status IS NULL)
      GROUP BY a.account_id, a.account_code, a.account_name
      HAVING SUM(jel.credit_amount - jel.debit_amount) != 0
      ORDER BY a.account_code
    `, [asOfDate]);
    
    // Equity
    const equity = await pool.query(`
      SELECT 
        a.account_code,
        a.account_name,
        SUM(jel.credit_amount - jel.debit_amount) as balance
      FROM accounts a
      LEFT JOIN journal_entry_lines jel ON a.account_id = jel.account_id
      LEFT JOIN journal_entries je ON jel.journal_id = je.journal_id
      WHERE a.account_type = 'EQUITY'
      AND (je.entry_date <= $1 OR je.entry_date IS NULL)
      AND (je.status = 'posted' OR je.status IS NULL)
      GROUP BY a.account_id, a.account_code, a.account_name
      HAVING SUM(jel.credit_amount - jel.debit_amount) != 0
      ORDER BY a.account_code
    `, [asOfDate]);
    
    const totalAssets = assets.rows.reduce((sum, r) => sum + parseFloat(r.balance || 0), 0);
    const totalLiabilities = liabilities.rows.reduce((sum, r) => sum + parseFloat(r.balance || 0), 0);
    const totalEquity = equity.rows.reduce((sum, r) => sum + parseFloat(r.balance || 0), 0);
    
    res.json({
      success: true,
      as_of_date: asOfDate,
      assets: {
        accounts: assets.rows,
        total: totalAssets
      },
      liabilities: {
        accounts: liabilities.rows,
        total: totalLiabilities
      },
      equity: {
        accounts: equity.rows,
        total: totalEquity
      },
      total_liabilities_equity: totalLiabilities + totalEquity
    });
    
  } catch (error) {
    console.error('Balance Sheet error:', error);
    res.status(500).json({ error: error.message });
  }
}

// Get Journal Entries (Ledger view)
async function getJournalEntries(req, res) {
  try {
    const { start_date, end_date, account_id } = req.query;
    
    let query = `
      SELECT 
        je.journal_id,
        je.entry_date,
        je.reference_type,
        je.reference_id,
        je.description,
        je.total_debit,
        je.total_credit,
        je.status,
        json_agg(
          json_build_object(
            'line_id', jel.line_id,
            'account_code', a.account_code,
            'account_name', a.account_name,
            'debit', jel.debit_amount,
            'credit', jel.credit_amount,
            'description', jel.description
          ) ORDER BY jel.line_number
        ) as lines
      FROM journal_entries je
      JOIN journal_entry_lines jel ON je.journal_id = jel.journal_id
      JOIN accounts a ON jel.account_id = a.account_id
      WHERE 1=1
    `;
    
    const params = [];
    let paramCount = 1;
    
    if (start_date) {
      query += ` AND je.entry_date >= $${paramCount}`;
      params.push(start_date);
      paramCount++;
    }
    
    if (end_date) {
      query += ` AND je.entry_date <= $${paramCount}`;
      params.push(end_date);
      paramCount++;
    }
    
    if (account_id) {
      query += ` AND jel.account_id = $${paramCount}`;
      params.push(account_id);
      paramCount++;
    }
    
    query += `
      GROUP BY je.journal_id
      ORDER BY je.entry_date DESC, je.journal_id DESC
      LIMIT 100
    `;
    
    const result = await pool.query(query, params);
    
    res.json({
      success: true,
      entries: result.rows
    });
    
  } catch (error) {
    console.error('Journal entries error:', error);
    res.status(500).json({ error: error.message });
  }
}

// Get all accounts (Chart of Accounts)
async function getChartOfAccounts(req, res) {
  try {
    const result = await pool.query(`
      SELECT 
        account_id,
        account_code,
        account_name,
        account_type,
        parent_account_id,
        is_active,
        description
      FROM accounts
      WHERE is_active = true
      ORDER BY account_code
    `);
    
    res.json({
      success: true,
      accounts: result.rows
    });
    
  } catch (error) {
    console.error('Chart of Accounts error:', error);
    res.status(500).json({ error: error.message });
  }
}

// Spend by dimensions (drop/trip) for D2C ops visibility
async function getDimensionSpend(req, res) {
  try {
    const { start_date, end_date } = req.query;
    const startDate = start_date || new Date(new Date().getFullYear(), 0, 1).toISOString().split('T')[0];
    const endDate = end_date || new Date().toISOString().split('T')[0];

    const query = `
      SELECT
        COALESCE(drop_name, 'Unassigned') AS drop_name,
        COALESCE(trip_name, 'Unassigned') AS trip_name,
              'Unassigned' AS channel,
              'Unassigned' AS campaign,
        COALESCE(department, 'Unassigned') AS department,
        SUM(total_amount) AS spend_total,
        SUM(subtotal) AS spend_subtotal,
        SUM(tax_amount) AS spend_tax,
        COUNT(*) AS bill_count
      FROM bills
      WHERE bill_date BETWEEN $1 AND $2
      GROUP BY drop_name, trip_name, department
      ORDER BY spend_total DESC NULLS LAST, bill_count DESC;
    `;

    const result = await pool.query(query, [startDate, endDate]);

    res.json({
      success: true,
      period: { start_date: startDate, end_date: endDate },
      rows: result.rows
    });
  } catch (error) {
    console.error('Dimension spend error:', error);
    res.status(500).json({ error: error.message });
  }
}

// Upsert drop-level budget (drop + department)
async function upsertDropBudget(req, res) {
  try {
    const { drop_name, department, amount, start_date, end_date, notes } = req.body;
    if (!drop_name || !department || !amount || !start_date || !end_date) {
      return res.status(400).json({ error: 'drop_name, department, amount, start_date, end_date are required' });
    }
    const actor = (req.user && (req.user.email || req.user.name)) || 'system';

    const result = await pool.query(
      `INSERT INTO drop_budgets (drop_name, department, amount, start_date, end_date, notes)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (drop_name, department)
       DO UPDATE SET amount = EXCLUDED.amount,
                     start_date = EXCLUDED.start_date,
                     end_date = EXCLUDED.end_date,
                     notes = EXCLUDED.notes,
                     updated_at = CURRENT_TIMESTAMP
       RETURNING *`,
      [drop_name, department, amount, start_date, end_date, notes || null]
    );

    await pool.query(
      `INSERT INTO drop_budget_history
        (drop_name, department, amount, start_date, end_date, notes, changed_by, change_type)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'UPSERT')`,
      [drop_name, department, amount, start_date, end_date, notes || null, actor]
    );

    res.json({ success: true, budget: result.rows[0] });
  } catch (error) {
    console.error('Upsert drop budget error:', error);
    res.status(500).json({ error: error.message });
  }
}

// List drop budgets (optional filter by drop)
async function getDropBudgets(req, res) {
  try {
    const { drop_name } = req.query;
    const params = [];
    let where = '';
    if (drop_name) {
      params.push(drop_name);
      where = 'WHERE drop_name = $1';
    }
    const result = await pool.query(
      `SELECT * FROM drop_budgets ${where} ORDER BY drop_name, department`,
      params
    );
    res.json({ success: true, budgets: result.rows });
  } catch (error) {
    console.error('Get drop budgets error:', error);
    res.status(500).json({ error: error.message });
  }
}

async function getDropBudgetHistory(req, res) {
  try {
    const { drop_name, limit = 100 } = req.query;
    const params = [limit];
    let where = '';
    if (drop_name) {
      params.unshift(drop_name);
      where = 'WHERE drop_name = $1';
      params[1] = limit;
    }
    const query = `
      SELECT drop_name, department, amount, start_date, end_date, notes, changed_by, change_type, created_at
      FROM drop_budget_history
      ${where}
      ORDER BY created_at DESC
      LIMIT $${drop_name ? 2 : 1}
    `;
    const result = await pool.query(query, params);
    res.json({ success: true, history: result.rows });
  } catch (error) {
    console.error('Get drop budget history error:', error);
    res.status(500).json({ error: error.message });
  }
}

// Drop-level variance: budget vs actual spend by department
async function getDropVariance(req, res) {
  try {
    const { start_date, end_date } = req.query;
    const startDate = start_date || new Date(new Date().getFullYear(), 0, 1).toISOString().split('T')[0];
    const endDate = end_date || new Date().toISOString().split('T')[0];

    const budgets = await pool.query(
      `SELECT drop_name, department, amount, start_date, end_date
       FROM drop_budgets
       WHERE start_date <= $2 AND end_date >= $1`,
      [startDate, endDate]
    );

    const actuals = await pool.query(
      `SELECT 
          COALESCE(drop_name, 'Unassigned') AS drop_name,
          COALESCE(department, 'Unassigned') AS department,
          SUM(total_amount) AS spend_total,
          COUNT(*) AS bill_count
       FROM bills
       WHERE bill_date BETWEEN $1 AND $2
       GROUP BY drop_name, department`,
      [startDate, endDate]
    );

    // Map actuals for quick lookup
    const actualMap = {};
    actuals.rows.forEach(r => {
      const key = `${r.drop_name}||${r.department}`;
      actualMap[key] = r;
    });

    const rows = budgets.rows.map(b => {
      const key = `${b.drop_name}||${b.department}`;
      const actual = actualMap[key];
      const actualSpend = parseFloat(actual?.spend_total || 0);
      return {
        drop_name: b.drop_name,
        department: b.department,
        budget_amount: parseFloat(b.amount),
        actual_amount: actualSpend,
        variance: parseFloat(b.amount) - actualSpend,
        bill_count: actual ? parseInt(actual.bill_count, 10) : 0,
        period: { start_date: startDate, end_date: endDate }
      };
    });

    // Also include actuals with no budget for visibility
    actuals.rows.forEach(a => {
      const key = `${a.drop_name}||${a.department}`;
      if (!rows.find(r => `${r.drop_name}||${r.department}` === key)) {
        rows.push({
          drop_name: a.drop_name,
          department: a.department,
          budget_amount: 0,
          actual_amount: parseFloat(a.spend_total || 0),
          variance: 0 - parseFloat(a.spend_total || 0),
          bill_count: parseInt(a.bill_count, 10),
          period: { start_date: startDate, end_date: endDate }
        });
      }
    });

    res.json({ success: true, rows });
  } catch (error) {
    console.error('Drop variance error:', error);
    res.status(500).json({ error: error.message });
  }
}

// Metrics summary: docs by status, spend by vendor/category
async function getMetricsSummary(req, res) {
  try {
    const { start_date, end_date } = req.query;
    const startDate = start_date || new Date(new Date().getFullYear(), 0, 1).toISOString().split('T')[0];
    const endDate = end_date || new Date().toISOString().split('T')[0];

    const docsByStatus = await pool.query(`
      SELECT status, COUNT(*) as count
      FROM documents
      GROUP BY status
    `);

    const spendByVendor = await pool.query(`
      SELECT COALESCE(v.vendor_name, 'Unassigned') as vendor_name, SUM(total_amount) as total
      FROM bills b
      LEFT JOIN vendors v ON b.vendor_id = v.vendor_id
      WHERE b.bill_date BETWEEN $1 AND $2
      GROUP BY v.vendor_name
      ORDER BY total DESC NULLS LAST
      LIMIT 3
    `, [startDate, endDate]);

    const spendByGroup = await pool.query(`
      SELECT COALESCE(category_group, 'OPERATING') as category_group, SUM(total_amount) as total
      FROM bills
      WHERE bill_date BETWEEN $1 AND $2
      GROUP BY category_group
      ORDER BY total DESC NULLS LAST
    `, [startDate, endDate]);

    const spendByCategory = await pool.query(`
      SELECT COALESCE(category, 'uncategorized') as category, SUM(total_amount) as total
      FROM bills
      WHERE bill_date BETWEEN $1 AND $2
      GROUP BY category
      ORDER BY total DESC NULLS LAST
    `, [startDate, endDate]);

    const spendByPayment = await pool.query(`
      SELECT COALESCE(payment_method, 'UNSPECIFIED') as payment_method, SUM(total_amount) as total
      FROM bills
      WHERE bill_date BETWEEN $1 AND $2
      GROUP BY payment_method
      ORDER BY total DESC NULLS LAST
    `, [startDate, endDate]);

    res.json({
      success: true,
      period: { start_date: startDate, end_date: endDate },
      docs_by_status: docsByStatus.rows,
      spend_by_vendor: spendByVendor.rows,
      spend_by_group: spendByGroup.rows,
      spend_by_category: spendByCategory.rows,
      spend_by_payment_method: spendByPayment.rows
    });
  } catch (error) {
    console.error('Metrics summary error:', error);
    res.status(500).json({ error: error.message });
  }
}

// COGS by SKU (from bill_items)
async function getCogsBySku(req, res) {
  try {
    const { sku_code } = req.params;
    const { start_date, end_date } = req.query;
    const startDate = start_date || new Date(new Date().getFullYear(), 0, 1).toISOString().split('T')[0];
    const endDate = end_date || new Date().toISOString().split('T')[0];

    const result = await pool.query(`
      SELECT 
        sku_code,
        SUM(amount) as total_amount,
        SUM(quantity) as total_qty,
        AVG(unit_price) as avg_rate
      FROM bill_items
      WHERE sku_code = $1
        AND EXISTS (
          SELECT 1 FROM bills b WHERE b.bill_id = bill_items.bill_id AND b.bill_date BETWEEN $2 AND $3
        )
      GROUP BY sku_code
    `, [sku_code, startDate, endDate]);

    res.json({
      success: true,
      sku_code,
      period: { start_date: startDate, end_date: endDate },
      summary: result.rows[0] || null
    });
  } catch (error) {
    console.error('COGS by SKU error:', error);
    res.status(500).json({ error: error.message });
  }
}

// Ingest marketing spend (API/CSV hook)
async function ingestMarketingSpend(req, res) {
  try {
    const { channel, campaign, drop_name, amount, spend_date, source, notes } = req.body;
    if (!channel || !amount) {
      return res.status(400).json({ error: 'channel and amount are required' });
    }
    await pool.query(
      `INSERT INTO marketing_spend (channel, campaign, drop_name, amount, spend_date, source, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [channel, campaign || null, drop_name || null, amount, spend_date || new Date(), source || 'API', notes || null]
    );
    res.json({ success: true });
  } catch (error) {
    console.error('Ingest marketing error:', error);
    res.status(500).json({ error: error.message });
  }
}

// Ingest shipment/fulfillment costs
async function ingestShipmentCost(req, res) {
  try {
    const { order_id, carrier, tracking_number, charge_amount, drop_name, sku_code, notes } = req.body;
    if (!charge_amount) return res.status(400).json({ error: 'charge_amount is required' });
    await pool.query(
      `INSERT INTO shipments (order_id, carrier, tracking_number, charge_amount, drop_name, sku_code, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [order_id || null, carrier || null, tracking_number || null, charge_amount, drop_name || null, sku_code || null, notes || null]
    );
    res.json({ success: true });
  } catch (error) {
    console.error('Ingest shipment error:', error);
    res.status(500).json({ error: error.message });
  }
}

module.exports = {
  getProfitLoss,
  getTrialBalance,
  getBalanceSheet,
  getJournalEntries,
  getChartOfAccounts,
  getDimensionSpend,
  upsertDropBudget,
  getDropBudgets,
  getDropBudgetHistory,
  getDropVariance,
  getMetricsSummary,
  getCogsBySku,
  ingestMarketingSpend,
  ingestShipmentCost
};
