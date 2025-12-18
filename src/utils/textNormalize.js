function normalizeSnippet(str) {
  if (!str) return '';
  return String(str)
    .replace(/\u00A0/g, ' ')
    .replace(/₹/g, ' rs ')
    .replace(/\bINR\b/gi, ' rs ')
    .replace(/\bRs\.?\b/gi, ' rs ')
    .replace(/[^\S\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function evidenceMatchesRawText(rawText, evidenceQuote) {
  const normalizedRaw = normalizeSnippet(rawText);
  const normalizedEvidence = normalizeSnippet(evidenceQuote);
  if (!normalizedRaw || !normalizedEvidence) return false;
  return normalizedRaw.includes(normalizedEvidence);
}

module.exports = { normalizeSnippet, evidenceMatchesRawText };
