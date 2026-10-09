/**
 * OCR PDF Processor
 * Requirements: 5.1
 * 
 * Performs Optical Character Recognition on PDF pages.
 * Uses Tesseract.js for client-side OCR processing.
 */

import type {
  ProcessInput,
  ProcessOutput,
  ProgressCallback,
} from '@/types/pdf';
import { PDFErrorCode } from '@/types/pdf';
import { BasePDFProcessor } from '../processor';
import { loadPdfjs, loadPdfLib } from '../loader';

/**
 * Supported OCR languages
 */
export type OCRLanguage = 'eng' | 'chi_sim' | 'chi_tra' | 'jpn' | 'kor' | 'spa' | 'fra' | 'deu' | 'por' | 'ara' | 'hun';

/**
 * OCR options
 */
export interface OCROptions {
  /** OCR language(s) */
  languages: OCRLanguage[];
  /** Legacy single language string (e.g. 'eng' or 'chi_sim+eng') */
  language?: string;
  /** Scale factor for rendering (higher = better OCR but slower) */
  scale: number;
  /** Specific pages to OCR (empty = all pages) */
  pages: number[];
  /** Output format */
  outputFormat: 'text' | 'searchable-pdf' | 'markdown' | 'json';
  /** Preserve original layout in text output */
  preserveLayout: boolean;
  /** Auto enhance contrast and sharpness before OCR (recommended for scans & receipts) */
  enhanceContrast?: boolean;
}

/**
 * Default options
 */
const DEFAULT_OPTIONS: OCROptions = {
  languages: ['eng'],
  scale: 2,
  pages: [],
  outputFormat: 'text',
  preserveLayout: false,
  enhanceContrast: true,
};

/**
 * Language display names
 */
export const OCR_LANGUAGE_NAMES: Record<OCRLanguage, string> = {
  eng: 'English',
  chi_sim: 'Chinese (Simplified)',
  chi_tra: 'Chinese (Traditional)',
  jpn: 'Japanese',
  kor: 'Korean',
  spa: 'Spanish',
  fra: 'French',
  deu: 'German',
  por: 'Portuguese',
  ara: 'Arabic',
  hun: 'Hungarian',
};

// Tesseract worker type
type TesseractWorker = {
  loadLanguage?: (lang: string) => Promise<void>;
  initialize?: (lang: string) => Promise<void>;
  recognize: (image: string | HTMLCanvasElement, options?: any, output?: any) => Promise<{ data: { text: string; words?: any[]; blocks?: any[] } }>;
  terminate: () => Promise<void>;
};

/**
 * Read File or Blob as Uint8Array reliably across browsers, Node, and jsdom
 */
export async function readFileAsUint8Array(file: File | Blob): Promise<Uint8Array> {
  if (typeof (file as any).arrayBuffer === 'function') {
    try {
      const buf = await (file as any).arrayBuffer();
      return new Uint8Array(buf);
    } catch {
      // fallback to FileReader if arrayBuffer() throws
    }
  }

  if (typeof FileReader !== 'undefined') {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        if (reader.result instanceof ArrayBuffer) {
          resolve(new Uint8Array(reader.result));
        } else {
          resolve(new Uint8Array(0));
        }
      };
      reader.onerror = () => reject(reader.error || new Error('Failed to read file'));
      reader.readAsArrayBuffer(file);
    });
  }

  throw new Error('Cannot read file bytes');
}

/**
 * Preprocess canvas pixels to enhance contrast and sharpness
 * Helps significantly with scanned receipts, faint text, and dark background noise
 */
export function preprocessCanvas(canvas: HTMLCanvasElement): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  try {
    const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const data = imgData.data;
    const len = data.length;

    // 1. Calculate min and max luminance for linear contrast stretching
    let minLum = 255;
    let maxLum = 0;
    for (let i = 0; i < len; i += 4) {
      const lum = (data[i] * 299 + data[i + 1] * 587 + data[i + 2] * 114) / 1000;
      if (lum < minLum) minLum = lum;
      if (lum > maxLum) maxLum = lum;
    }

    const lumRange = maxLum - minLum;
    if (lumRange > 15 && lumRange < 240) {
      const scale = 255 / lumRange;
      for (let i = 0; i < len; i += 4) {
        const lum = (data[i] * 299 + data[i + 1] * 587 + data[i + 2] * 114) / 1000;
        // Stretch contrast
        const stretched = Math.min(255, Math.max(0, (lum - minLum) * scale));
        // Tone curve: darken text (< 135) and brighten paper background (> 180)
        let finalVal = stretched;
        if (stretched < 135) {
          finalVal = Math.max(0, stretched * 0.82);
        } else if (stretched > 180) {
          finalVal = Math.min(255, 180 + (stretched - 180) * 1.5);
        }
        data[i] = finalVal;
        data[i + 1] = finalVal;
        data[i + 2] = finalVal;
      }
      ctx.putImageData(imgData, 0, 0);
    }
  } catch {
    // Graceful fallback if getImageData is blocked or mocked
  }
}

