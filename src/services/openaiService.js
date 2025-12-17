const fetch = require('node-fetch');

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';

function formatHintList(label, list, mapper = v => v) {
  if (!list || list.length === 0) return '';
  const items = list.slice(0, 5).map(mapper).filter(Boolean);
  if (items.length === 0) return '';
  return `- ${label}: ${items.join('; ')}\n`;
}

async function extractBillFromText(rawText, options = {}) {
  if (!OPENAI_API_KEY) {
    return { success: false, error: 'Missing OPENAI_API_KEY' };
  }
  if (!rawText || rawText.length < 10) {
    return { success: false, error: 'No raw text to extract' };
  }

  const hints = options.hints || {};
  const hintSections = [];
  const vendorHintBlock = formatHintList('Vendor candidates', hints.vendor_candidates);
  if (vendorHintBlock) hintSections.push(vendorHintBlock);
  const totalHintBlock = formatHintList('Likely totals', hints.total_candidates, c => {
    if (!c) return null;
    const value = typeof c === 'number' ? c : c.value;
    if (typeof value === 'undefined' || value === null) return null;
    const evidence = c.line || c.evidence;
    const source = evidence ? ` (from "${evidence.slice(0, 80)}")` : '';
    return `${value}${source}`;
  });
  if (totalHintBlock) hintSections.push(totalHintBlock);
  const dateCandidates = hints.bill_date_candidates || hints.date_candidates;
  const dateHintBlock = formatHintList('Possible billing dates', dateCandidates, c => {
    if (!c) return null;
    if (typeof c === 'string') return c;
    return c.value || null;
  });
  if (dateHintBlock) hintSections.push(dateHintBlock);
  if (hints.receipt_hint) {
    hintSections.push(`- Receipt type hint: ${hints.receipt_hint}`);
  }

  const hintText = hintSections.length
    ? `\nAdditional context (use only if it matches the text):\n${hintSections.join('')}`
    : '';

  const prompt = `You are an expert accountant extracting verification-ready metadata from noisy OCR text.
Return STRICT JSON (no markdown) with this schema:
{
  "vendor_name": "Company or null",
  "bill_number": "Invoice/bill number or null",
  "bill_date": {
    "value": "YYYY-MM-DD or null",
    "confidence": 0-1,
    "evidence": "Exact quote from the text or null"
  },
  "total_amount": {
    "value": number or null,
    "confidence": 0-1,
    "evidence": "Exact quote from the text or null"
  },
  "subtotal": number or null,
  "tax_amount": number or null,
  "quality_score": 0-100,
  "reason": "Why a field is missing/uncertain or null"
}

Rules:
- Your #1 goal is the total payable in INR; treat "Rs", "INR", "₹" as currency markers. Ignore phone numbers, IDs, quantities.
- Vendor name should be the legal entity on the invoice header; avoid line items or contact names.
- Bill date must be the invoice/billing date; if ambiguous, return null.
- subtotal / tax_amount are optional hints; if not explicit, return null.
- Evidence must be a verbatim snippet from the OCR text (≤140 chars). If no precise quote exists, set evidence to null.
- Confidence is your certainty that the evidence proves the field; use 0 if value is null.
- Do NOT include markdown fences or prose outside the JSON object.

${hintText}

Raw text:
${rawText.slice(0, 12000)}`;

  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.2,
        max_tokens: 1200
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`OpenAI error ${response.status}: ${errText}`);
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content || '';
    const cleaned = content.replace(/```json/gi, '').replace(/```/g, '').trim();
    const parsed = JSON.parse(cleaned);

    return { success: true, data: parsed, provider: 'openai' };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

module.exports = { extractBillFromText };
