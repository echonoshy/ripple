"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Loader2 } from "lucide-react";
import type { PDFDocumentProxy, RenderTask } from "pdfjs-dist";
import type { PDFDocumentLoadingTask } from "pdfjs-dist/legacy/build/pdf.mjs";
import { useI18n } from "@/i18n";

interface PdfPreviewProps {
  blob: Blob;
  filename: string;
  fullscreen?: boolean;
  className?: string;
}

interface PdfPageProps {
  pdfDocument: PDFDocumentProxy;
  pageNumber: number;
  filename: string;
  fullscreen?: boolean;
}

const FULLSCREEN_PAGE_VERTICAL_CHROME_PX = 40;
type PdfJsModule = typeof import("pdfjs-dist/legacy/build/pdf.mjs");
let pdfJsModulePromise: Promise<PdfJsModule> | null = null;
let pdfWorkerConfigured = false;

function loadPdfJs(): Promise<PdfJsModule> {
  pdfJsModulePromise ??= import("pdfjs-dist/legacy/build/pdf.mjs");
  return pdfJsModulePromise;
}

async function configurePdfWorker(pdfjsLib: PdfJsModule): Promise<void> {
  if (pdfWorkerConfigured) return;
  const { default: pdfWorkerUrl } = await import("pdfjs-dist/legacy/build/pdf.worker.mjs?url");
  pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
  pdfWorkerConfigured = true;
}

function readablePdfError(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  return "PDF preview failed";
}

