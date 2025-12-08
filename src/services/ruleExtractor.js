// Very lightweight heuristic extractor as fallback when AI is unavailable

function extractTotals(text) {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  let total = 0, tax = 0, subtotal = 0;
  for (const line of lines) {
    const amount = parseAmount(line);
    if (/grand total|total amount|amount due/i.test(line)) total = amount || total;
    if (/tax|gst|vat/i.test(line)) tax = amount || tax;
    if (/subtotal|sub total/i.test(line)) subtotal = amount || subtotal;
  }
  if (!subtotal && total && tax) subtotal = total - tax;
  return { subtotal, tax_amount: tax, total };
}

function parseAmount(line) {
  const m = line.replace(/[,]/g, '').match(/(\d+(?:\.\d+)?)/);
  if (!m) return 0;
  return parseFloat(m[1]);
}

function extractVendor(text) {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  const first = lines[0] || '';
  return { vendor_name: first.substring(0, 120) || null };
}

function extractDates(text) {
  const re = /(\d{4}[-/]\d{1,2}[-/]\d{1,2})|(\d{1,2}[-/]\d{1,2}[-/]\d{2,4})/;
  const m = text.match(re);
  if (!m) return null;
  return normalizeDate(m[0]);
}

function normalizeDate(str) {
  const parts = str.replace(/[^0-9/.-]/g, '').split(/[-/\.]/).map(p => parseInt(p, 10));
  if (parts.length === 3) {
    let [a, b, c] = parts;
    if (c < 100) c += 2000;
    // decide if format is yyyy-mm-dd or dd-mm-yyyy
    if (a > 1900) return `${a}-${pad(b)}-${pad(c)}`; // a=year
    if (c > 1900) return `${c}-${pad(b)}-${pad(a)}`; // c=year at end
  }
  return null;
}

function pad(n) { return String(n).padStart(2, '0'); }

function extractLineItems(text) {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  // simple heuristic: lines with numbers and text
  const items = [];
  lines.forEach(l => {
    const amt = parseAmount(l);
    if (amt > 0 && /[a-zA-Z]/.test(l)) {
      items.push({ description: l.slice(0, 80), quantity: 1, rate: amt, amount: amt });
    }
  });
  return items.slice(0, 10);
}

function extractWithRules(rawText) {
  if (!rawText || rawText.length < 10) return null;
  const totals = extractTotals(rawText);
  const vendor = extractVendor(rawText);
  const date = extractDates(rawText);
  const lineItems = extractLineItems(rawText);
  return {
    vendor_name: vendor.vendor_name,
    bill_date: date,
    amounts: totals,
    line_items: lineItems,
    category: null,
    payment_terms: null,
    confidence: 0.3 // low confidence heuristic
  };
}

module.exports = { extractWithRules };
