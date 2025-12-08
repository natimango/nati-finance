const fs = require('fs');
const path = require('path');
const pdfParse = require('pdf-parse');
const XLSX = require('xlsx');
const mammoth = require('mammoth');
const { createWorker } = require('tesseract.js');

// Basic OCR worker singleton to avoid re-init per call
let ocrWorker = null;
async function getOcrWorker() {
  if (ocrWorker) return ocrWorker;
  // tesseract.js v5: createWorker can take lang directly
  ocrWorker = await createWorker('eng');
  return ocrWorker;
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
    return { raw_text: data.text.trim(), meta: { type: 'pdf', pages: data.numpages } };
  }
  // fallback: OCR
  return await ocrImage(filePath);
}

async function ocrImage(filePath) {
  const worker = await getOcrWorker();
  const { data } = await worker.recognize(filePath);
  return { raw_text: (data.text || '').trim(), meta: { type: 'ocr', confidence: data.confidence } };
}

module.exports = {
  preprocessFile
};
