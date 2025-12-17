// Very lightweight heuristic extractor as fallback when AI is unavailable
const KEYWORDS_TOTAL = /(grand\s+total|total\b|amount\s+due|amount\s+payable|net\s+amount|bill\s+amount|amount\s+paid|paid\s+amount|payment\s+amount|txn\s+amount|debit\s+amount)/i;
const KEYWORDS_VENDOR_HINT = /(gstin|bill\s+to|invoice\s+to|vendor|supplier|merchant|shop|petrol pump)/i;
const KEYWORDS_REFERENCE = /(txn|transaction|reference|ref\.?|utr|rrn|qr\s*code|qr\s*id|upi\s*(?:id|ref)|payment\s*id|order\s*id)/i;
const MONTHS = {
  january: 1, jan: 1,
  february: 2, feb: 2,
  march: 3, mar: 3,
  april: 4, apr: 4,
  may: 5,
  june: 6, jun: 6,
  july: 7, jul: 7,
  august: 8, aug: 8,
  september: 9, sep: 9, sept: 9,
  october: 10, oct: 10,
  november: 11, nov: 11,
  december: 12, dec: 12
};

const SNIPPET_LIMIT = 160;

function clampConfidence(value) {
  if (Number.isNaN(value) || !Number.isFinite(value)) return 0.5;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return Number(value.toFixed(3));
}

function buildSnippet(str) {
  if (!str) return null;
  const normalized = str.toString().replace(/\s+/g, ' ').trim();
  if (!normalized) return null;
  return normalized.length > SNIPPET_LIMIT
    ? `${normalized.slice(0, SNIPPET_LIMIT - 3)}...`
    : normalized;
}

function tokenize(text) {
  return text
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean);
}

function extractVendorCandidates(lines) {
  const candidates = [];
  for (let i = 0; i < Math.min(lines.length, 10); i += 1) {
    const line = lines[i];
    if (!line) continue;
    if (/invoice|bill|total|amount|gst|pan|date|qty|price|cash memo/i.test(line)) continue;
    if (/\d/.test(line) && !KEYWORDS_VENDOR_HINT.test(line)) continue;
    candidates.push(line.substring(0, 120));
  }
  if (candidates.length === 0 && lines.length) {
    candidates.push(lines[0].substring(0, 120));
  }
  return [...new Set(candidates)].filter(Boolean);
}

