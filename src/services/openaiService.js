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
    if (!c || typeof c.value === 'undefined') return null;
    const source = c.line ? ` (from "${c.line.slice(0, 80)}")` : '';
    return `${c.value}${source}`;
  });
  if (totalHintBlock) hintSections.push(totalHintBlock);
  const dateHintBlock = formatHintList('Possible billing dates', hints.date_candidates);
  if (dateHintBlock) hintSections.push(dateHintBlock);
  if (hints.receipt_hint) {
    hintSections.push(`- Receipt type hint: ${hints.receipt_hint}`);
  }

  const hintText = hintSections.length
    ? `\nAdditional context (use only if it matches the text):\n${hintSections.join('')}`
    : '';

  const prompt = `You are an expert accountant extracting ONLY the three essentials from noisy OCR text.
Return STRICT JSON (no markdown) with this schema:
{
  "vendor_name": "Company or null",
  "bill_date": "YYYY-MM-DD or null",
  "amounts": {
    "total": number,
    "subtotal": number or null,
    "tax_amount": number or null
  },
  "bill_number": "Invoice/bill number or null"
}

Rules:
- Your #1 goal is the total payable in INR; treat "Rs", "INR", "₹" as currency markers. Ignore phone numbers, IDs, quantities.
- Vendor name should be the legal entity on the invoice header; avoid line items or contact names.
- Bill date must be the invoice/billing date; if ambiguous, return null.
- subtotal / tax_amount are optional hints; if not explicit, return null. No line items, categories, payment terms, etc.

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
