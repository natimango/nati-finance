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
 * Returns { success, data?, heuristics?, aiSummary?, provider?, error? }
 */
async function parseInvoiceText(ocrText, opts = {}) {
  const provider = AI_PROVIDER === 'heuristic' ? 'heuristic' : 'openai';
  const heuristics = opts.heuristics || (ocrText ? extractWithRules(ocrText) : null);
  const heuristicData = heuristics ? buildHeuristicData(heuristics) : null;

  const wrap = (res, prov, fallback) => {
    if (!res || !res.success) return res;
    const shapedData = res.data
      ? { ...res.data, _provider: prov, _fallback: !!fallback }
      : res.data;
    return {
      success: true,
      provider: prov,
      fallback: !!fallback,
      data: shapedData,
      heuristics: res.heuristics || null,
      aiSummary: res.aiSummary || null
    };
  };

  const skipMeta = shouldSkipAI(ocrText);
  const heuristicUsable = heuristicData && heuristicData.amounts && heuristicData.amounts.total;

  if (skipMeta.block || provider === 'heuristic') {
    if (heuristicUsable) {
      return wrap({
        success: true,
        data: heuristicData,
        heuristics
      }, 'rule', provider !== 'heuristic');
    }
    return { success: false, error: skipMeta.block ? `AI skipped: ${skipMeta.reason}` : 'Heuristic parser failed' };
  }

  if (skipMeta.throttled && heuristicUsable) {
    return wrap({
      success: true,
      data: { ...heuristicData, _note: 'AI throttled' },
      heuristics
    }, 'rule', true);
  }

  if (provider === 'openai') {
    if (!skipMeta.throttled || !heuristicUsable) {
      markCall();
      const oai = await extractOpenAI(ocrText || '', {
        hints: heuristics || undefined,
        filePath: opts.filePath,
        fileType: opts.fileType
      });
      if (oai && oai.success) {
        const { normalizedData, aiSummary } = normalizeAiResponse(oai.data, heuristicData);
        return wrap({
          success: true,
          data: normalizedData,
          heuristics,
          aiSummary
        }, 'openai', false);
      }
    }
  }

  if (heuristicUsable) {
    return wrap({
      success: true,
      data: heuristicData,
      heuristics
    }, 'rule', true);
  }

  return { success: false, error: 'No parser succeeded' };
}

module.exports = { parseInvoiceText };

function buildHeuristicData(heuristic) {
  if (!heuristic) return null;
  const amounts = heuristic.amounts || {};
  return {
    vendor_name: heuristic.vendor_name || heuristic.vendor_candidates?.[0] || null,
    bill_date: heuristic.bill_date || heuristic.date_candidates?.[0] || null,
    amounts: {
      subtotal: amounts.subtotal != null ? amounts.subtotal : amounts.total || null,
      tax_amount: amounts.tax_amount != null ? amounts.tax_amount : null,
      total: amounts.total != null ? amounts.total : 0
    },
    bill_number: heuristic.bill_number || null,
    confidence: null
  };
}

function normalizeAiResponse(aiData, heuristicData) {
  if (!aiData) {
    return {
      normalizedData: heuristicData || null,
      aiSummary: null
    };
  }

  const billDateField = normalizeDateField(aiData.bill_date);
  const totalField = normalizeAmountField(aiData.total_amount);
  const subtotal = asNumber(aiData.subtotal);
  const taxAmount = asNumber(aiData.tax_amount);

  const normalized = {
    vendor_name: aiData.vendor_name || heuristicData?.vendor_name || null,
    bill_number: aiData.bill_number || heuristicData?.bill_number || null,
    bill_date: billDateField.value || heuristicData?.bill_date || null,
    amounts: {
      subtotal: subtotal != null
        ? subtotal
        : (heuristicData?.amounts?.subtotal || totalField.value || 0),
      tax_amount: taxAmount != null
        ? taxAmount
        : (heuristicData?.amounts?.tax_amount || 0),
      total: totalField.value != null
        ? totalField.value
        : (heuristicData?.amounts?.total || 0)
    },
    payment_terms: aiData.payment_terms || null,
    confidence: totalField.confidence != null
      ? totalField.confidence
      : (billDateField.confidence != null ? billDateField.confidence : null)
  };

  const aiSummary = {
    vendor_name: aiData.vendor_name || null,
    bill_number: aiData.bill_number || null,
    bill_date: billDateField,
    total_amount: totalField,
    subtotal,
    tax_amount: taxAmount,
    quality_score: normalizeQuality(aiData.quality_score),
    reason: aiData.reason || null
  };

  return { normalizedData: normalized, aiSummary };
}

function normalizeDateField(field) {
  if (!field || typeof field !== 'object') {
    return {
      value: typeof field === 'string' ? field : null,
      confidence: null,
      evidence: null
    };
  }
  const parsedValue = typeof field.value === 'string' ? field.value : null;
  return {
    value: parsedValue,
    confidence: field.confidence != null ? clampConfidence(field.confidence) : null,
    evidence: field.evidence || null
  };
}

function normalizeAmountField(field) {
  if (!field || typeof field !== 'object') {
    return {
      value: asNumber(field),
      confidence: null,
      evidence: null
    };
  }
  return {
    value: asNumber(field.value),
    confidence: field.confidence != null ? clampConfidence(field.confidence) : null,
    evidence: field.evidence || null
  };
}

function asNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const num = Number(value);
  if (Number.isNaN(num)) return null;
  return num;
}

function clampConfidence(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return null;
  const num = Number(value);
  if (!Number.isFinite(num)) return null;
  if (num < 0) return 0;
  if (num > 1) return 1;
  return Number(num.toFixed(3));
}

function normalizeQuality(value) {
  if (value === null || value === undefined) return null;
  const num = Number(value);
  if (Number.isNaN(num)) return null;
  if (num < 0) return 0;
  if (num > 100) return 100;
  return Math.round(num);
}
