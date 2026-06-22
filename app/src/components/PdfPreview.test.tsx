import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("./PdfPreview.tsx", import.meta.url), "utf8");

function testPdfPreviewUsesPdfJsLegacyWorker() {
  assert.match(source, /from "pdfjs-dist\/legacy\/build\/pdf\.mjs"/);
  assert.match(source, /pdfjs-dist\/legacy\/build\/pdf\.worker\.mjs\?url/);
  assert.match(source, /GlobalWorkerOptions\.workerSrc\s*=\s*pdfWorkerUrl/);
}

testPdfPreviewUsesPdfJsLegacyWorker();

function testPdfPreviewRendersPagesToCanvas() {
  assert.match(source, /getDocument\(\{\s*data:/);
  assert.match(source, /getPage\(pageNumber\)/);
  assert.match(source, /getViewport\(\{\s*scale/);
  assert.match(source, /pageScaleWidth/);
  assert.match(source, /pageScaleHeight/);
  assert.match(source, /Math\.min\(pageScaleWidth,\s*pageScaleHeight\)/);
  assert.match(source, /canvas/);
  assert.match(source, /render\(\{\s*canvasContext/);
}

testPdfPreviewRendersPagesToCanvas();

function testPdfPreviewIsMobileMemoryAware() {
  assert.match(source, /IntersectionObserver/);
  assert.match(source, /devicePixelRatio/);
  assert.match(source, /Math\.min\([^)]*2/);
  assert.match(source, /rootMargin:\s*"600px"/);
}

testPdfPreviewIsMobileMemoryAware();

function testPdfPreviewExposesLoadingErrorAndPageLabels() {
  assert.match(source, /files\.pdfLoading/);
  assert.match(source, /files\.pdfPreviewFailed/);
  assert.match(source, /files\.pdfPageLabel/);
}

testPdfPreviewExposesLoadingErrorAndPageLabels();

function testFullscreenPdfPreviewBoundsPageScaleByViewportHeight() {
  assert.match(source, /FULLSCREEN_PAGE_VERTICAL_CHROME_PX/);
  assert.match(source, /availableHeight/);
  assert.match(source, /fullscreen \? Math\.max/);
  assert.match(source, /setAvailableHeight/);
  assert.match(source, /canvas\.style\.height = `\$\{Math\.floor\(viewport\.height\)\}px`/);
}

testFullscreenPdfPreviewBoundsPageScaleByViewportHeight();

function testFullscreenPdfPreviewUsesActualFrameWidth() {
  assert.match(source, /const frameRef = useRef<HTMLDivElement \| null>\(null\)/);
  assert.match(source, /frameRef\.current\?\.getBoundingClientRect\(\)\.width/);
  assert.match(source, /resizeObserver\.observe\(frameNode\)/);
  assert.match(source, /fullscreen\s*\?\s*"mx-auto flex w-full justify-center"/);
  assert.doesNotMatch(source, /fullscreen \? "mx-auto flex w-full max-w-5xl/);
}

testFullscreenPdfPreviewUsesActualFrameWidth();

console.log("pdf preview tests passed");
