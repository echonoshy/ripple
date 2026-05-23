import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import FilesPage from "./FilesPage";

function renderFilesPage() {
  return renderToStaticMarkup(<FilesPage userId="default" refreshToken={0} />);
}

function testFilesHeaderDoesNotRenderTaskScopedActions() {
  const html = renderFilesPage();

  assert.match(html, />Files</);
  assert.match(html, /sm:hidden[^>]*>Workspace</);
  assert.match(html, /hidden sm:inline[^>]*>\/workspace</);
  assert.doesNotMatch(html, />Header actions</);
  assert.doesNotMatch(html, /Copy task ID/);
  assert.match(html, /border-b border-\[#e5e7eb\] bg-white px-4 py-3 md:px-5/);
  assert.doesNotMatch(html, /px-5 py-5 md:px-8/);
}

testFilesHeaderDoesNotRenderTaskScopedActions();

console.log("files page tests passed");