function extractDetailedDateCandidates(text) {
  if (!text) return [];
  const seen = new Set();
  const candidates = [];
  const pushCandidate = (value, snippet, source, confidence, meta = {}) => {
    if (!value) return;
    const key = `${value}:${source}`;
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push({
      value,
      evidence: buildSnippet(snippet || value),
      source,
      confidence: clampConfidence(confidence),
      ambiguous: Boolean(meta.ambiguous)
    });
  };

  const numericRegex = /(\d{4}[-/\.]\d{1,2}[-/\.]\d{1,2})|(\d{1,2}[-/\.]\d{1,2}[-/\.]\d{2,4})/g;
  let m;
  while ((m = numericRegex.exec(text)) !== null) {
    const normalized = normalizeNumericDate(m[0]);
    if (!normalized) continue;
    const base = normalized.ambiguous ? 0.55 : 0.7;
    pushCandidate(normalized.value, m[0], 'numeric', base, { ambiguous: normalized.ambiguous });
  }

  const textRegex1 = /(\d{1,2})(?:st|nd|rd|th)?\s+(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+(?:,?\s*)?(\d{2,4})/gi;
  while ((m = textRegex1.exec(text)) !== null) {
    const normalized = normalizeTextualDate(m[1], m[2], m[3]);
    if (!normalized) continue;
    pushCandidate(normalized, m[0], 'textual', 0.72);
  }

  const textRegex2 = /(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s*)?(\d{2,4})/gi;
  while ((m = textRegex2.exec(text)) !== null) {
    const normalized = normalizeTextualDate(m[2], m[1], m[3]);
    if (!normalized) continue;
    pushCandidate(normalized, m[0], 'textual', 0.72);
  }

  const hyphenRegex = /(\d{1,2})[-](Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)[-]'?(\d{2,4})/gi;
  while ((m = hyphenRegex.exec(text)) !== null) {
    const normalized = normalizeTextualDate(m[1], m[2], m[3]);
    if (!normalized) continue;
    pushCandidate(normalized, m[0], 'textual', 0.7);
  }

  const contextRegex = /(bill\s+date|invoice\s+date|dated|date\s*[:\-]|payment\s+date|paid\s+on|amount\s+paid\s+on|transaction\s+date|txn\s+date)\s*(?:[:\-]|\s)?([0-9]{1,2}[\/\-.][0-9]{1,2}[\/\-.][0-9]{2,4})/gi;
  while ((m = contextRegex.exec(text)) !== null) {
    const normalized = normalizeNumericDate(m[2]);
    if (!normalized) continue;
    const snippet = `${m[1]} ${m[2]}`.trim();
    pushCandidate(normalized.value, snippet, 'contextual', 0.9, { ambiguous: normalized.ambiguous });
  }

  return candidates.sort((a, b) => {
    if (a.confidence !== b.confidence) return b.confidence - a.confidence;
    return a.value.localeCompare(b.value);
  });
}

function normalizeNumericDate(str) {
  const cleaned = str.replace(/[^0-9/.-]/g, '');
  const parts = cleaned.split(/[-/\.]/).map(p => parseInt(p, 10)).filter(n => !Number.isNaN(n));
  if (parts.length !== 3) return null;
  let [a, b, c] = parts;

  const coerceYear = (value) => {
    if (value < 100) {
      // Treat small numbers as 2000+; large two-digit (>=90) more likely 1900s.
      return value >= 90 ? value + 1900 : value + 2000;
    }
    return value;
  };

  const inRange = (year) => year >= 1900 && year <= 2100;

  let year;
  let month;
  let day;

  let ambiguous = false;

  if (a > 1900) {
    year = a;
    month = b;
    day = c;
  } else if (c > 1900) {
    year = c;
    month = b;
    day = a;
  } else {
    year = coerceYear(c);
    if (!inRange(year)) return null;
    if (a > 12 && b <= 12) {
      if (a <= 12 && b <= 12) {
        ambiguous = true;
      }
      day = a;
      month = b;
    } else if (b > 12 && a <= 12) {
      day = b;
      month = a;
    } else {
      // Default to DD/MM layout (most Indian bills)
      if (a <= 12 && b <= 12) {
        ambiguous = true;
      }
      day = a;
      month = b;
    }
  }

  year = coerceYear(year);
  if (!inRange(year)) return null;
  if (!isValidMonthDay(month, day)) return null;

  return {
    value: `${year}-${pad(month)}-${pad(day)}`,
    ambiguous
  };
}

function normalizeTextualDate(dayStr, monthStr, yearStr) {
  if (!dayStr || !monthStr || !yearStr) return null;
  const day = parseInt(dayStr.replace(/\D/g, ''), 10);
  if (Number.isNaN(day) || day < 1 || day > 31) return null;
  const monthKey = monthStr.toLowerCase();
  const month = MONTHS[monthKey];
  if (!month) return null;
  let year = parseInt(yearStr, 10);
  if (Number.isNaN(year)) return null;
  if (year < 100) year += 2000;
  if (year < 1900 || year > 2100) return null;
  return `${year}-${pad(month)}-${pad(day)}`;
}

function pad(n) {
  return String(n).padStart(2, '0');
}

function isValidMonthDay(month, day) {
  if (!month || !day) return false;
  if (month < 1 || month > 12) return false;
  if (day < 1 || day > 31) return false;
  const thirtyDayMonths = [4, 6, 9, 11];
  if (thirtyDayMonths.includes(month) && day > 30) return false;
  if (month === 2 && day > 29) return false;
  return true;
}

function extractCurrencyCandidates(lines) {
  const candidates = [];
  lines.forEach((line, index) => {
    if (!line) return;
    const cleanedLine = line.replace(/\s+/g, ' ');
    const hasCurrency = /₹|rs\.?|inr/i.test(cleanedLine);
    const hasKeyword = KEYWORDS_TOTAL.test(cleanedLine);
    if (!hasCurrency && !hasKeyword) return;
    const isReferenceLine = KEYWORDS_REFERENCE.test(cleanedLine);
    if (isReferenceLine && !hasKeyword) return;

    const matches = cleanedLine.replace(/[,]/g, '').match(/(\d+(?:\.\d+)?)/g);
    if (!matches) return;
    matches.forEach(numStr => {
      const value = parseFloat(numStr);
      if (Number.isNaN(value) || value <= 0) return;
       const digits = numStr.replace(/\D/g, '').length;
       if (digits >= 9 && !hasKeyword && !hasCurrency) return;
      candidates.push({
        value,
        line: cleanedLine,
        index,
        hasCurrency,
        hasKeyword
      });
    });
  });
  return candidates.sort((a, b) => {
    if (a.hasKeyword !== b.hasKeyword) return a.hasKeyword ? -1 : 1;
    if (a.hasCurrency !== b.hasCurrency) return a.hasCurrency ? -1 : 1;
    if (a.value !== b.value) return b.value - a.value;
    return a.index - b.index;
  });
}

function extractContextualAmountCandidates(text) {
  if (!text) return [];
  const candidates = [];
  const ctxRegex = /(amount\s+(?:paid|debited|credited|received|totalled)|payment\s+amount|bill\s+amount|total\s+bill|fare\s+amount|fuel\s+amount)\s*(?:[:\-]|\s|is)?\s*(?:₹|rs\.?|inr)?\s*([\d,]+(?:\.\d+)?)/gi;
  let m;
  while ((m = ctxRegex.exec(text)) !== null) {
    const value = parseFloat(m[2].replace(/,/g, ''));
    if (Number.isNaN(value) || value <= 0) continue;
    candidates.push({
      value,
      line: m[0],
      index: -1,
      hasCurrency: true,
      hasKeyword: true
    });
  }
  return candidates;
}

function extractRupeeMatches(text) {
  const regex = /(?:₹|rs\.?|inr)\s*([\d,.]+(?:\.\d+)?)/gi;
  const values = [];
  let m;
  while ((m = regex.exec(text)) !== null) {
    const val = parseFloat(m[1].replace(/,/g, ''));
    if (!Number.isNaN(val)) values.push(val);
  }
  return values;
}

function guessLargestAmount(text) {
  if (!text) return 0;
  const rupeeValues = extractRupeeMatches(text);
  if (rupeeValues.length > 0) {
    return rupeeValues.reduce((max, curr) => (curr > max ? curr : max), 0);
  }
  const genericMatches = text.replace(/,/g, '').match(/(\d+(?:\.\d+)?)/g);
  if (!genericMatches) return 0;
  return genericMatches.reduce((max, curr) => {
    const val = parseFloat(curr);
    if (Number.isNaN(val)) return max;
    return val > max ? val : max;
  }, 0);
}

function detectSimpleReceipt(rawText, totals) {
  if (!rawText) return null;
  const lower = rawText.toLowerCase();
  const patterns = [
    { type: 'fuel', keywords: ['petrol', 'diesel', 'bharat petroleum', 'indian oil', 'hpcl'] },
    { type: 'cab', keywords: ['uber', 'ola', 'rapido', 'meru'] },
    { type: 'flight', keywords: ['air india', 'indigo', 'vistara', 'pnr'] },
    { type: 'upi', keywords: ['upi', 'gpay', 'google pay', 'phonepe', 'paytm', 'amazon pay'] }
  ];
  return patterns.find(pattern =>
    pattern.keywords.some(keyword => lower.includes(keyword))
  ) || null;
}

function buildTotalCandidates(rawText, lines) {
  if (!rawText) return [];
  const lineCurrencyCandidates = extractCurrencyCandidates(lines);
  const contextualCandidates = extractContextualAmountCandidates(rawText);
  const currencyCandidates = [...contextualCandidates, ...lineCurrencyCandidates];
  const enriched = currencyCandidates.map((candidate, idx) => {
    const snippet = buildSnippet(candidate.line);
    const base = 0.45 + Math.max(0, 4 - idx) * 0.05;
    const keywordBoost = candidate.hasKeyword ? 0.25 : 0;
    const currencyBoost = candidate.hasCurrency ? 0.2 : 0;
    const source = candidate.hasKeyword
      ? 'keyword_line'
      : (candidate.hasCurrency ? 'currency_line' : 'context');
    return {
      value: candidate.value,
      line: candidate.line,
      index: candidate.index,
      hasCurrency: candidate.hasCurrency,
      hasKeyword: candidate.hasKeyword,
      source,
      evidence: snippet,
      confidence: clampConfidence(base + keywordBoost + currencyBoost)
    };
  });

  if (enriched.length === 0) {
    const guessed = guessLargestAmount(rawText);
    if (guessed) {
      enriched.push({
        value: guessed,
        line: '',
        index: -1,
        hasCurrency: false,
        hasKeyword: false,
        source: 'largest_number',
        evidence: null,
        confidence: 0.35
      });
    }
  }

  return enriched.sort((a, b) => {
    if (a.confidence !== b.confidence) return b.confidence - a.confidence;
    if (a.value !== b.value) return b.value - a.value;
    return a.index - b.index;
  });
}

function extractWithRules(rawText) {
  if (!rawText || rawText.length < 10) return null;
  const lines = tokenize(rawText);
  const vendorCandidates = extractVendorCandidates(lines);
  const dateCandidatesDetailed = extractDetailedDateCandidates(rawText);
  const dateCandidates = dateCandidatesDetailed.map(c => c.value);
  const totalCandidateList = buildTotalCandidates(rawText, lines);
  const bestTotal = totalCandidateList[0] || null;
  const simplePattern = detectSimpleReceipt(rawText, { total: bestTotal?.value || 0 });
  const totalValue = bestTotal?.value || 0;

  return {
    vendor_name: vendorCandidates[0] || null,
    vendor_candidates: vendorCandidates,
    bill_date: dateCandidates[0] || null,
    date_candidates: dateCandidates,
    bill_date_candidates: dateCandidatesDetailed,
    amounts: {
      subtotal: null,
      tax_amount: null,
      total: totalValue
    },
    total_candidates: totalCandidateList,
    bill_number: null,
    receipt_hint: simplePattern?.type || null,
    flags: {
      ambiguousDate: dateCandidatesDetailed.some(c => c.ambiguous),
      missingDate: dateCandidatesDetailed.length === 0,
      missingTotal: !bestTotal,
      multipleTotals: totalCandidateList.length > 1
    }
  };
}

module.exports = { extractWithRules, extractDetailedDateCandidates, buildTotalCandidates };