/**
 * Generate clean Markdown text from OCR results preserving paragraphs and page breaks
 */
export function generateMarkdownOutput(
  pagesData: Array<{ pageNum: number; text: string; words: any[] }>,
  docTitle: string
): string {
  const sections: string[] = [
    `# ${docTitle.replace(/\.[^.]+$/, '')}`,
    `> *Extracted via PDFCraft OCR on ${new Date().toLocaleDateString()}*`,
    '',
  ];

  for (const p of pagesData) {
    sections.push(`## Page ${p.pageNum}\n`);
    const cleaned = (p.text || '')
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter((line, idx, arr) => line.length > 0 || (idx > 0 && arr[idx - 1].length > 0))
      .join('\n\n');
    sections.push(cleaned || '*(No text detected on this page)*');
    sections.push('\n---\n');
  }

  return sections.join('\n');
}

/**
 * Generate structured JSON output with word bounding boxes and confidence metrics
 */
export function generateJsonOutput(
  pagesData: Array<{ pageNum: number; text: string; words: any[] }>,
  meta: {
    fileName: string;
    languages: string[];
    totalWords: number;
    totalChars: number;
    avgConfidence: number;
  }
): string {
  return JSON.stringify(
    {
      metadata: {
        ...meta,
        generatedAt: new Date().toISOString(),
        engine: 'PDFCraft OCR Engine v2',
      },
      pages: pagesData.map(p => ({
        pageNumber: p.pageNum,
        text: p.text,
        wordCount: p.words.length,
        words: p.words.map(w => ({
          text: w.text,
          confidence: w.confidence,
          bbox: {
            x: Math.round(w.x * 100) / 100,
            y: Math.round(w.y * 100) / 100,
            width: Math.round(w.width * 100) / 100,
            height: Math.round(w.height * 100) / 100,
          },
        })),
      })),
    },
    null,
    2
  );
}

/**
 * Detect file type by sniffing binary magic bytes first, then MIME/extension
 */
export async function detectFileType(file: File | Blob): Promise<'pdf' | 'image' | 'unknown'> {
  try {
    let bytes: Uint8Array = new Uint8Array(0);

    // Try reading header bytes
    if (file.slice) {
      try {
        const slice = file.slice(0, 32);
        bytes = await readFileAsUint8Array(slice);
      } catch {
        // ignore
      }
    }

    if (bytes.length === 0) {
      try {
        const fullBytes = await readFileAsUint8Array(file);
        bytes = fullBytes.slice(0, 32);
      } catch {
        // ignore
      }
    }

    // PDF magic bytes: %PDF- (0x25 0x50 0x44 0x46)
    if (bytes.length >= 4 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46) {
      return 'pdf';
    }

    // PNG: 0x89 0x50 0x4E 0x47
    if (bytes.length >= 4 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47) {
      return 'image';
    }

    // JPEG: 0xFF 0xD8 0xFF
    if (bytes.length >= 3 && bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF) {
      return 'image';
    }

    // WebP: RIFF....WEBP
    if (
      bytes.length >= 12 &&
      bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
      bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
    ) {
      return 'image';
    }

    // BMP: BM (0x42 0x4D)
    if (bytes.length >= 2 && bytes[0] === 0x42 && bytes[1] === 0x4D) {
      return 'image';
    }
  } catch {
    // ignore
  }

  // Fallbacks
  const fileName = (file as File).name || '';
  const fileType = file.type || '';
  if (fileType.includes('pdf') || fileName.toLowerCase().endsWith('.pdf')) {
    return 'pdf';
  }
  if (fileType.startsWith('image/') || /\.(png|jpe?g|webp|bmp|tiff?)$/i.test(fileName)) {
    return 'image';
  }

  return 'unknown';
}

/**
 * OCR PDF Processor
 * Performs OCR on PDF pages or images using Tesseract.js.
 */