function PdfPage({ pdfDocument, pageNumber, filename, fullscreen = false }: PdfPageProps) {
  const { t } = useI18n();
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const frameRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [isNearViewport, setIsNearViewport] = useState(false);
  const [availableWidth, setAvailableWidth] = useState(0);
  const [availableHeight, setAvailableHeight] = useState(0);
  const [pageHeight, setPageHeight] = useState<number | null>(null);
  const [renderError, setRenderError] = useState<string | null>(null);

  useEffect(() => {
    const node = wrapperRef.current;
    if (!node) return;
    const frameNode = frameRef.current;

    const updateSize = () => {
      const measuredWidth =
        frameRef.current?.getBoundingClientRect().width ?? node.getBoundingClientRect().width;
      const viewportNode = node.parentElement?.parentElement;
      const measuredHeight = viewportNode?.getBoundingClientRect().height || 0;
      setAvailableWidth(Math.max(0, measuredWidth));
      setAvailableHeight(
        fullscreen ? Math.max(0, measuredHeight - FULLSCREEN_PAGE_VERTICAL_CHROME_PX) : 0
      );
    };

    updateSize();

    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", updateSize);
      return () => window.removeEventListener("resize", updateSize);
    }

    const resizeObserver = new ResizeObserver(updateSize);
    resizeObserver.observe(node);
    if (frameNode) {
      resizeObserver.observe(frameNode);
    }
    if (node.parentElement?.parentElement) {
      resizeObserver.observe(node.parentElement.parentElement);
    }
    return () => resizeObserver.disconnect();
  }, [fullscreen]);

  useEffect(() => {
    const node = wrapperRef.current;
    if (!node) return;

    if (typeof IntersectionObserver === "undefined") {
      const timeout = window.setTimeout(() => setIsNearViewport(true), 0);
      return () => window.clearTimeout(timeout);
    }

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setIsNearViewport(true);
          observer.disconnect();
        }
      },
      { rootMargin: "600px" }
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!isNearViewport || availableWidth <= 0) return;

    let cancelled = false;
    let renderTask: RenderTask | null = null;

    const renderPage = async () => {
      try {
        setRenderError(null);
        const page = await pdfDocument.getPage(pageNumber);
        if (cancelled) return;

        const baseViewport = page.getViewport({ scale: 1 });
        const pageScaleWidth = availableWidth / baseViewport.width;
        const pageScaleHeight =
          fullscreen && availableHeight > 0
            ? availableHeight / baseViewport.height
            : pageScaleWidth;
        const scale = Math.max(0.1, Math.min(pageScaleWidth, pageScaleHeight));
        const viewport = page.getViewport({ scale });
        const canvas = canvasRef.current;
        const canvasContext = canvas?.getContext("2d");
        if (!canvas || !canvasContext) return;

        const rawPixelRatio = window.devicePixelRatio || 1;
        const pixelRatio = Math.max(1, Math.min(rawPixelRatio, 2));
        canvas.width = Math.floor(viewport.width * pixelRatio);
        canvas.height = Math.floor(viewport.height * pixelRatio);
        canvas.style.width = `${Math.floor(viewport.width)}px`;
        canvas.style.height = `${Math.floor(viewport.height)}px`;
        setPageHeight(viewport.height);

        renderTask = page.render({
          canvasContext,
          viewport,
          transform: pixelRatio === 1 ? undefined : [pixelRatio, 0, 0, pixelRatio, 0, 0],
        });
        await renderTask.promise;
      } catch (error) {
        if (cancelled || (error instanceof Error && error.name === "RenderingCancelledException")) {
          return;
        }
        setRenderError(readablePdfError(error));
      }
    };

    void renderPage();

    return () => {
      cancelled = true;
      renderTask?.cancel();
    };
  }, [availableHeight, availableWidth, fullscreen, isNearViewport, pageNumber, pdfDocument]);

  return (
    <div
      ref={wrapperRef}
      data-ripple-pdf-page={pageNumber}
      className={fullscreen ? "w-full px-3 py-4 sm:px-6" : "w-full px-3 py-3 sm:px-4"}
    >
      <div
        ref={frameRef}
        className={
          fullscreen
            ? "mx-auto flex w-full justify-center"
            : "mx-auto flex w-full max-w-5xl justify-center"
        }
      >
        <div
          className="relative max-w-full overflow-hidden rounded-md border border-[#DEE0E3] bg-white shadow-[0_12px_30px_rgba(31,35,41,0.08)]"
          style={pageHeight ? { minHeight: Math.ceil(pageHeight) } : undefined}
        >
          {isNearViewport ? (
            <canvas
              ref={canvasRef}
              aria-label={t("files.pdfPageLabel", { page: pageNumber, name: filename })}
              className="block max-w-full bg-white"
            />
          ) : (
            <div className="h-[560px] w-[396px] max-w-full bg-white" />
          )}
          {renderError && (
            <div className="absolute inset-0 flex items-center justify-center bg-white/92 px-4 text-center text-xs font-medium text-[#B42318]">
              {renderError}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export function PdfPreview({
  blob,
  filename,
  fullscreen = false,
  className = "",
}: PdfPreviewProps) {
  const { t } = useI18n();
  const loadedDocumentRef = useRef<PDFDocumentProxy | null>(null);
  const [loadedPreview, setLoadedPreview] = useState<{
    blob: Blob;
    document: PDFDocumentProxy;
  } | null>(null);
  const [loadError, setLoadError] = useState<{
    blob: Blob;
    message: string;
  } | null>(null);

  useEffect(() => {
    let cancelled = false;
    let loadingTask: PDFDocumentLoadingTask | null = null;

    const loadDocument = async () => {
      try {
        const pdfjsLib = await loadPdfJs();
        await configurePdfWorker(pdfjsLib);
        const data = new Uint8Array(await blob.arrayBuffer());
        if (cancelled) return;
        loadingTask = pdfjsLib.getDocument({ data: data });
        const loadedDocument = await loadingTask.promise;
        if (!cancelled) {
          void loadedDocumentRef.current?.destroy();
          loadedDocumentRef.current = loadedDocument;
          setLoadedPreview({ blob, document: loadedDocument });
        }
      } catch (loadError) {
        if (!cancelled) {
          setLoadError({ blob, message: readablePdfError(loadError) });
        }
      }
    };

    void loadDocument();

    return () => {
      cancelled = true;
      void loadingTask?.destroy();
    };
  }, [blob]);

  useEffect(() => {
    return () => {
      void loadedDocumentRef.current?.destroy();
    };
  }, []);

  const pdfDocument = loadedPreview?.blob === blob ? loadedPreview.document : null;
  const error = loadError?.blob === blob ? loadError.message : null;

  const pageNumbers = useMemo(
    () =>
      pdfDocument ? Array.from({ length: pdfDocument.numPages }, (_, index) => index + 1) : [],
    [pdfDocument]
  );

  const rootClassName = [
    "flex h-full min-h-0 flex-col bg-[#f4f7fb]",
    fullscreen ? "overflow-hidden" : "overflow-hidden",
    className,
  ]
    .filter(Boolean)
    .join(" ");

  if (error) {
    return (
      <div
        data-ripple-pdf-preview
        data-ripple-pdf-state="error"
        className={`${rootClassName} items-center justify-center px-4 text-center`}
      >
        <AlertTriangle size={20} className="mb-2 text-[#B42318]" />
        <p className="text-sm font-semibold text-[#1F2329]">{t("files.pdfPreviewFailed")}</p>
        <p className="mt-1 max-w-md text-xs text-[#646A73]">{error}</p>
      </div>
    );
  }

  if (!pdfDocument) {
    return (
      <div
        data-ripple-pdf-preview
        data-ripple-pdf-state="loading"
        className={`${rootClassName} items-center justify-center gap-2 text-sm font-medium text-[#646A73]`}
      >
        <Loader2 size={18} className="animate-spin" />
        <span>{t("files.pdfLoading")}</span>
      </div>
    );
  }

  return (
    <div data-ripple-pdf-preview data-ripple-pdf-state="ready" className={rootClassName}>
      <div className="min-h-0 flex-1 overflow-auto">
        <div className={fullscreen ? "mx-auto w-full py-2 sm:py-4" : "mx-auto w-full py-2"}>
          {pageNumbers.map((pageNumber) => (
            <PdfPage
              key={pageNumber}
              pdfDocument={pdfDocument}
              pageNumber={pageNumber}
              filename={filename}
              fullscreen={fullscreen}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
