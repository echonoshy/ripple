import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "@/i18n";
import FilesPage from "./FilesPage";

const noop = () => {};

function renderFilesPage(overrides: Partial<React.ComponentProps<typeof FilesPage>> = {}) {
  return renderToStaticMarkup(
    <I18nProvider initialPreference="en-US">
      <FilesPage userId="default" refreshToken={0} {...overrides} />
    </I18nProvider>
  );
}

function testFilesHeaderDoesNotRenderTaskScopedActions() {
  const html = renderFilesPage();
  const toolbarSource = readFileSync(
    new URL("../workspace/WorkspaceToolbar.tsx", import.meta.url),
    "utf8"
  );

  assert.match(html, /data-ripple-files-page="finder-stage"/);
  assert.match(html, /data-presentation="page"/);
  assert.match(html, /data-ripple-files-mobile-primary-header="true"/);
  assert.match(html, /data-ripple-files-title-row="page"[^>]*lg:hidden/);
  assert.match(html, /data-ripple-files-title="primary"[^>]*>Files</);
  assert.match(toolbarSource, /filesMobilePrimaryHeaderClass/);
  assert.match(toolbarSource, /px-3 py-2 lg:hidden/);
  assert.doesNotMatch(toolbarSource, /px-3 py-3 lg:hidden/);
  assert.doesNotMatch(html, /data-ripple-mobile-page-header="true"/);
  assert.doesNotMatch(html, /aria-label="Back to session"/);
  assert.match(html, /lg:hidden/);
  assert.match(html, /#F5F6F7/);
  assert.doesNotMatch(html, /#ece6dc/);
  assert.doesNotMatch(html, /#faf6ee/);
  assert.doesNotMatch(html, />Header actions</);
  assert.doesNotMatch(html, /Copy task ID/);
  assert.doesNotMatch(html, /sm:hidden[^>]*>Workspace</);
  assert.doesNotMatch(html, /bg-white\/72 px-4 pt-\[max\(env\(safe-area-inset-top\),12px\)\] pb-3/);
  assert.doesNotMatch(html, /px-5 py-5 md:px-8/);
}

testFilesHeaderDoesNotRenderTaskScopedActions();

function testFilesPageSecondaryReturnUsesSharedMobilePageHeader() {
  const html = renderFilesPage({ onBack: noop });

  assert.match(html, /data-ripple-mobile-page-header="true"/);
  assert.match(html, /data-ripple-mobile-page-header-title="true"[^>]*>Files</);
  assert.match(html, /aria-label="Back to session"/);
}

testFilesPageSecondaryReturnUsesSharedMobilePageHeader();

function testFilesPagePassesPendingOpenFileRequestToExplorer() {
  const source = readFileSync(new URL("./FilesPage.tsx", import.meta.url), "utf8");

  assert.match(source, /openFileRequest\?: WorkspaceFileOpenRequest \| null/);
  assert.match(source, /openFileRequest=\{openFileRequest\}/);
}

testFilesPagePassesPendingOpenFileRequestToExplorer();

function testFilesPageUsesSharedWorkbenchBackground() {
  const source = readFileSync(new URL("./FilesPage.tsx", import.meta.url), "utf8");

  assert.match(source, /WORKBENCH_PAGE_BACKGROUND_CLASS/);
  assert.doesNotMatch(source, /COMPACT_IOS_PAGE_BACKGROUND/);
  assert.match(source, /MOBILE_PAGE_TOP_SAFE_AREA_CLASS/);
  assert.match(source, /MOBILE_PAGE_NAV_BOTTOM_PADDING_CLASS/);
  assert.doesNotMatch(source, /pb-\[calc\(88px\+env\(safe-area-inset-bottom\)\)\]/);
  assert.doesNotMatch(source, /circle_at_16%_0%/);
}

testFilesPageUsesSharedWorkbenchBackground();

console.log("files page tests passed");
