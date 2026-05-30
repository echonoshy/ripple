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

  assert.match(html, /data-ripple-files-page="finder-stage"/);
  assert.match(html, /data-presentation="page"/);
  assert.match(html, /aria-label="Back to session"/);
  assert.match(html, /lg:hidden/);
  assert.match(html, /#fbfdff/);
  assert.doesNotMatch(html, /#ece6dc/);
  assert.doesNotMatch(html, /#faf6ee/);
  assert.doesNotMatch(html, />Header actions</);
  assert.doesNotMatch(html, /Copy task ID/);
  assert.doesNotMatch(html, /sm:hidden[^>]*>Workspace</);
  assert.doesNotMatch(html, /bg-white\/72 px-4 pt-\[max\(env\(safe-area-inset-top\),12px\)\] pb-3/);
  assert.doesNotMatch(html, /px-5 py-5 md:px-8/);
}

testFilesHeaderDoesNotRenderTaskScopedActions();

console.log("files page tests passed");
