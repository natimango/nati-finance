const fetch = require('node-fetch');

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';

async function extractBillFromText(rawText) {
  if (!OPENAI_API_KEY) {
    return { success: false, error: 'Missing OPENAI_API_KEY' };
  }
  if (!rawText || rawText.length < 10) {
    return { success: false, error: 'No raw text to extract' };
  }

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
