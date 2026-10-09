'use client';

import React, { useState, useCallback, useRef, useEffect } from 'react';
import { useTranslations } from 'next-intl';
import { FileUploader } from '../FileUploader';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { withBasePath } from '@/lib/utils/path';
import { saveBlobFile } from '@/lib/tauri-bridge';
import { SignatureExtractorModal } from './SignatureExtractorModal';
import { SignatureLibraryModal } from './SignatureLibraryModal';
import { getSavedSignatures } from '@/lib/pdf/signature-storage';

export interface SignPDFToolProps {
  className?: string;
}

interface SignState {
  file: File | null;
  viewerReady: boolean;
}

type PdfViewerWindow = Window & {
  PDFViewerApplication?: {
    initializedPromise: Promise<void>;
    open: (args: { data: Uint8Array }) => Promise<void>;
    pdfDocument?: {
      annotationStorage: { size: number };
      saveDocument: () => Promise<Uint8Array | ArrayBuffer>;
    };
    pdfViewer?: {
      annotationEditorUIManager?: { commitOrRemove: () => void };
      annotationEditorMode: { mode: number };
    };
    eventBus?: {
      _on: (
        event: string,
        listener: () => void,
        options?: { once?: boolean }
      ) => void;
    };
  };
  pdfjsLib?: {
    AnnotationEditorType?: { NONE: number };
  };
  pdfcraftImportSignature?: (blob: Blob, name?: string) => Promise<boolean>;
};

const VIEWER_HTML = withBasePath('/pdfjs-viewer/viewer.html');

/**
 * SignPDFTool Component
 * Uses PDF.js viewer with native signature editor for comprehensive signing support.
 * Supports: draw (handwritten), type, and image signatures.
 */
