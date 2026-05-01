/**
 * file-parser.mjs — Unified file content extraction
 * 
 * Single Source of Truth for all file parsing in RangerAI.
 * All code paths (file-handler, user-message-handler, knowledge-api)
 * MUST use this module instead of implementing their own parsing logic.
 * 
 * Supported formats:
 *   - Text:  .txt, .md, .json, .csv, .xml, .yaml, .py, .js, .ts, etc.
 *   - PDF:   .pdf (via pdf-parse)
 *   - Excel: .xlsx, .xlsm, .xlsb, .xls (via xlsx)
 *   - Word:  .docx (via mammoth)
 *   - Image: .png, .jpg, .gif, .webp, .bmp, .ico (returns metadata only)
 *   - Binary: everything else (returns metadata only)
 * 
 * Usage:
 *   import { parseFile, parseBuffer } from '../lib/file-parser.mjs';
 *   
 *   // From local file path:
 *   const result = await parseFile('/opt/rangerai-agent/files/upload-xxx.xlsx');
 *   
 *   // From in-memory buffer (e.g. multipart upload):
 *   const result = await parseBuffer(buffer, 'report.pdf', 'application/pdf');
 *   
 *   // result = { text, type, truncated, metadata }
 */

import fs from 'fs';
import path from 'path';

// ─── Configuration ───────────────────────────────────────────────

const MAX_TEXT_CHARS = 50000;   // Truncate extracted text beyond this
const MAX_FILE_BYTES = 10 * 1024 * 1024; // 10MB hard limit

// ─── File Type Classification ────────────────────────────────────

const TEXT_EXTENSIONS = new Set([
  'txt', 'md', 'markdown', 'py', 'js', 'ts', 'jsx', 'tsx', 'html', 'css',
  'json', 'csv', 'xml', 'yaml', 'yml', 'sh', 'bash', 'sql', 'log', 'conf',
  'ini', 'toml', 'rs', 'go', 'java', 'c', 'cpp', 'h', 'hpp', 'php', 'rb',
  'swift', 'kt', 'r', 'm', 'pl', 'lua', 'vim', 'dockerfile', 'gitignore',
  'env', 'config', 'properties', 'makefile', 'cmake', 'gradle', 'sbt',
  'scala', 'clj', 'erl', 'ex', 'exs', 'hs', 'ml', 'fs', 'fsx', 'v',
  'vhdl', 'asm', 's', 'bat', 'cmd', 'ps1', 'psm1', 'psd1',
]);

const EXCEL_EXTENSIONS = new Set(['xlsx', 'xlsm', 'xlsb', 'xls']);
const WORD_EXTENSIONS = new Set(['docx']);
const PDF_EXTENSIONS = new Set(['pdf']);
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'ico', 'svg', 'tiff', 'tif']);
const AUDIO_EXTENSIONS = new Set(['mp3', 'wav', 'ogg', 'flac', 'aac', 'm4a', 'wma']);
const VIDEO_EXTENSIONS = new Set(['mp4', 'avi', 'mkv', 'mov', 'wmv', 'flv', 'webm']);
const ARCHIVE_EXTENSIONS = new Set(['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz', 'zst']);

/**
 * Classify a file by its extension and optional MIME type.
 * Returns: 'text' | 'pdf' | 'excel' | 'word' | 'image' | 'audio' | 'video' | 'archive' | 'binary'
 */
export function classifyFile(fileName, mimeType) {
  const ext = (fileName || '').split('.').pop()?.toLowerCase() || '';
  
  // MIME-based overrides (more reliable than extension for some cases)
  if (mimeType) {
    if (mimeType === 'application/pdf') return 'pdf';
    if (mimeType.includes('spreadsheet') || mimeType.includes('excel')) return 'excel';
    if (mimeType.includes('wordprocessingml') || mimeType === 'application/msword') return 'word';
    if (mimeType.startsWith('image/')) return 'image';
    if (mimeType.startsWith('audio/')) return 'audio';
    if (mimeType.startsWith('video/')) return 'video';
    if (mimeType.startsWith('text/')) return 'text';
  }
  
  // Extension-based classification
  if (PDF_EXTENSIONS.has(ext)) return 'pdf';
  if (EXCEL_EXTENSIONS.has(ext)) return 'excel';
  if (WORD_EXTENSIONS.has(ext)) return 'word';
  if (TEXT_EXTENSIONS.has(ext)) return 'text';
  if (IMAGE_EXTENSIONS.has(ext)) return 'image';
  if (AUDIO_EXTENSIONS.has(ext)) return 'audio';
  if (VIDEO_EXTENSIONS.has(ext)) return 'video';
  if (ARCHIVE_EXTENSIONS.has(ext)) return 'archive';
  
  // Magic number sniffing as last resort
  return 'binary';
}

