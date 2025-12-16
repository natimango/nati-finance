const fs = require('fs');
const path = require('path');
const pdfParseModule = require('pdf-parse');
const pdfParse = pdfParseModule?.default || pdfParseModule;
const XLSX = require('xlsx');
const mammoth = require('mammoth');
const { createWorker } = require('tesseract.js');
const sharp = require('sharp');

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

async function renderPdfToImages(filePath, maxPages = 2) {
  const buffers = [];
  for (let page = 0; page < maxPages; page++) {
    try {
      const buffer = await sharp(filePath, { density: 280, page })
        .ensureAlpha()
        .normalize()
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
  return { raw_text: (data.text || '').trim(), meta: { type: 'ocr', confidence: data.confidence } };
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
  return { raw_text: fs.readFileSync(filePath, 'utf8'), meta: { type: 'unknown' } };
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
  return { raw_text: text.trim(), meta: { type: 'excel', sheets } };
}

async function parseDoc(filePath) {
  const result = await mammoth.extractRawText({ path: filePath });
  return { raw_text: result.value.trim(), meta: { type: 'docx' } };
}

async function parsePdf(filePath) {
  const buffer = fs.readFileSync(filePath);
  const data = await pdfParse(buffer);
  if (data && data.text && data.text.trim().length > 10) {
    const trimmed = data.text.trim();
    const quality = assessTextQuality(trimmed);
    if (quality.score >= 0.5) {
      return { raw_text: trimmed, meta: { type: 'pdf', pages: data.numpages, quality } };
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
  return { raw_text: combined.trim(), meta: { type: 'pdf_ocr', pages: pageBuffers.length, slices: metas, quality } };
}

async function ocrImage(filePath) {
  const worker = await getOcrWorker();
  const { data } = await worker.recognize(filePath);
  let text = (data.text || '').trim();
  let meta = { type: 'ocr', confidence: data.confidence };
  const quality = assessTextQuality(text);
  if (quality.score < 0.4) {
    // try enhanced contrast/greyscale pass
    const improvedPath = `${filePath}.ocr.png`;
    try {
      await sharp(filePath)
        .grayscale()
        .normalize()
        .sharpen()
        .toFile(improvedPath);
      const { data: improved } = await worker.recognize(improvedPath);
      const improvedText = (improved.text || '').trim();
      const improvedQuality = assessTextQuality(improvedText);
      if (improvedQuality.score > quality.score) {
        text = improvedText;
        meta = { type: 'ocr_enhanced', confidence: improved.confidence, quality: improvedQuality };
      }
      fs.unlink(improvedPath, () => {});
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