export class OCRProcessor extends BasePDFProcessor {
  private tesseractWorker: TesseractWorker | null = null;

  /**
   * Process PDF or Image with OCR
   */
  async process(
    input: ProcessInput,
    onProgress?: ProgressCallback
  ): Promise<ProcessOutput> {
    this.reset();
    this.onProgress = onProgress;

    const { files, options } = input;
    const rawOptions = (options || {}) as any;

    // Resolve languages (support both languages array and language string)
    let languages: OCRLanguage[] = DEFAULT_OPTIONS.languages;
    if (Array.isArray(rawOptions.languages) && rawOptions.languages.length > 0) {
      languages = rawOptions.languages;
    } else if (typeof rawOptions.language === 'string' && rawOptions.language.trim()) {
      languages = rawOptions.language.split('+').map((s: string) => s.trim()) as OCRLanguage[];
    }

    const ocrOptions: OCROptions = {
      ...DEFAULT_OPTIONS,
      ...rawOptions,
      languages,
    };

    // Validate input files
    if (!files || files.length === 0) {
      return this.createErrorOutput(
        PDFErrorCode.INVALID_OPTIONS,
        'No PDF or image file found. Please provide a file to perform OCR on.',
        'Received 0 files.'
      );
    }

    if (files.length !== 1) {
      return this.createErrorOutput(
        PDFErrorCode.INVALID_OPTIONS,
        'Please provide exactly one PDF or image file.',
        `Received ${files.length} file(s).`
      );
    }

    const file = files[0];
    const detectedType = await detectFileType(file);

    if (detectedType === 'unknown') {
      return this.createErrorOutput(
        PDFErrorCode.FILE_TYPE_INVALID,
        'Invalid file type. Please upload a PDF or image file (PNG, JPG, WebP).',
        `Received: ${file.type || 'unknown'}, filename: ${file.name}`
      );
    }

    try {
      this.updateProgress(5, 'Loading libraries...');

      const pdfjs = await loadPdfjs();

      if (this.checkCancelled()) {
        return this.createErrorOutput(
          PDFErrorCode.PROCESSING_CANCELLED,
          'Processing was cancelled.'
        );
      }

      this.updateProgress(10, 'Initializing OCR engine...');

      // Initialize Tesseract
      await this.initializeTesseract(ocrOptions.languages);

      this.updateProgress(20, 'Loading document...');

      // If the input file is an image, convert it to a single-page PDF first
      let pdfBytesToLoad: Uint8Array;
      let effectiveFileForSearchable: File = file;

      if (detectedType === 'image') {
        const converted = await this.convertImageToPDF(file);
        pdfBytesToLoad = converted.pdfBytes;
        effectiveFileForSearchable = new File(
          [converted.pdfBytes as unknown as BlobPart],
          file.name.replace(/\.[^.]+$/, '') + '.pdf',
          { type: 'application/pdf' }
        );
      } else {
        pdfBytesToLoad = await readFileAsUint8Array(file);
      }

      // Load the PDF document into PDF.js
      const pdf = await pdfjs.getDocument({ data: pdfBytesToLoad }).promise;
      const totalPages = pdf.numPages;

      // Determine which pages to OCR
      const pagesToOCR = ocrOptions.pages.length > 0
        ? ocrOptions.pages.filter(p => p >= 1 && p <= totalPages)
        : Array.from({ length: totalPages }, (_, i) => i + 1);

      if (pagesToOCR.length === 0) {
        await this.terminateTesseract();
        return this.createErrorOutput(
          PDFErrorCode.INVALID_PAGE_RANGE,
          'No valid pages to OCR.',
          `PDF has ${totalPages} pages.`
        );
      }

      this.updateProgress(25, `Processing ${pagesToOCR.length} page(s)...`);

      const textResults: string[] = [];
      const ocrPagesData: Array<{ pageNum: number; words: any[] }> = [];
      const progressPerPage = 70 / pagesToOCR.length;

      for (let i = 0; i < pagesToOCR.length; i++) {
        if (this.checkCancelled()) {
          await this.terminateTesseract();
          return this.createErrorOutput(
            PDFErrorCode.PROCESSING_CANCELLED,
            'Processing was cancelled.'
          );
        }

        const pageNum = pagesToOCR[i];
        const pageProgress = 25 + (i * progressPerPage);

        this.updateProgress(
          pageProgress,
          `OCR processing page ${pageNum} of ${totalPages}...`
        );

        try {
          const pageData = await this.ocrPage(pdf, pageNum, ocrOptions);
          textResults.push(`--- Page ${pageNum} ---\n${pageData.text}`);
          ocrPagesData.push({ pageNum, words: pageData.words });
        } catch (error) {
          textResults.push(`--- Page ${pageNum} ---\n[OCR Error: ${error instanceof Error ? error.message : 'Unknown error'}]`);
        }
      }

      await this.terminateTesseract();

      this.updateProgress(95, 'Generating output...');

      // Calculate summary metrics
      let totalWords = 0;
      let totalChars = 0;
      let confidenceSum = 0;
      let confidenceCount = 0;

      for (const p of ocrPagesData) {
        for (const w of p.words) {
          totalWords++;
          totalChars += (w.text || '').length;
          if (typeof w.confidence === 'number') {
            confidenceSum += w.confidence;
            confidenceCount++;
          }
        }
      }
      const avgConfidence = confidenceCount > 0 ? Math.round(confidenceSum / confidenceCount) : 92;

      // Generate output based on format
      let blob: Blob;
      let outputFilename: string;
      const baseName = file.name.replace(/\.(pdf|png|jpe?g|webp|bmp|tiff?)$/i, '');
      const fullText = textResults.join('\n\n');

      if (ocrOptions.outputFormat === 'text') {
        blob = new Blob([fullText], { type: 'text/plain;charset=utf-8' });
        outputFilename = `${baseName}_ocr.txt`;
      } else if (ocrOptions.outputFormat === 'markdown') {
        const mdText = generateMarkdownOutput(
          ocrPagesData.map((p, idx) => ({
            pageNum: p.pageNum,
            text: textResults[idx] ? textResults[idx].replace(/^--- Page \d+ ---\n/, '') : '',
            words: p.words,
          })),
          file.name
        );
        blob = new Blob([mdText], { type: 'text/markdown;charset=utf-8' });
        outputFilename = `${baseName}_ocr.md`;
      } else if (ocrOptions.outputFormat === 'json') {
        const jsonText = generateJsonOutput(
          ocrPagesData.map((p, idx) => ({
            pageNum: p.pageNum,
            text: textResults[idx] ? textResults[idx].replace(/^--- Page \d+ ---\n/, '') : '',
            words: p.words,
          })),
          {
            fileName: file.name,
            languages: ocrOptions.languages,
            totalWords,
            totalChars,
            avgConfidence,
          }
        );
        blob = new Blob([jsonText], { type: 'application/json;charset=utf-8' });
        outputFilename = `${baseName}_ocr.json`;
      } else {
        // For searchable PDF, create a PDF with the extracted text layer
        blob = await this.createSearchablePDF(effectiveFileForSearchable, ocrPagesData, ocrOptions);
        outputFilename = `${baseName}_searchable.pdf`;
      }

      this.updateProgress(100, 'Complete!');

      return this.createSuccessOutput(blob, outputFilename, {
        pageCount: pagesToOCR.length,
        languages: ocrOptions.languages,
        outputFormat: ocrOptions.outputFormat,
        totalWords,
        totalChars,
        avgConfidence,
        rawText: fullText,
      });

    } catch (error) {
      await this.terminateTesseract();
      return this.createErrorOutput(
        PDFErrorCode.PROCESSING_FAILED,
        'Failed to perform OCR on file.',
        error instanceof Error ? error.message : 'Unknown error'
      );
    }
  }

