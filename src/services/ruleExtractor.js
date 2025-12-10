// Very lightweight heuristic extractor as fallback when AI is unavailable
const { normalizeCategory } = require('../utils/categoryMap');

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

const SIMPLE_RECEIPT_RULES = [
  { type: 'fuel', keywords: ['petrol', 'diesel', 'bharat petroleum', 'indian oil', 'hpcl', 'fuel surcharge'], category: 'travel', description: 'Fuel purchase', department: 'ops' },
  { type: 'cab', keywords: ['uber', 'ola', 'rapido', 'meru', 'ola money', 'ride id'], category: 'travel', description: 'Cab / ride expense', department: 'ops' },
  { type: 'flight', keywords: ['air india', 'indigo', 'vistara', 'airasia', 'go air', 'flight', 'air ticket', 'boarding pass', 'pnr'], category: 'travel', description: 'Flight / air ticket', department: 'ops' },
  { type: 'food', keywords: ['restaurant', 'swiggy', 'zomato', 'ubereats', 'cafe', 'hotel bill', 'meal', 'food'], category: 'food_meals', description: 'Food & meals', department: 'product' },
  { type: 'tech', keywords: ['aws', 'digitalocean', 'vultr', 'vercel', 'github', 'notion', 'slack'], category: 'tech', description: 'Tech / SaaS', department: 'ops' }
];

function guessLargestAmount(text) {
  const matches = text.replace(/[,₹]/g, '').match(/(\d+(?:\.\d+)?)/g);
  if (!matches) return 0;
  return matches.reduce((max, curr) => {
    const val = parseFloat(curr);
    if (Number.isNaN(val)) return max;
    return val > max ? val : max;
  }, 0);
}

function detectSimpleReceipt(rawText, totals) {
  if (!rawText) return null;
  const lower = rawText.toLowerCase();
  const rule = SIMPLE_RECEIPT_RULES.find(pattern =>
    pattern.keywords.some(keyword => lower.includes(keyword))
  );
  if (!rule) return null;
  const normalized = normalizeCategory(rule.category);
  const totalAmount = totals.total || totals.subtotal || guessLargestAmount(rawText) || 0;
  return {
    ...normalized,
    department: rule.department || null,
    receipt_type: rule.type,
    is_simple_receipt: true,
    line_items: [{
      description: rule.description,
      quantity: 1,
      rate: totalAmount,
      amount: totalAmount,
      sku_code: ''
    }]
  };
}

function extractWithRules(rawText) {
  if (!rawText || rawText.length < 10) return null;
  const totals = extractTotals(rawText);
  const vendor = extractVendor(rawText);
  const date = extractDates(rawText);
  const simpleReceipt = detectSimpleReceipt(rawText, totals);
  if (simpleReceipt && simpleReceipt.line_items && simpleReceipt.line_items.length) {
    const lineAmount = simpleReceipt.line_items[0].amount || 0;
    if ((!totals.total || totals.total === 0) && lineAmount) {
      totals.total = lineAmount;
    }
    if ((!totals.subtotal || totals.subtotal === 0) && lineAmount) {
      totals.subtotal = lineAmount;
    }
  }
  const normalizedCategory = simpleReceipt
    ? { category: simpleReceipt.category, category_group: simpleReceipt.category_group }
    : null;
  const lineItems = simpleReceipt?.line_items || extractLineItems(rawText);
  return {
    vendor_name: vendor.vendor_name,
    bill_date: date,
    amounts: totals,
    line_items: lineItems,
    category: normalizedCategory ? normalizedCategory.category : null,
    category_group: normalizedCategory ? normalizedCategory.category_group : null,
    department: simpleReceipt?.department || null,
    receipt_type: simpleReceipt?.receipt_type || null,
    payment_terms: null,
    confidence: 0.3 // low confidence heuristic
  };
}

module.exports = { extractWithRules };
