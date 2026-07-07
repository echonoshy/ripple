import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "@/i18n";
import InspectorPanel from "./InspectorPanel";

function noop() {}

function testInspectorPanelPassesPendingOpenFileRequestToExplorer() {
  const source = readFileSync(new URL("./InspectorPanel.tsx", import.meta.url), "utf8");
  const html = renderToStaticMarkup(
    <InspectorPanel
      userId="default"
      refreshToken={0}
      openFileRequest={{ id: 1, path: "/workspace/meeting_record/通用会议16.json" }}
      onOpenFileRequestConsumed={noop}
    />
  );

  assert.match(source, /openFileRequest\?: WorkspaceFileOpenRequest \| null/);
  assert.match(source, /openFileRequest=\{openFileRequest\}/);
  assert.match(html, /data-ripple-workspace-explorer="finder-window"/);
}

testInspectorPanelPassesPendingOpenFileRequestToExplorer();

function testInspectorPanelProvidesFileAndBrowserTabs() {
  const source = readFileSync(new URL("./InspectorPanel.tsx", import.meta.url), "utf8");
  const html = renderToStaticMarkup(
    <I18nProvider initialPreference="en-US">
      <InspectorPanel userId="default" refreshToken={0} onBrowserContextChange={noop} />
    </I18nProvider>
  );

  assert.match(source, /activeTab/);
  assert.match(source, /BrowserPanel/);
  assert.match(source, /onBrowserContextChange/);
  assert.match(html, /role="tablist"/);
  assert.match(html, />Files</);
  assert.match(html, />Browser</);
}

testInspectorPanelProvidesFileAndBrowserTabs();

function testInspectorPanelUsesSolidWorkbenchSurfaces() {
  const source = readFileSync(new URL("./InspectorPanel.tsx", import.meta.url), "utf8");
  const html = renderToStaticMarkup(
    <I18nProvider initialPreference="en-US">
      <InspectorPanel userId="default" refreshToken={0} />
    </I18nProvider>
  );
  const collapseButton = html.match(/<button[^>]*aria-label="Collapse panel"[^>]*>/)?.[0] || "";

  assert.match(source, /WORKBENCH_TOP_BAR_CLASS/);
  assert.match(source, /WORKBENCH_ICON_BUTTON_CLASS/);
  assert.match(collapseButton, /border-\[#DEE0E3\]/);
  assert.doesNotMatch(collapseButton, /border-transparent/);
  assert.doesNotMatch(source, /backdrop-blur-xl/);
  assert.doesNotMatch(source, /backdrop-blur-2xl/);
  assert.doesNotMatch(source, /bg-white\/86/);
}

testInspectorPanelUsesSolidWorkbenchSurfaces();

console.log("inspector panel tests passed");
