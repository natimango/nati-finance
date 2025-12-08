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

  const prompt = `You are an expert accountant extracting essentials from noisy OCR text.
Return STRICT JSON (no markdown) with this schema:
{
  "vendor_name": "Company",
  "bill_number": "Invoice/bill number or null",
  "bill_date": "YYYY-MM-DD or null",
  "amounts": {
    "subtotal": number or null,
    "tax_amount": number or null,
    "cgst": number or null,
    "sgst": number or null,
    "igst": number or null,
    "total": number
  },
  "line_items": [
    { "description": "Item", "quantity": number or null, "rate": number or null, "amount": number or null }
  ],
  "category": "food|travel|vendor|manufacturing|stitching|salary|rent|tech|marketing|logistics|packaging|misc|null",
  "confidence": 0.7
}

Rules:
- Focus on the main invoice total; ignore stray numbers (phone, zip, IDs).
- If multiple numbers, pick the one labeled as total/amount/INR; if unsure, use the largest plausible amount.
- Line items OPTIONAL: include only if clearly structured; otherwise return an empty array.
- Dates: prefer YYYY-MM-DD; if ambiguous, set null.
- Currency: assume INR.

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

    // Trim noisy line items
    const total = parsed?.amounts?.total ? parseFloat(parsed.amounts.total) : 0;
    if (parsed && Array.isArray(parsed.line_items)) {
      let items = parsed.line_items.filter(i => i && (i.description || i.amount));
      if (total > 0) {
        items = items.filter(i => {
          const amt = i.amount != null ? parseFloat(i.amount) : 0;
          return !isNaN(amt) ? amt <= total * 1.2 : true;
        });
      }
      parsed.line_items = items.slice(0, 5);
    }

    return { success: true, data: parsed, provider: 'openai' };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

module.exports = { extractBillFromText };
