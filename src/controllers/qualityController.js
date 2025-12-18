const pool = require('../config/database');

async function getQualitySummary(req, res) {
  try {
    const totalResult = await pool.query(
      `
      SELECT
        COUNT(*) AS total_docs,
        SUM(unposted_amount) AS total_unposted_amount,
        SUM(CASE WHEN unposted_count > 0 THEN 1 ELSE 0 END) AS docs_with_unposted
      FROM (
        SELECT d.document_id,
               COALESCE(b.bill_id, 0) AS bill_id,
               (
                 SELECT COUNT(*)
                 FROM bill_items bi
                 WHERE bi.bill_id = b.bill_id
                   AND bi.is_postable
                   AND bi.posting_status <> 'posted'
               ) AS unposted_count,
               (
                 SELECT COALESCE(SUM(bi.amount), 0)
                 FROM bill_items bi
                 WHERE bi.bill_id = b.bill_id
                   AND bi.is_postable
                   AND bi.posting_status <> 'posted'
               ) AS unposted_amount
        FROM documents d
        LEFT JOIN bills b ON b.document_id = d.document_id
      ) sub
      `
    );

    const missingResult = await pool.query(
      `
      SELECT
        COALESCE(SUM(bi.amount), 0) FILTER (WHERE bi.coa_account_id IS NULL) AS missing_coa_amount,
        COALESCE(SUM(bi.amount), 0) FILTER (WHERE bi.department_id IS NULL) AS missing_department_amount,
        COALESCE(SUM(bi.amount), 0) FILTER (WHERE bi.drop_id IS NULL) AS missing_drop_amount
      FROM bill_items bi
      WHERE bi.is_postable
        AND bi.posting_status <> 'posted'
      `
    );

    const summary = {
      total_documents: Number(totalResult.rows[0]?.total_docs || 0),
      documents_with_unposted: Number(totalResult.rows[0]?.docs_with_unposted || 0),
      unposted_amount: Number(totalResult.rows[0]?.total_unposted_amount || 0),
      missing_coa_amount: Number(missingResult.rows[0]?.missing_coa_amount || 0),
      missing_department_amount: Number(missingResult.rows[0]?.missing_department_amount || 0),
      missing_drop_amount: Number(missingResult.rows[0]?.missing_drop_amount || 0)
    };

    res.json({
      success: true,
      summary
    });
  } catch (error) {
    console.error('Quality summary error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
}

module.exports = { getQualitySummary };
