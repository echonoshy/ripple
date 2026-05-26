import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import FilesPage from "./FilesPage";

const noop = () => {};

function renderFilesPage() {
  return renderToStaticMarkup(<FilesPage userId="default" refreshToken={0} onBack={noop} />);
}

function testFilesHeaderDoesNotRenderTaskScopedActions() {
  const html = renderFilesPage();

  assert.match(html, />Files</);
  assert.match(html, /sm:hidden[^>]*>Workspace</);
  assert.match(html, /aria-label="Back to settings"/);
  assert.match(html, /lg:hidden/);
  assert.doesNotMatch(html, />Header actions</);
  assert.doesNotMatch(html, /Copy task ID/);
  assert.match(html, /border-b border-\[#e8edf7\] bg-white\/72 px-4 py-3/);
  assert.doesNotMatch(html, /px-5 py-5 md:px-8/);
}

testFilesHeaderDoesNotRenderTaskScopedActions();

console.log("files page tests passed");