  /**
   * Convert an image File to a single-page PDFDocument and return its bytes
   */
  private async convertImageToPDF(file: File): Promise<{ pdfBytes: Uint8Array; pdfDoc: any }> {
    const pdfLib = await loadPdfLib();
    const pdfDoc = await pdfLib.PDFDocument.create();
    const bytes = await readFileAsUint8Array(file);

    let image;
    const isPng = bytes.length >= 4 && bytes[0] === 0x89 && bytes[1] === 0x50;
    if (isPng || file.type.includes('png') || file.name.toLowerCase().endsWith('.png')) {
      image = await pdfDoc.embedPng(bytes);
    } else {
      try {
        image = await pdfDoc.embedJpg(bytes);
      } catch {
        // In browser context, render onto canvas for formats like webp/bmp
        if (typeof document !== 'undefined') {
          const img = new Image();
          const blobUrl = URL.createObjectURL(file);
          await new Promise((resolve, reject) => {
            img.onload = resolve;
            img.onerror = reject;
            img.src = blobUrl;
          });
          URL.revokeObjectURL(blobUrl);

          const canvas = document.createElement('canvas');
          canvas.width = img.naturalWidth || img.width;
          canvas.height = img.naturalHeight || img.height;
          const ctx = canvas.getContext('2d');
          if (ctx) {
            ctx.drawImage(img, 0, 0);
            const pngBlob = await new Promise<Blob | null>((res) => canvas.toBlob(res, 'image/png'));
            if (pngBlob) {
              const pngBytes = new Uint8Array(await pngBlob.arrayBuffer());
              image = await pdfDoc.embedPng(pngBytes);
            } else {
              throw new Error('Could not convert image to canvas blob');
            }
          } else {
            throw new Error('Canvas 2D context unavailable');
          }
        } else {
          throw new Error(`Unsupported image format: ${file.name}`);
        }
      }
    }

    const page = pdfDoc.addPage([image.width, image.height]);
    page.drawImage(image, {
      x: 0,
      y: 0,
      width: image.width,
      height: image.height,
    });

    const pdfBytes = await pdfDoc.save();
    return { pdfBytes: new Uint8Array(pdfBytes), pdfDoc };
  }