/**
 * Detect file type from buffer magic bytes (fallback when extension is unreliable).
 */
function sniffMagic(buffer) {
  if (!buffer || buffer.length < 5) return null;
  const header = buffer.slice(0, 5);
  const hex = Buffer.from(header).toString('hex');
  const str = Buffer.from(header).toString('utf-8');
  
  if (str === '%PDF-') return 'pdf';
  if (hex.startsWith('504b0304')) return 'zip'; // Could be xlsx, docx, pptx
  if (hex.startsWith('d0cf11e0')) return 'ole'; // Old Office format (.doc, .xls, .ppt)
  if (hex.startsWith('ffd8ff')) return 'image';  // JPEG
  if (hex.startsWith('89504e47')) return 'image'; // PNG
  if (hex.startsWith('47494638')) return 'image'; // GIF
  return null;
}

// ─── Parser Implementations ──────────────────────────────────────

async function parsePdf(buffer) {
  const { PDFParse } = await import('pdf-parse');
  const parser = new PDFParse(new Uint8Array(buffer));
  const result = await parser.getText();
  return {
    text: result.text || '',
    metadata: { pages: result.numpages || 0 }
  };
}

async function parseExcel(buffer, maxChars = MAX_TEXT_CHARS) {
  const _xlsx = await import('xlsx');
  const XLSX = _xlsx.default || _xlsx;
  const wb = XLSX.read(buffer, { type: 'buffer' });
  
  // Parse all sheets into individual text blocks
  const allSheets = [];
  for (const name of wb.SheetNames) {
    const csv = XLSX.utils.sheet_to_csv(wb.Sheets[name]);
    if (csv.trim()) {
      allSheets.push({ name, text: `[Sheet: ${name}]\n${csv}` });
    }
  }
  
  if (allSheets.length === 0) {
    return { text: '[Empty spreadsheet]', metadata: { sheetCount: wb.SheetNames.length, sheetNames: wb.SheetNames } };
  }
  
  // Smart assembly: reverse order so NEWEST sheets come first.
  // When truncation happens, old data gets cut — not the latest.
  const reversed = [...allSheets].reverse();
  
  // Build text with newest-first, tracking which sheets fit within budget
  const includedSheets = [];
  let totalChars = 0;
  const separator = '\n\n';
  
  for (const sheet of reversed) {
    const addedChars = (includedSheets.length > 0 ? separator.length : 0) + sheet.text.length;
    if (totalChars + addedChars > maxChars && includedSheets.length > 0) {
      break; // Stop adding sheets — we've hit the budget
    }
    includedSheets.push(sheet);
    totalChars += addedChars;
  }
  
  const omittedCount = allSheets.length - includedSheets.length;
  let header = '';
  if (omittedCount > 0) {
    header = `[Excel 文件共 ${allSheets.length} 个 Sheet，已展示最新 ${includedSheets.length} 个，省略较早的 ${omittedCount} 个]\n\n`;
  }
  
  const text = header + includedSheets.map(s => s.text).join(separator);
  
  return {
    text,
    metadata: {
      sheetCount: wb.SheetNames.length,
      sheetNames: wb.SheetNames,
      includedSheets: includedSheets.map(s => s.name),
      omittedSheets: omittedCount
    }
  };
}

async function parseWord(buffer) {
  const mammoth = await import('mammoth');
  const result = await mammoth.extractRawText({ buffer });
  return {
    text: result.value || '',
    metadata: {}
  };
}