export function SignPDFTool({ className = '' }: SignPDFToolProps) {
  const t = useTranslations('common');
  const tTools = useTranslations('tools');

  const [signState, setSignState] = useState<SignState>({
    file: null,
    viewerReady: false,
  });
  const [error, setError] = useState<string | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);

  // Extractor & Library modals
  const [isExtractorOpen, setIsExtractorOpen] = useState(false);
  const [isLibraryOpen, setIsLibraryOpen] = useState(false);
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [savedSignatureCount, setSavedSignatureCount] = useState<number>(0);

  useEffect(() => {
    setSavedSignatureCount(getSavedSignatures().length);
  }, [isExtractorOpen, isLibraryOpen]);

  const handleSignatureExtracted = useCallback((res: { blob: Blob; dataUrl: string; name: string }) => {
    setSavedSignatureCount(getSavedSignatures().length);
    setToastMessage(`签名“${res.name}”已成功存入签名库！您可以在工具栏的签名笔或签名库中直接使用。`);
    setTimeout(() => setToastMessage(null), 6000);
  }, []);

  const iframeRef = useRef<HTMLIFrameElement>(null);
  const fileRef = useRef<File | null>(null);

  /**
   * Handle file selected
   */
  const handleFilesSelected = useCallback((files: File[]) => {
    if (files.length > 0) {
      const file = files[0];
      fileRef.current = file;

      // Configure PDF.js preferences for signature editor
      try {
        const existingPrefsRaw = localStorage.getItem('pdfjs.preferences');
        const existingPrefs = existingPrefsRaw ? JSON.parse(existingPrefsRaw) : {};
        delete existingPrefs.annotationEditorMode;
        const newPrefs = {
          ...existingPrefs,
          enableSignatureEditor: true,
          enablePermissions: false,
        };
        localStorage.setItem('pdfjs.preferences', JSON.stringify(newPrefs));
      } catch (e) {
        console.warn('Could not set PDF.js preferences:', e);
      }

      setSignState({
        file,
        viewerReady: false,
      });
      setError(null);
    }
  }, []);

  /**
   * Handle file upload error
   */
  const handleUploadError = useCallback((errorMessage: string) => {
    setError(errorMessage);
  }, []);

  /**
   * Enable signature tools in the viewer UI
   */
  const enableSignatureTools = useCallback((viewerWindow: PdfViewerWindow) => {
    const app = viewerWindow.PDFViewerApplication;
    if (!app?.eventBus) return;

    const doc = viewerWindow.document;
    const { eventBus } = app;

    const enable = () => {
      const editorModeButtons = doc.getElementById('editorModeButtons');
      editorModeButtons?.classList.remove('hidden');

      const editorSignature = doc.getElementById('editorSignature');
      editorSignature?.removeAttribute('hidden');

      const editorSignatureButton = doc.getElementById('editorSignatureButton') as HTMLButtonElement | null;
      if (editorSignatureButton) {
        editorSignatureButton.disabled = false;
      }

      const editorStamp = doc.getElementById('editorStamp');
      editorStamp?.removeAttribute('hidden');

      const editorStampButton = doc.getElementById('editorStampButton') as HTMLButtonElement | null;
      if (editorStampButton) {
        editorStampButton.disabled = false;
      }
    };

    eventBus._on('annotationeditoruimanager', enable);
    enable();
  }, []);

  /**
   * Load PDF into viewer via ArrayBuffer (avoids blob: URL issues on HTTP)
   */
  const handleIframeLoad = useCallback(async () => {
    const file = fileRef.current;
    const iframe = iframeRef.current;
    if (!file || !iframe?.contentWindow) return;

    try {
      const viewerWindow = iframe.contentWindow as PdfViewerWindow;
      const app = viewerWindow.PDFViewerApplication;
      if (!app) return;

      await app.initializedPromise;

      let documentLoaded = false;
      const onDocumentLoaded = () => {
        if (documentLoaded) return;
        documentLoaded = true;
        setSignState(prev => ({ ...prev, viewerReady: true }));
        enableSignatureTools(viewerWindow);
      };

      app.eventBus?._on('documentloaded', onDocumentLoaded, { once: true });

      const pdfData = new Uint8Array(await file.arrayBuffer());
      await app.open({ data: pdfData });

      if (!documentLoaded && app.pdfDocument) {
        onDocumentLoaded();
      }
    } catch (e) {
      console.error('Could not load PDF in viewer:', e);
      setError('Failed to load PDF in the viewer. Please try again.');
    }
  }, [enableSignatureTools]);

  /**
   * Save signed PDF using PDF.js native save (embeds signatures into the file)
   */
  const handleSave = useCallback(async () => {
    if (!signState.viewerReady || !iframeRef.current) {
      setError('Viewer not ready. Please wait for the PDF to load.');
      return;
    }

    try {
      setIsProcessing(true);
      setError(null);

      const viewerWindow = iframeRef.current.contentWindow as PdfViewerWindow;
      const app = viewerWindow.PDFViewerApplication;

      if (!app?.pdfDocument) {
        setError('PDF viewer not initialized.');
        setIsProcessing(false);
        return;
      }

      const { pdfDocument, pdfViewer } = app;

      // Commit any signature still being placed/edited
      pdfViewer?.annotationEditorUIManager?.commitOrRemove();
      // Exit editor mode (PDF.js expects { mode }, not a raw number; DISABLE is invalid here)
      if (pdfViewer) {
        const editorNone =
          viewerWindow.pdfjsLib?.AnnotationEditorType?.NONE ?? 0;
        pdfViewer.annotationEditorMode = { mode: editorNone };
      }

      if (pdfDocument.annotationStorage.size === 0) {
        setError(
          'No signature found. Add a signature using the pen tool in the toolbar, then try again.'
        );
        setIsProcessing(false);
        return;
      }

      const rawPdfBytes = await pdfDocument.saveDocument();
      const pdfBytes =
        rawPdfBytes instanceof Uint8Array
          ? rawPdfBytes
          : new Uint8Array(rawPdfBytes);

      const blob = new Blob([pdfBytes as unknown as BlobPart], { type: 'application/pdf' });
      const downloadName = `signed_${signState.file?.name || 'document.pdf'}`;
      await saveBlobFile(blob, downloadName);

      setIsProcessing(false);
    } catch (err) {
      console.error('Failed to save signed PDF:', err);
      const msg = err instanceof Error ? err.message : 'Please try again.';
      setError(`Failed to save signed PDF: ${msg}`);
      setIsProcessing(false);
    }
  }, [signState.viewerReady, signState.file]);

  /**
   * Clear and start over
   */
  const handleClear = useCallback(() => {
    fileRef.current = null;
    setSignState({
      file: null,
      viewerReady: false,
    });
    setError(null);
  }, []);

  return (
    <div className={`space-y-6 ${className}`.trim()}>
      {/* Quick Action Header: Signature Extractor & Library */}
      <div className="flex flex-wrap items-center justify-between gap-4 p-4 bg-gradient-to-r from-blue-50/90 via-indigo-50/80 to-sky-50/80 border border-blue-200 rounded-[var(--radius-lg)] shadow-xs">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-full bg-blue-600 text-white flex items-center justify-center shadow-sm flex-shrink-0">
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
            </svg>
          </div>
          <div>
            <h3 className="text-sm font-semibold text-gray-900 flex items-center gap-2">
              <span>从已签署 PDF 提取签名 / 印章</span>
              <span className="text-[10px] font-normal px-2 py-0.5 rounded-full bg-blue-100 text-blue-700">
                支持 Adobe Acrobat
              </span>
            </h3>
            <p className="text-xs text-gray-600 mt-0.5">
              上传已签名的 PDF，智能识别笔迹或印章并剥离纸张白底，一键存入签名库随时使用。
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setIsLibraryOpen(true)}
            className="text-xs bg-white hover:bg-gray-50 flex items-center gap-1.5"
          >
            <span>📂 签名库</span>
            {savedSignatureCount > 0 && (
              <span className="px-1.5 py-0.2 rounded-full text-[10px] bg-blue-100 text-blue-700 font-medium">
                {savedSignatureCount}
              </span>
            )}
          </Button>

          <Button
            variant="primary"
            size="sm"
            onClick={() => setIsExtractorOpen(true)}
            className="text-xs flex items-center gap-1.5 shadow-sm bg-blue-600 hover:bg-blue-700"
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
            </svg>
            <span>提取签名</span>
          </Button>
        </div>
      </div>

      {/* Toast Notification */}
      {toastMessage && (
        <div className="p-3 bg-emerald-50 border border-emerald-200 text-emerald-800 text-sm rounded-[var(--radius-md)] flex items-center justify-between shadow-xs animate-in fade-in duration-200">
          <div className="flex items-center gap-2">
            <svg className="w-5 h-5 text-emerald-600 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
            </svg>
            <span>{toastMessage}</span>
          </div>
          <button
            type="button"
            onClick={() => setToastMessage(null)}
            className="text-emerald-600 hover:text-emerald-900 text-xs px-2"
          >
            ✕
          </button>
        </div>
      )}

      {/* File Upload Area - Only show when no file */}
      {!signState.file && (
        <FileUploader
          accept={['application/pdf', '.pdf']}
          multiple={false}
          maxFiles={1}
          onFilesSelected={handleFilesSelected}
          onError={handleUploadError}
          disabled={isProcessing}
          label={tTools('signPdf.uploadLabel') || 'Upload PDF File'}
          description={tTools('signPdf.uploadDescription') || 'Drag and drop a PDF file to sign.'}
        />
      )}

      {/* Error Message */}
      {error && (
        <div
          className="p-4 rounded-[var(--radius-md)] bg-red-50 border border-red-200 text-red-700"
          role="alert"
        >
          <p className="text-sm">{error}</p>
        </div>
      )}

      {/* PDF Viewer */}
      {signState.file && (
        <>
          {/* File Info & Clear Button */}
          <Card variant="outlined">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <svg className="w-8 h-8 text-red-500" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6z" />
                  <path d="M14 2v6h6" fill="white" />
                </svg>
                <div>
                  <p className="text-sm font-medium text-[hsl(var(--color-foreground))]">
                    {signState.file.name}
                  </p>
                  <p className="text-xs text-[hsl(var(--color-muted-foreground))]">
                    {(signState.file.size / 1024 / 1024).toFixed(2)} MB
                  </p>
                </div>
              </div>
              <Button
                variant="ghost"
                size="sm"
                onClick={handleClear}
                disabled={isProcessing}
              >
                {t('buttons.remove') || 'Remove'}
              </Button>
            </div>
          </Card>

          {/* Instructions */}
          <Card variant="outlined" className="bg-blue-50 border-blue-200">
            <div className="flex gap-3">
              <svg className="w-5 h-5 text-blue-500 flex-shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              <div className="text-sm text-blue-700">
                <p className="font-medium mb-1">{tTools('signPdf.instructionsTitle') || 'How to Sign'}</p>
                <ol className="list-decimal list-inside space-y-1 text-blue-600">
                  <li>{tTools('signPdf.instruction1') || 'Click the Signature tool (pen icon) in the toolbar'}</li>
                  <li>{tTools('signPdf.instruction2') || 'Draw, type, or upload your signature'}</li>
                  <li>{tTools('signPdf.instruction3') || 'Click where you want to place the signature'}</li>
                  <li>{tTools('signPdf.instruction4') || 'Click "Save Signed PDF" below when done'}</li>
                </ol>
              </div>
            </div>
          </Card>

          {/* PDF.js Viewer Iframe */}
          <div className="border border-[hsl(var(--color-border))] rounded-[var(--radius-lg)] overflow-hidden">
            <iframe
              key={signState.file.name + signState.file.lastModified}
              ref={iframeRef}
              src={VIEWER_HTML}
              onLoad={handleIframeLoad}
              className="w-full bg-gray-100"
              style={{ height: '600px', border: 'none' }}
              title="PDF Signature Editor"
            />
          </div>

          {/* Save Button */}
          <Card variant="outlined">
            <div className="flex gap-4">
              <Button
                variant="primary"
                size="lg"
                onClick={handleSave}
                disabled={!signState.viewerReady || isProcessing}
                loading={isProcessing}
              >
                {isProcessing
                  ? (t('status.processing') || 'Processing...')
                  : (tTools('signPdf.saveButton') || 'Save Signed PDF')
                }
              </Button>
            </div>
          </Card>
        </>
      )}

      {/* Signature Extractor Modal */}
      <SignatureExtractorModal
        isOpen={isExtractorOpen}
        onClose={() => setIsExtractorOpen(false)}
        viewerWindow={iframeRef.current?.contentWindow}
        onSignatureExtracted={handleSignatureExtracted}
      />

      {/* Signature Library Modal */}
      <SignatureLibraryModal
        isOpen={isLibraryOpen}
        onClose={() => setIsLibraryOpen(false)}
        viewerWindow={iframeRef.current?.contentWindow}
        onOpenExtractor={() => setIsExtractorOpen(true)}
      />
    </div>
  );
}

export default SignPDFTool;
