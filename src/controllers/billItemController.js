const pool = require('../config/database');
const { logDocumentFieldChange } = require('../utils/documentAudit');
const { buildVerificationSnapshot } = require('./uploadController');

async function patchBillItem(req, res) {
  const { id } = req.params;
  const {
    coa_account_id,
    department_id,
    drop_id,
    is_postable,
    posting_status,
    go_live_eligible,
    cost_nature,
    cost_stage
  } = req.body;

  try {
    const current = await pool.query(
      `SELECT bi.*, b.document_id
       FROM bill_items bi
       LEFT JOIN bills b ON b.bill_id = bi.bill_id
       WHERE bi.item_id = $1`,
      [id]
    );
    if (!current.rows.length) {
      return res.status(404).json({ success: false, error: 'Bill item not found' });
    }
    const existing = current.rows[0];

    const updates = {
      coa_account_id: coa_account_id ?? existing.coa_account_id,
      department_id: department_id ?? existing.department_id,
      drop_id: drop_id ?? existing.drop_id,
      is_postable: typeof is_postable === 'boolean' ? is_postable : existing.is_postable,
      posting_status: posting_status || existing.posting_status,
      go_live_eligible: typeof go_live_eligible === 'boolean' ? go_live_eligible : existing.go_live_eligible,
      cost_nature: cost_nature ?? existing.cost_nature,
      cost_stage: cost_stage ?? existing.cost_stage
    };

    if (!updates.is_postable) {
      updates.posting_status = 'unposted';
    }

    if (updates.posting_status === 'posted') {
      if (!updates.coa_account_id || !updates.department_id || !updates.drop_id) {
        return res.status(400).json({
          success: false,
          error: 'Posting requires CoA, department, and drop assignments'
        });
      }
    }

    await pool.query(
      `
      UPDATE bill_items
      SET coa_account_id = $1,
          department_id = $2,
          drop_id = $3,
          is_postable = $4,
          posting_status = $5,
          go_live_eligible = $6,
          cost_nature = $7,
          cost_stage = $8
      WHERE item_id = $9
      `,
      [
        updates.coa_account_id,
        updates.department_id,
        updates.drop_id,
        updates.is_postable,
        updates.posting_status,
        updates.go_live_eligible,
        updates.cost_nature,
        updates.cost_stage,
        id
      ]
    );

    const fields = [
      { field: 'coa_account_id', oldValue: existing.coa_account_id, newValue: updates.coa_account_id },
      { field: 'department_id', oldValue: existing.department_id, newValue: updates.department_id },
      { field: 'drop_id', oldValue: existing.drop_id, newValue: updates.drop_id },
      { field: 'is_postable', oldValue: existing.is_postable, newValue: updates.is_postable },
      { field: 'posting_status', oldValue: existing.posting_status, newValue: updates.posting_status }
      ,{ field: 'go_live_eligible', oldValue: existing.go_live_eligible, newValue: updates.go_live_eligible },
      { field: 'cost_nature', oldValue: existing.cost_nature, newValue: updates.cost_nature },
      { field: 'cost_stage', oldValue: existing.cost_stage, newValue: updates.cost_stage }
    ];

    const operationId = require('crypto').randomUUID();
    for (const entry of fields) {
      await logDocumentFieldChange({
        documentId: existing.document_id || null,
        fieldName: `bill_items.${entry.field}`,
        oldValue: entry.oldValue,
        newValue: entry.newValue,
        actorType: req.user?.role || 'user',
        actorId: req.user?.userId || null,
        reason: 'quality_gate',
        evidence: 'manual correction',
        operationId,
        sourceAction: 'manual_posting'
      });
    }

    const updatedItem = await pool.query('SELECT * FROM bill_items WHERE item_id = $1', [id]);

    const docRow = await pool.query(
      `SELECT d.*, b.total_amount
       FROM documents d
       LEFT JOIN bills b ON b.document_id = d.document_id
       WHERE d.document_id = $1
       LIMIT 1`,
      [existing.document_id]
    );
    const doc = docRow.rows[0] || {};

    const qualitySummary = await buildVerificationSnapshot(doc);

    res.json({
      success: true,
      item: updatedItem.rows[0],
      document: {
        document_id: doc.document_id,
        verification: qualitySummary
      }
    });
  } catch (error) {
    console.error('Patch bill item error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
}

module.exports = { patchBillItem };
