const fs = require('fs');
const path = require('path');
const pdfParseModule = require('pdf-parse');
const PDFParseClass =
  pdfParseModule?.PDFParse ||
  pdfParseModule?.default?.PDFParse ||
  null;
const legacyPdfParseFn =
  typeof pdfParseModule === 'function'
    ? pdfParseModule
    : typeof pdfParseModule?.default === 'function'
      ? pdfParseModule.default
      : null;
const XLSX = require('xlsx');
const mammoth = require('mammoth');
const { createWorker } = require('tesseract.js');
const sharp = require('sharp');

const CURRENT_OCR_VERSION = parseInt(process.env.OCR_VERSION || '1', 10);
const MIN_USABLE_TEXT = parseInt(process.env.OCR_TEXT_MIN_LEN || '200', 10);
const MAX_OCR_IMAGE_DIM = parseInt(process.env.OCR_IMAGE_MAX_DIM || '2200', 10);

// Basic OCR worker singleton to avoid re-init per call
let ocrWorker = null;
async function getOcrWorker() {
  if (ocrWorker) return ocrWorker;
  // tesseract.js v5: createWorker can take lang directly
  ocrWorker = await createWorker('eng');
  return ocrWorker;
}

function assessTextQuality(text) {
  if (!text) return { score: 0, reason: 'empty' };
  const lengthScore = Math.min((text.length || 0) / 500, 1); // 0..1
  const alpha = (text.match(/[A-Za-z]/g) || []).length;
  const digit = (text.match(/[0-9]/g) || []).length;
  const alphaRatio = (alpha / Math.max(text.length, 1));
  const digitRatio = (digit / Math.max(text.length, 1));
  let score = (lengthScore * 0.5) + (alphaRatio * 0.3) + (digitRatio * 0.2);
  score = Math.min(Math.max(score, 0), 1);
  let reason = null;
  if (score < 0.3) reason = 'text too short or noisy';
  else if (score < 0.5) reason = 'text quality mediocre';
  return { score, reason };
}

function isUsablePdfText(text) {
  if (!text) return false;
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (trimmed.length < Math.max(80, MIN_USABLE_TEXT * 0.5)) return false;
  const asciiOnly = trimmed.replace(/[^\x20-\x7E\n]/g, '');
  const asciiRatio = asciiOnly.length / trimmed.length;
  const uniqueChars = new Set(trimmed).size / Math.max(trimmed.length, 1);
  const { score } = assessTextQuality(trimmed);
  if (score < 0.35) return false;
  if (asciiRatio < 0.6) return false;
  if (uniqueChars < 0.05) return false;
  return true;
}

function withVersion(meta = {}) {
  return { ...meta, version: CURRENT_OCR_VERSION };
}

async function renderPdfToImages(filePath, maxPages = 2) {
  const buffers = [];
  for (let page = 0; page < maxPages; page++) {
    try {
      const buffer = await sharp(filePath, { density: 280, page })
        .ensureAlpha()
        .grayscale()
        .normalize()
        .sharpen()
        .toFormat('png')
        .toBuffer();
      buffers.push(buffer);
    } catch (err) {
      if (page === 0) throw err;
      break;
    }
  }
  return buffers;
}

async function ocrBuffer(buffer) {
  const worker = await getOcrWorker();
  const { data } = await worker.recognize(buffer);
  return { raw_text: (data.text || '').trim(), meta: withVersion({ type: 'ocr', confidence: data.confidence }) };
}

async function preprocessFile(filePath, fileType) {
  const ext = (filePath || '').toLowerCase();
  if (!fs.existsSync(filePath)) {
    throw new Error('File not found for preprocessing');
  }

  // Excel
  if (ext.endsWith('.xlsx') || ext.endsWith('.xls')) {
    return await parseExcel(filePath);
  }

  // Word
  if (ext.endsWith('.docx') || ext.endsWith('.doc')) {
    return await parseDoc(filePath);
  }

  // PDF
  if (fileType?.includes('pdf') || ext.endsWith('.pdf')) {
    return await parsePdf(filePath);
  }

  // Images
  if (fileType?.includes('image') || /\.(png|jpe?g)$/i.test(ext)) {
    return await ocrImage(filePath);
  }

  // Fallback: plain text read
  return { raw_text: fs.readFileSync(filePath, 'utf8'), meta: withVersion({ type: 'unknown' }) };
}

