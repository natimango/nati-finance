const GROQ_API_KEY = process.env.GROQ_API_KEY;

async function extractBillFromText(rawText) {
  if (!GROQ_API_KEY) {
    return { success: false, error: 'Missing GROQ_API_KEY' };
  }
  if (!rawText || rawText.length < 10) {
    return { success: false, error: 'No raw text to extract' };
  }

  const prompt = `You are an expert accountant extracting ONLY the essentials from noisy OCR text.
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
  "confidence": 0.6
}

Rules:
- Focus on the main invoice total; ignore stray numbers (phone, zip, ID, times).
- If multiple numbers, pick the one labelled as total/amount/INR; if unsure, use the largest plausible amount.
- Line items are OPTIONAL: include only if clearly structured; otherwise return an empty array.
- Do NOT fabricate installment/payment terms here.
- Dates: prefer YYYY-MM-DD; if ambiguous, set null.
- Currency: assume INR.

Raw text:\n${rawText.slice(0, 12000)}`;

  try {
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${GROQ_API_KEY}`
      },
      body: JSON.stringify({
        model: 'openai/gpt-oss-20b',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.2,
        max_tokens: 1200
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Groq API error ${response.status}: ${errText}`);
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content || '';
    const cleaned = content.replace(/```json/gi, '').replace(/```/g, '').trim();
    const parsed = JSON.parse(cleaned);

    // Post-filter line items to avoid noise and limit length
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

    return { success: true, data: parsed, provider: 'groq' };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

module.exports = { extractBillFromText };
