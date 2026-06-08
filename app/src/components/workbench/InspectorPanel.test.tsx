import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

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

function testInspectorPanelUsesSolidWorkbenchSurfaces() {
  const source = readFileSync(new URL("./InspectorPanel.tsx", import.meta.url), "utf8");

  assert.match(source, /WORKBENCH_TOP_BAR_CLASS/);
  assert.match(source, /WORKBENCH_ICON_BUTTON_CLASS/);
  assert.doesNotMatch(source, /backdrop-blur-xl/);
  assert.doesNotMatch(source, /backdrop-blur-2xl/);
  assert.doesNotMatch(source, /bg-white\/86/);
}

testInspectorPanelUsesSolidWorkbenchSurfaces();

console.log("inspector panel tests passed");