function parseText(buffer) {
  // Strip null bytes as safety net (some files have stray \0)
  return {
    text: buffer.toString('utf-8').replace(/\0/g, ''),
    metadata: {}
  };
}

// ─── Public API ──────────────────────────────────────────────────

/**
 * Parse a file from a Buffer.
 * 
 * @param {Buffer} buffer - File content as Buffer
 * @param {string} fileName - Original file name (used for type detection)
 * @param {string} [mimeType] - Optional MIME type for better detection
 * @param {object} [options] - Options
 * @param {number} [options.maxChars=50000] - Max characters to return
 * @param {boolean} [options.noTruncate=false] - Disable truncation
 * @returns {Promise<{text: string, type: string, truncated: boolean, metadata: object}>}
 */

/**
 * OCR: Extract text from image using Tesseract.js
 * Supports: jpg, png, bmp, tiff, webp
 * Languages: eng + chi_sim (English + Simplified Chinese)
 */
async function parseImage(buffer, fileName) {
  try {
    const { createWorker } = await import('tesseract.js');
    const worker = await createWorker(['eng', 'chi_sim'], 1, {
      // Use default CDN for trained data
    });
    
    const { data: { text, confidence } } = await worker.recognize(buffer);
    await worker.terminate();
    
    const cleanText = text.trim();
    if (!cleanText || cleanText.length < 5) {
      return {
        text: `[图片文件: ${fileName} - OCR未识别到有效文字内容 (置信度: ${Math.round(confidence)}%)]`,
        type: 'image',
        truncated: false,
        metadata: { size: buffer.length, ocrConfidence: confidence, ocrEmpty: true }
      };
    }
    
    return {
      text: `[OCR识别结果 - ${fileName} (置信度: ${Math.round(confidence)}%)]\n\n${cleanText}`,
      type: 'image-ocr',
      truncated: false,
      metadata: { size: buffer.length, ocrConfidence: confidence, ocrChars: cleanText.length }
    };
  } catch (err) {
    return {
      text: `[图片OCR失败: ${fileName} - ${err.message}]`,
      type: 'image',
      truncated: false,
      metadata: { size: buffer.length, ocrError: err.message }
    };
  }
}

