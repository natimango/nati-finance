const pool = require('../src/config/database');
const { processDocumentWithAI, canAttemptReprocess } = require('../src/controllers/uploadController');
const { getRawTextFromDoc } = require('../src/utils/ocrCache');

const NIGHTLY_LIMIT = Math.max(parseInt(process.env.NIGHTLY_REVERIFY_LIMIT || '25', 10), 5);
const DAYS_AGO = Math.max(parseInt(process.env.NIGHTLY_REVERIFY_DAYS || '30', 10), 1);

async function runNightlyVerification() {
  try {
    console.log('🔁 Starting nightly verification worker…');
    const result = await pool.query(
      `
    SELECT d.*,
           COALESCE(b.payment_method, d.payment_method) AS effective_payment_method,
           b.drop_name,
           b.bill_date,
           b.total_amount
    FROM documents d
    LEFT JOIN bills b ON b.document_id = d.document_id
    WHERE COALESCE(d.status, 'uploaded') <> 'deleted'
      AND (
        d.verification_status IN ('needs_review','unverified')
        OR b.bill_date IS NULL
        OR b.total_amount IS NULL
      )
      AND d.uploaded_at >= NOW() - ($1 || ' DAYS')::interval
    ORDER BY d.uploaded_at ASC
    LIMIT $2
    `,
      [DAYS_AGO, NIGHTLY_LIMIT]
    );

    let processed = 0;
    let skipped = 0;

    for (const document of result.rows) {
      if (!canAttemptReprocess(document)) {
        skipped += 1;
        continue;
      }
      const rawText = getRawTextFromDoc(document);
      const paymentMethod = (document.effective_payment_method || 'UNSPECIFIED').toUpperCase();
      try {
        const reprocessResult = await processDocumentWithAI(
          {
            ...document,
            payment_method: paymentMethod,
            drop_name: document.drop_name || null
          },
          rawText,
          paymentMethod,
          {
            actorType: 'system',
            actorId: null,
            sourceAction: 'nightly_reverify'
          }
        );
        if (reprocessResult && reprocessResult.success) {
          processed += 1;
        }
      } catch (error) {
        console.error('Nightly reverify error:', error);
      }
    }

    console.log(`Nightly verification finished: processed=${processed}, skipped=${skipped}, total=${result.rowCount}`);
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  runNightlyVerification()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('Nightly verification failed:', err);
      process.exit(1);
    });
} else {
  module.exports = runNightlyVerification;
}