async function parseExcel(filePath) {
  const wb = XLSX.readFile(filePath, { cellDates: true });
  let text = '';
  const sheets = [];
  wb.SheetNames.forEach(name => {
    const sheet = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: false });
    sheets.push({ name, rows: sheet });
    text += `\n--- SHEET: ${name} ---\n`;
    sheet.forEach(r => { text += r.join(' | ') + '\n'; });
  });
  return { raw_text: text.trim(), meta: withVersion({ type: 'excel', sheets }) };
}

async function parseDoc(filePath) {
  const result = await mammoth.extractRawText({ path: filePath });
  return { raw_text: result.value.trim(), meta: withVersion({ type: 'docx' }) };
}

async function parsePdf(filePath) {
  const buffer = fs.readFileSync(filePath);
  // Try new v2 parser API if available
  if (PDFParseClass) {
    try {
      const parser = new PDFParseClass({ data: buffer });
      let result;
      try {
        result = await parser.getText();
      } finally {
        await parser.destroy().catch(() => {});
      }
      if (result?.text) {
        const trimmed = result.text.trim();
        if (isUsablePdfText(trimmed)) {
          const quality = assessTextQuality(trimmed);
          return {
            raw_text: trimmed,
            meta: withVersion({ type: 'pdf_parse_v2', pages: result?.total, quality })
          };
        }
        console.warn('[preprocess] pdf-parse v2 text unusable, falling back to OCR');
      }
    } catch (err) {
      console.warn('[preprocess] pdf-parse v2 getText failed, falling back to legacy parser', err);
    }
  }

  // Legacy pdf-parse v1 style function
  if (legacyPdfParseFn) {
    try {
      const data = await legacyPdfParseFn(buffer);
      if (data?.text) {
        const trimmed = data.text.trim();
        if (isUsablePdfText(trimmed)) {
          const quality = assessTextQuality(trimmed);
          return {
            raw_text: trimmed,
            meta: withVersion({ type: 'pdf_parse_v1', pages: data?.numpages, quality })
          };
        }
        console.warn('[preprocess] pdf-parse legacy text unusable, falling back to OCR');
      }
    } catch (err) {
      console.warn('[preprocess] pdf-parse legacy function failed, falling back to OCR', err);
    }
  }

  // fallback: render pages and OCR
  const pageBuffers = await renderPdfToImages(filePath, 3);
  let combined = '';
  const metas = [];
  for (const buf of pageBuffers) {
    const ocr = await ocrBuffer(buf);
    combined += `\n${ocr.raw_text}`;
    metas.push(ocr.meta);
  }
  const quality = assessTextQuality(combined.trim());
  return { raw_text: combined.trim(), meta: withVersion({ type: 'pdf_ocr', pages: pageBuffers.length, slices: metas, quality }) };
}

async function ocrImage(filePath) {
  const worker = await getOcrWorker();
  const baseBuffer = await sharp(filePath)
    .rotate()
    .resize({
      width: MAX_OCR_IMAGE_DIM,
      height: MAX_OCR_IMAGE_DIM,
      fit: 'inside',
      withoutEnlargement: true
    })
    .grayscale()
    .normalize()
    .sharpen()
    .toBuffer();
  const { data } = await worker.recognize(baseBuffer);
  let text = (data.text || '').trim();
  let meta = withVersion({ type: 'ocr', confidence: data.confidence });
  const quality = assessTextQuality(text);
  if (quality.score < 0.4) {
    // try enhanced contrast/greyscale pass
    try {
      const improvedBuffer = await sharp(baseBuffer)
        .threshold(140)
        .toBuffer();
      const { data: improved } = await worker.recognize(improvedBuffer);
      const improvedText = (improved.text || '').trim();
      const improvedQuality = assessTextQuality(improvedText);
      if (improvedQuality.score > quality.score) {
        text = improvedText;
        meta = withVersion({ type: 'ocr_threshold', confidence: improved.confidence, quality: improvedQuality });
      }
    } catch (_) {
      // ignore enhancement failures
    }
  }
  meta.quality = meta.quality || assessTextQuality(text);
  return { raw_text: text, meta };
}

module.exports = {
  preprocessFile
};
