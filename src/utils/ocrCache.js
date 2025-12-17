const crypto = require('crypto');
const pool = require('../config/database');

function hashRawText(rawText) {
  return crypto.createHash('sha256').update(rawText).digest('hex');
}

const DEFAULT_OCR_VERSION = parseInt(process.env.OCR_VERSION || '1', 10);

async function storeRawText(documentId, rawText, meta = {}, options = {}) {
  if (!documentId || !rawText) return;

  const hash = hashRawText(rawText);
  const engine = meta?.type || null;
  const version = meta?.version != null ? meta.version : DEFAULT_OCR_VERSION;
  const fileHash = options?.fileHash || null;

  await pool.query(
    `UPDATE documents
        SET raw_text = $1,
            raw_text_hash = $2,
            ocr_engine = $3,
            ocr_version = $4,
            file_hash = COALESCE($5, file_hash)
      WHERE document_id = $6`,
    [rawText, hash, engine, version, fileHash, documentId]
  );

  await pool.query(
    `UPDATE documents
        SET gemini_data = jsonb_set(
            COALESCE(gemini_data, '{}'::jsonb),
            '{raw_text}',
            to_jsonb($1::text),
            true
        )
      WHERE document_id = $2`,
    [rawText, documentId]
  );

  await pool.query(
    `UPDATE documents
        SET gemini_data = jsonb_set(
            COALESCE(gemini_data, '{}'::jsonb),
            '{preprocess_meta}',
            $1::jsonb,
            true
        )
      WHERE document_id = $2`,
    [JSON.stringify(meta || {}), documentId]
  );
}

function getRawTextFromDoc(doc) {
  if (!doc) return null;
  if (doc.raw_text) return doc.raw_text;
  if (doc.gemini_data && typeof doc.gemini_data === 'object' && doc.gemini_data.raw_text) {
    return doc.gemini_data.raw_text;
  }
  if (typeof doc.gemini_data === 'string') {
    try {
      const parsed = JSON.parse(doc.gemini_data);
      return parsed?.raw_text || null;
    } catch (_) {
      return null;
    }
  }
  return null;
}

module.exports = {
  storeRawText,
  getRawTextFromDoc
};
