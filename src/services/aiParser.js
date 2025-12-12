// OpenAI is the primary AI provider; heuristics are fallback.
const { extractBillFromText: extractOpenAI } = require('./openaiService');
const { extractWithRules } = require('./ruleExtractor');

// Budget/throttle gates via env
let aiCallCount = 0;
let aiCallWindowStart = Date.now();
const MAX_CALLS_PER_MIN = parseInt(process.env.MAX_AI_CALLS_PER_MIN || '8', 10);
const MAX_OCR_LENGTH = parseInt(process.env.MAX_AI_OCR_LENGTH || '12000', 10);
const AI_PROVIDER = (process.env.AI_PROVIDER || 'openai').toLowerCase();

function reconcileExtraction(result, heuristic) {
  if (!result || !result.success || !result.data || !heuristic) return result;
  const data = { ...result.data };

  if (heuristic.vendor_name && !data.vendor_name) {
    data.vendor_name = heuristic.vendor_name;
  }
  if (heuristic.bill_date && !data.bill_date) {
    data.bill_date = heuristic.bill_date;
  }

  const heurAmounts = heuristic.amounts || {};
  const heurTotal = Number(heurAmounts.total || 0);
  if (heurTotal > 0) {
    data.amounts = data.amounts || {};
    const aiTotal = Number(data.amounts.total || 0);
    const aiMissing = !aiTotal || aiTotal <= 0;
    const diff = aiMissing ? 0 : Math.abs(aiTotal - heurTotal) / Math.max(heurTotal, 1);
    if (aiMissing || diff > 0.25) {
      data.amounts.total = heurTotal;
      if (!data.amounts.subtotal && heurAmounts.subtotal) {
        data.amounts.subtotal = heurAmounts.subtotal;
      }
      if (!data.amounts.tax_amount && heurAmounts.tax_amount) {
        data.amounts.tax_amount = heurAmounts.tax_amount;
      }
    }
  }

  return { ...result, data };
}

function shouldSkipAI(ocrText) {
  if (!ocrText || ocrText.length < 10) return { block: true, reason: 'No OCR text' };
  if (ocrText.length > MAX_OCR_LENGTH) return { block: true, reason: 'OCR too long' };

  const now = Date.now();
  if (now - aiCallWindowStart > 60000) {
    aiCallWindowStart = now;
    aiCallCount = 0;
  }
  if (aiCallCount >= MAX_CALLS_PER_MIN) {
    return { block: false, throttled: true, reason: 'AI budget limit' };
  }

  return { block: false, throttled: false, reason: null };
}

function markCall() {
  aiCallCount += 1;
}

/**
 * Parse invoice text using configured provider.
 * Provider via AI_PROVIDER env: 'openai' (default) | 'heuristic'.
 * Returns { success, data?, provider?, error? }
 */
async function parseInvoiceText(ocrText, opts = {}) {
  const provider = AI_PROVIDER === 'heuristic' ? 'heuristic' : 'openai';
  const filePath = opts.filePath;
  const fileType = opts.fileType;

  // Helper to shape response; keep full data, mark provider/fallback
  const wrap = (res, prov, fallback) => {
    if (!res || !res.success) return res;
    return {
      ...res,
      provider: prov,
      fallback: !!fallback,
      data: res.data ? { ...res.data, _provider: prov, _fallback: !!fallback } : res.data
    };
  };

  // Heuristic first
  const heuristic = ocrText ? extractWithRules(ocrText) : null;
  const heuristicOk = heuristic && heuristic.vendor_name && heuristic.amounts && heuristic.amounts.total;

  const skipMeta = shouldSkipAI(ocrText);
  if (skipMeta.block) {
    if (heuristicOk) {
      return {
        success: true,
        data: { ...heuristic, _provider: 'rule', _fallback: true, _note: skipMeta.reason },
        provider: 'rule',
        fallback: true
      };
    }
    return { success: false, error: `AI skipped: ${skipMeta.reason}` };
  }

  if (provider === 'heuristic') {
    if (heuristicOk) {
      return {
        success: true,
        data: { ...heuristic, _provider: 'rule', _fallback: false },
        provider: 'rule',
        fallback: false
      };
    }
    return { success: false, error: 'Heuristic parser failed' };
  }

  const throttled = skipMeta.throttled;

  // Try selected provider, then fallbacks
  if (throttled && heuristicOk) {
    return {
      success: true,
      data: { ...heuristic, _provider: 'rule', _fallback: true, _note: 'AI throttled' },
      provider: 'rule',
      fallback: true
    };
  }

  if (provider === 'openai') {
    if (!throttled || !heuristicOk) {
      markCall();
      const oai = await extractOpenAI(ocrText || '');
      if (oai && oai.success) return reconcileExtraction(wrap(oai, 'openai', false), heuristic);
    }
  }

  // Heuristic fallback
  if (ocrText) {
    const rule = extractWithRules(ocrText);
    if (rule) {
      return {
        success: true,
        data: { ...rule, _provider: 'rule', _fallback: true },
        provider: 'rule',
        fallback: true
      };
    }
  }

  return { success: false, error: 'No parser succeeded' };
}

module.exports = { parseInvoiceText };