  /**
   * Initialize Tesseract worker with progress reporting
   */
  private async initializeTesseract(languages: OCRLanguage[]): Promise<void> {
    const Tesseract = await import('tesseract.js');
    const langString = languages && languages.length > 0 ? languages.join('+') : 'eng';

    this.tesseractWorker = await Tesseract.createWorker(langString, 1, {
      logger: (m: any) => {
        if (m && m.status) {
          const percent = typeof m.progress === 'number' ? Math.round(m.progress * 100) : 0;
          this.updateProgress(
            15 + Math.round((m.progress || 0) * 10),
            `OCR: ${m.status}${percent > 0 ? ` (${percent}%)` : ''}`
          );
        }
      },
    }) as unknown as TesseractWorker;
  }

  /**
   * Terminate Tesseract worker
   */
  private async terminateTesseract(): Promise<void> {
    if (this.tesseractWorker) {
      await this.tesseractWorker.terminate();
      this.tesseractWorker = null;
    }
  }

  /**
   * Perform OCR on a single page and return text with word coordinates
   */
  private async ocrPage(
    pdf: any,
    pageNum: number,
    options: OCROptions
  ): Promise<{ text: string; words: any[] }> {
    if (!this.tesseractWorker) {
      throw new Error('Tesseract worker not initialized');
    }

    const page = await pdf.getPage(pageNum);
    const viewport = page.getViewport({ scale: options.scale });

    // Create canvas
    const canvas = document.createElement('canvas');
    canvas.width = viewport.width;
    canvas.height = viewport.height;

    const ctx = canvas.getContext('2d');
    if (!ctx) {
      throw new Error('Failed to get canvas context');
    }

    // Fill with white background
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Render PDF page to canvas
    await page.render({
      canvasContext: ctx,
      viewport: viewport,
    }).promise;

    // Apply smart image contrast enhancement if enabled (reduces noise on receipts/scans)
    if (options.enhanceContrast !== false) {
      preprocessCanvas(canvas);
    }

    // Perform OCR with explicit blocks/hocr requests to ensure word coordinates are extracted
    const result = await (this.tesseractWorker as any).recognize(
      canvas,
      {},
      { text: true, blocks: true, hocr: true }
    );
    
    // Coordinate conversion from canvas space to PDF coordinate space (y-flipped)
    const pdfViewport = page.getViewport({ scale: 1.0 });
    const pageHeight = pdfViewport.height;

    const rawWords = result.data.words || [];
    const words = rawWords.map((w: any) => {
      const bbox = w.bbox || { x0: 0, y0: 0, x1: 0, y1: 0 };
      const { x0, y0, x1, y1 } = bbox;
      const scale = options.scale;
      
      const pdfX = x0 / scale;
      const pdfY = pageHeight - (y1 / scale);
      const pdfWidth = (x1 - x0) / scale;
      const pdfHeight = (y1 - y0) / scale;

      return {
        text: w.text,
        confidence: typeof w.confidence === 'number' ? Math.round(w.confidence) : 90,
        x: pdfX,
        y: pdfY,
        width: pdfWidth,
        height: pdfHeight,
        fontSize: Math.max(5, pdfHeight * 0.85),
      };
    });

    return {
      text: result.data.text || '',
      words,
    };
  }

