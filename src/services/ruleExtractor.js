// Very lightweight heuristic extractor as fallback when AI is unavailable
const KEYWORDS_TOTAL = /(grand\s+total|total\b|amount\s+due|amount\s+payable|net\s+amount|bill\s+amount)/i;
const KEYWORDS_VENDOR_HINT = /(gstin|bill\s+to|invoice\s+to|vendor|supplier|merchant|shop|petrol pump)/i;
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

function extractDateCandidates(text) {
  const matches = [];
  const numericRegex = /(\d{4}[-/\.]\d{1,2}[-/\.]\d{1,2})|(\d{1,2}[-/\.]\d{1,2}[-/\.]\d{2,4})/g;
  let m;
  while ((m = numericRegex.exec(text)) !== null) {
    const normalized = normalizeNumericDate(m[0]);
    if (normalized) matches.push(normalized);
  }

  const textRegex1 = /(\d{1,2})(?:st|nd|rd|th)?\s+(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+(?:,?\s*)?(\d{2,4})/gi;
  while ((m = textRegex1.exec(text)) !== null) {
    const normalized = normalizeTextualDate(m[1], m[2], m[3]);
    if (normalized) matches.push(normalized);
  }

  const textRegex2 = /(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s*)?(\d{2,4})/gi;
  while ((m = textRegex2.exec(text)) !== null) {
    const normalized = normalizeTextualDate(m[2], m[1], m[3]);
    if (normalized) matches.push(normalized);
  }

  return [...new Set(matches)];
}

function normalizeNumericDate(str) {
  const cleaned = str.replace(/[^0-9/.-]/g, '');
  const parts = cleaned.split(/[-/\.]/).map(p => parseInt(p, 10)).filter(n => !Number.isNaN(n));
  if (parts.length !== 3) return null;
  let [a, b, c] = parts;
  if (a > 1900) {
    if (c < 100) c += 2000;
    return `${a}-${pad(b)}-${pad(c)}`;
  }
  if (c > 1900) {
    if (c < 100) c += 2000;
    return `${c}-${pad(b)}-${pad(a)}`;
  }
  return null;
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

function extractCurrencyCandidates(lines) {
  const candidates = [];
  lines.forEach((line, index) => {
    if (!line) return;
    const cleanedLine = line.replace(/\s+/g, ' ');
    const hasCurrency = /₹|rs\.?|inr/i.test(cleanedLine);
    const hasKeyword = KEYWORDS_TOTAL.test(cleanedLine);
    if (!hasCurrency && !hasKeyword) return;

    const matches = cleanedLine.replace(/[,]/g, '').match(/(\d+(?:\.\d+)?)/g);
    if (!matches) return;
    matches.forEach(numStr => {
      const value = parseFloat(numStr);
      if (Number.isNaN(value) || value <= 0) return;
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

function pickBestTotal(candidates, text) {
  if (candidates.length > 0) {
    return candidates.find(c => c.hasCurrency && c.hasKeyword)
      || candidates.find(c => c.hasCurrency)
      || candidates[0];
  }
  const guessed = guessLargestAmount(text);
  if (!guessed) return null;
  return { value: guessed, line: '', index: -1, hasCurrency: false, hasKeyword: false };
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
    { type: 'flight', keywords: ['air india', 'indigo', 'vistara', 'pnr'] }
  ];
  return patterns.find(pattern =>
    pattern.keywords.some(keyword => lower.includes(keyword))
  ) || null;
}

function extractWithRules(rawText) {
  if (!rawText || rawText.length < 10) return null;
  const lines = tokenize(rawText);
  const vendorCandidates = extractVendorCandidates(lines);
  const dateCandidates = extractDateCandidates(rawText);
  const currencyCandidates = extractCurrencyCandidates(lines);
  const bestTotal = pickBestTotal(currencyCandidates, rawText);
  const simplePattern = detectSimpleReceipt(rawText, { total: bestTotal?.value || 0 });
  const totalValue = bestTotal?.value || 0;

  return {
    vendor_name: vendorCandidates[0] || null,
    vendor_candidates: vendorCandidates,
    bill_date: dateCandidates[0] || null,
    date_candidates: dateCandidates,
    amounts: {
      subtotal: null,
      tax_amount: null,
      total: totalValue
    },
    total_candidates: currencyCandidates.map(c => ({
      value: c.value,
      line: c.line,
      index: c.index,
      hasCurrency: c.hasCurrency,
      hasKeyword: c.hasKeyword
    })),
    bill_number: null,
    receipt_hint: simplePattern?.type || null
  };
}

module.exports = { extractWithRules };
