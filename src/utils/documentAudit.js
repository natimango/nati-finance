const pool = require('../config/database');

function normalizeValue(value) {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value);
    } catch (err) {
      return String(value);
    }
  }
  return String(value);
}

async function logDocumentFieldChange({
  documentId,
  fieldName,
  oldValue,
  newValue,
  actorType = 'system',
  actorId = null,
  reason = null,
  confidence = null,
  evidence = null,
  operationId = null,
  sourceAction = null
}) {
  const oldNorm = normalizeValue(oldValue);
  const newNorm = normalizeValue(newValue);
  if (oldNorm === newNorm) return;
  if (!documentId || !fieldName) return;
  await pool.query(
    `INSERT INTO document_field_history
      (document_id, field_name, old_value, new_value, actor_type, actor_id, reason, confidence, evidence, operation_id, source_action)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      documentId,
      fieldName,
      oldNorm,
      newNorm,
      actorType,
      actorId,
      reason,
      confidence,
      evidence ? normalizeValue(evidence) : null,
      operationId,
      sourceAction
    ]
  );
}

module.exports = {
  logDocumentFieldChange
};
