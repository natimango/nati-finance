// OpenAI is the primary AI provider; heuristics are fallback.
const { extractBillFromText: extractOpenAI } = require('./openaiService');
const { extractWithRules } = require('./ruleExtractor');

// Budget/throttle gates via env
let aiCallCount = 0;
let aiCallWindowStart = Date.now();
const MAX_CALLS_PER_MIN = parseInt(process.env.MAX_AI_CALLS_PER_MIN || '8', 10);
const MAX_OCR_LENGTH = parseInt(process.env.MAX_AI_OCR_LENGTH || '12000', 10);
const AI_PROVIDER = (process.env.AI_PROVIDER || 'openai').toLowerCase();

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
      const oai = await extractOpenAI(ocrText || '', {
        hints: heuristic || undefined
      });
      if (oai && oai.success) {
        const merged = mergeAiAndHeuristic(oai.data, heuristic);
        return wrap({ success: true, data: merged }, 'openai', false);
      }
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

function mergeAiAndHeuristic(aiData, heuristic) {
  if (!aiData && !heuristic) return null;
  const result = aiData ? { ...aiData } : {};
  if (heuristic) {
    result._hints = {
      vendor_candidates: heuristic.vendor_candidates || [],
      total_candidates: heuristic.total_candidates || [],
      date_candidates: heuristic.date_candidates || [],
      receipt_hint: heuristic.receipt_hint || null
    };
    if ((!result.vendor_name || result.vendor_name === 'null') && heuristic.vendor_name) {
      result.vendor_name = heuristic.vendor_name;
    }
    if ((!result.bill_date || result.bill_date === 'null') && heuristic.bill_date) {
      result.bill_date = heuristic.bill_date;
    }
    const aiTotal = result?.amounts?.total;
    if ((aiTotal === undefined || aiTotal === null || aiTotal === 0) && heuristic.amounts?.total) {
      result.amounts = { ...(result.amounts || {}), total: heuristic.amounts.total };
    }
  }
  return result;
}