  /**
   * Create a searchable PDF with OCR transparent text layer and Unicode font embedding
   */
  private async createSearchablePDF(
    originalFile: File,
    ocrPagesData: Array<{ pageNum: number; words: any[] }>,
    options: OCROptions
  ): Promise<Blob> {
    const pdfLib = await loadPdfLib();

    // Load original PDF
    const fileBytes = await readFileAsUint8Array(originalFile);
    const pdfDoc = await pdfLib.PDFDocument.load(fileBytes);

    // Register fontkit and load Unicode font for non-Latin characters (Chinese, Japanese, Korean, etc.)
    let unicodeFont: any = null;
    try {
      const fontkit = await import('@pdf-lib/fontkit');
      pdfDoc.registerFontkit(fontkit.default || fontkit);

      let fontBuffer: ArrayBuffer | null = null;
      if (typeof window !== 'undefined') {
        try {
          const res = await fetch('/fonts/NotoSansSC-Regular.ttf');
          if (res.ok) {
            fontBuffer = await res.arrayBuffer();
          }
        } catch {
          // ignore
        }
      } else if (typeof process !== 'undefined' && process.versions && process.versions.node) {
        try {
          const fs = await import('fs');
          const path = await import('path');
          const localPath = path.resolve(process.cwd(), 'public/fonts/NotoSansSC-Regular.ttf');
          if (fs.existsSync(localPath)) {
            const fileBuf = fs.readFileSync(localPath);
            fontBuffer = fileBuf.buffer.slice(fileBuf.byteOffset, fileBuf.byteOffset + fileBuf.byteLength);
          }
        } catch {
          // ignore
        }
      }

      if (fontBuffer) {
        unicodeFont = await pdfDoc.embedFont(fontBuffer, { subset: false });
      }
    } catch (fontErr) {
      console.warn('[OCR] Unicode font embedding not available, falling back to standard font', fontErr);
    }

    const standardFont = await pdfDoc.embedFont(pdfLib.StandardFonts.Helvetica);

    for (const pageData of ocrPagesData) {
      const pageIdx = pageData.pageNum - 1;
      if (pageIdx >= pdfDoc.getPageCount()) continue;

      const page = pdfDoc.getPage(pageIdx);

      // Draw invisible text items
      for (const w of pageData.words) {
        const text = (w.text || '').trim();
        if (!text) continue;

        // Check if text contains non-ASCII characters
        const isNonAscii = /[^\u0020-\u007E]/.test(text);
        const fontToUse = (isNonAscii && unicodeFont) ? unicodeFont : standardFont;

        try {
          page.drawText(text, {
            x: Math.max(0, w.x),
            y: Math.max(0, w.y),
            size: Math.max(4, Math.min(72, w.fontSize)),
            font: fontToUse,
            color: pdfLib.rgb(0, 0, 0),
            opacity: 0.0, // Totally invisible text overlay
          });
        } catch (e) {
          // Fallback: try drawing safe ASCII version if possible
          if (fontToUse !== standardFont) {
            try {
              const asciiOnly = text.replace(/[^\u0020-\u007E]/g, ' ');
              if (asciiOnly.trim()) {
                page.drawText(asciiOnly, {
                  x: Math.max(0, w.x),
                  y: Math.max(0, w.y),
                  size: Math.max(4, Math.min(72, w.fontSize)),
                  font: standardFont,
                  color: pdfLib.rgb(0, 0, 0),
                  opacity: 0.0,
                });
              }
            } catch {
              // skip unencodable character safely
            }
          }
        }
      }
    }

    // Add metadata to indicate OCR was performed
    pdfDoc.setTitle(`${originalFile.name} (OCR)`);
    pdfDoc.setSubject('OCR processed document with invisible text layer');
    pdfDoc.setKeywords(['OCR', 'searchable', ...(options.languages || [])]);

    const pdfBytes = await pdfDoc.save({ useObjectStreams: true });
    return new Blob([new Uint8Array(pdfBytes)], { type: 'application/pdf' });
  }
}

/**
 * Create a new instance of the OCR processor
 */
export function createOCRProcessor(): OCRProcessor {
  return new OCRProcessor();
}

/**
 * Perform OCR on PDF (convenience function)
 */
export async function ocrPDF(
  file: File,
  options?: Partial<OCROptions>,
  onProgress?: ProgressCallback
): Promise<ProcessOutput> {
  const processor = createOCRProcessor();
  return processor.process(
    {
      files: [file],
      options: options || {},
    },
    onProgress
  );
}
