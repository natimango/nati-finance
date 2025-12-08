// OpenAI is the primary AI provider; Groq and heuristic are fallbacks.
const groqService = require('./groqService');
const { extractBillFromText: extractOpenAI } = require('./openaiService');
const { extractWithRules } = require('./ruleExtractor');

// Budget/throttle gates via env
let aiCallCount = 0;
let aiCallWindowStart = Date.now();
const MAX_CALLS_PER_MIN = parseInt(process.env.MAX_AI_CALLS_PER_MIN || '8', 10);
const MAX_OCR_LENGTH = parseInt(process.env.MAX_AI_OCR_LENGTH || '12000', 10);
const AI_PROVIDER = (process.env.AI_PROVIDER || 'openai').toLowerCase();

function shouldSkipAI(ocrText) {
  // Empty or too long -> skip
  if (!ocrText || ocrText.length < 10) return 'No OCR text';
  if (ocrText.length > MAX_OCR_LENGTH) return 'OCR too long';

  // Rate limit per minute
  const now = Date.now();
  if (now - aiCallWindowStart > 60000) {
    aiCallWindowStart = now;
    aiCallCount = 0;
  }
  if (aiCallCount >= MAX_CALLS_PER_MIN) return 'AI budget limit';

  return null;
}

function markCall() {
  aiCallCount += 1;
}

/**
 * Parse invoice text using configured provider.
 * Provider via AI_PROVIDER env: 'openai' (default) | 'groq' | 'heuristic'.
 * Returns { success, data?, provider?, error? }
 */
async function parseInvoiceText(ocrText, opts = {}) {
  const provider = AI_PROVIDER === 'heuristic' || AI_PROVIDER === 'groq' ? AI_PROVIDER : 'openai';
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

  const skipReason = shouldSkipAI(ocrText);
  if (skipReason || provider === 'heuristic') {
    if (heuristicOk) {
      return {
        success: true,
        data: { ...heuristic, _provider: 'rule', _fallback: true, _note: skipReason || 'heuristic sufficient' },
        provider: 'rule',
        fallback: true
      };
    }
    if (skipReason) {
      return { success: false, error: `AI skipped: ${skipReason}` };
    }
  }

  // Try selected provider, then fallbacks
  if (provider === 'openai') {
    markCall();
    const oai = await extractOpenAI(ocrText || '');
    if (oai && oai.success) return wrap(oai, 'openai', false);
  }

  if (provider === 'groq' || provider === 'openai') {
    if (ocrText) {
      markCall();
      const gq = await groqService.extractBillFromText(ocrText);
      if (gq && gq.success) return wrap(gq, 'groq', provider !== 'groq');
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