export async function parseBuffer(buffer, fileName, mimeType, options = {}) {
  const maxChars = options.maxChars ?? MAX_TEXT_CHARS;
  const noTruncate = options.noTruncate ?? false;
  
  let type = classifyFile(fileName, mimeType);
  
  // Use magic number sniffing to correct misclassified files
  const magic = sniffMagic(buffer);
  if (type === 'binary' && magic === 'pdf') type = 'pdf';
  if (type === 'binary' && magic === 'zip') {
    // ZIP could be xlsx or docx — check extension
    const ext = (fileName || '').split('.').pop()?.toLowerCase() || '';
    if (EXCEL_EXTENSIONS.has(ext)) type = 'excel';
    else if (WORD_EXTENSIONS.has(ext)) type = 'word';
  }
  if (type === 'binary' && magic === 'ole') {
    const ext = (fileName || '').split('.').pop()?.toLowerCase() || '';
    if (ext === 'xls') type = 'excel';
  }
  
  let result;
  
  switch (type) {
    case 'pdf':
      try {
        result = await parsePdf(buffer);
      } catch (err) {
        return { text: `[PDF 解析失败: ${err.message}]`, type: 'pdf', truncated: false, metadata: { error: err.message } };
      }
      break;
      
    case 'excel':
      try {
        result = await parseExcel(buffer, maxChars);
      } catch (err) {
        return { text: `[Excel 解析失败: ${err.message}]`, type: 'excel', truncated: false, metadata: { error: err.message } };
      }
      break;
      
    case 'word':
      try {
        result = await parseWord(buffer);
      } catch (err) {
        return { text: `[Word 解析失败: ${err.message}]`, type: 'word', truncated: false, metadata: { error: err.message } };
      }
      break;
      
    case 'text':
      result = parseText(buffer);
      break;
      
    case 'image':
      try {
        result = await parseImage(buffer, fileName);
        return result; // parseImage handles its own return format
      } catch (err) {
        return {
          text: `[图片文件: ${fileName} (${Math.round(buffer.length / 1024)}KB) - OCR不可用]`,
          type: 'image',
          truncated: false,
          metadata: { size: buffer.length }
        };
      }
      
    case 'audio':
    case 'video':
    case 'archive':
      return {
        text: `[${type === 'audio' ? '音频' : type === 'video' ? '视频' : '压缩包'}文件: ${fileName} (${Math.round(buffer.length / 1024)}KB)，无法提取文本内容]`,
        type,
        truncated: false,
        metadata: { size: buffer.length }
      };
      
    default:
      // Try text as last resort
      try {
        result = parseText(buffer);
        // If it looks like binary (too many non-printable chars), reject
        const nonPrintable = (result.text.match(/[^\x20-\x7E\t\n\r\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/g) || []).length;
        if (nonPrintable / Math.max(result.text.length, 1) > 0.1) {
          return {
            text: `[二进制文件: ${fileName} (${Math.round(buffer.length / 1024)}KB)，无法提取文本内容]`,
            type: 'binary',
            truncated: false,
            metadata: { size: buffer.length }
          };
        }
        type = 'text';
      } catch {
        return {
          text: `[无法读取文件: ${fileName}]`,
          type: 'binary',
          truncated: false,
          metadata: { size: buffer.length }
        };
      }
  }
  
  // Apply truncation
  let truncated = false;
  let text = result.text;
  if (!noTruncate && text.length > maxChars) {
    text = text.slice(0, maxChars) + `\n... (内容过长，已截断前${maxChars}字符)`;
    truncated = true;
  }
  
  return { text, type, truncated, metadata: result.metadata || {} };
}

/**
 * Parse a file from a local file path.
 * 
 * @param {string} filePath - Absolute path to the file
 * @param {string} [mimeType] - Optional MIME type
 * @param {object} [options] - Options (same as parseBuffer)
 * @returns {Promise<{text: string, type: string, truncated: boolean, metadata: object}>}
 */
export async function parseFile(filePath, mimeType, options = {}) {
  if (!fs.existsSync(filePath)) {
    return { text: `[文件不存在: ${filePath}]`, type: 'missing', truncated: false, metadata: {} };
  }
  
  const stat = fs.statSync(filePath);
  if (stat.size > MAX_FILE_BYTES) {
    return {
      text: `[文件过大: ${path.basename(filePath)} (${Math.round(stat.size / 1024 / 1024)}MB)，超过${MAX_FILE_BYTES / 1024 / 1024}MB限制]`,
      type: 'oversized',
      truncated: false,
      metadata: { size: stat.size }
    };
  }
  
  const buffer = fs.readFileSync(filePath);
  const fileName = path.basename(filePath);
  return parseBuffer(buffer, fileName, mimeType, options);
}

/**
 * Parse a file from a remote URL.
 * 
 * @param {string} url - HTTP(S) URL to fetch
 * @param {string} fileName - Display name for the file
 * @param {string} [mimeType] - Optional MIME type
 * @param {object} [options] - Options (same as parseBuffer)
 * @returns {Promise<{text: string, type: string, truncated: boolean, metadata: object}>}
 */
export async function parseUrl(url, fileName, mimeType, options = {}) {
  try {
    const resp = await fetch(url);
    if (!resp.ok) {
      return { text: `[文件下载失败: HTTP ${resp.status}]`, type: 'error', truncated: false, metadata: { status: resp.status } };
    }
    const buffer = Buffer.from(await resp.arrayBuffer());
    if (buffer.length > MAX_FILE_BYTES) {
      return {
        text: `[文件过大: ${fileName} (${Math.round(buffer.length / 1024 / 1024)}MB)]`,
        type: 'oversized',
        truncated: false,
        metadata: { size: buffer.length }
      };
    }
    // Use content-type from response if not provided
    const contentType = mimeType || resp.headers.get('content-type')?.split(';')[0];
    return parseBuffer(buffer, fileName, contentType, options);
  } catch (err) {
    return { text: `[文件获取失败: ${err.message}]`, type: 'error', truncated: false, metadata: { error: err.message } };
  }
}
