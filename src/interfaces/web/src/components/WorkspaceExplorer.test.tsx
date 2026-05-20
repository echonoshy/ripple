import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import WorkspaceExplorer, {
  displayError,
  getBoundedSplitPercent,
  getSplitPercentAfterFileDoubleClick,
} from "./WorkspaceExplorer";

function renderExplorer() {
  return renderToStaticMarkup(<WorkspaceExplorer userId="test-user" refreshToken={0} />);
}

function renderExplorerWithStoredSplitPercent(storedValue: string) {
  const globalWithWindow = globalThis as typeof globalThis & { window?: unknown };
  const previousWindow = globalWithWindow.window;

  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      localStorage: {
        getItem: (key: string) => (key.includes("splitPercent") ? storedValue : null),
        setItem: () => {},
      },
    },
  });

  try {
    return renderExplorer();
  } finally {
    if (previousWindow === undefined) {
      Reflect.deleteProperty(globalWithWindow, "window");
    } else {
      Object.defineProperty(globalThis, "window", {
        configurable: true,
        value: previousWindow,
      });
    }
  }
}

function testWorkspaceExplorerSplitIsResizable() {
  const html = renderExplorer();

  assert.match(html, /grid-template-rows:minmax\(0,48%\) minmax\(0,1fr\)/);
  assert.match(html, /role="separator"/);
  assert.match(html, /aria-label="Resize workspace split"/);
  assert.match(html, /aria-orientation="horizontal"/);
  assert.match(html, /aria-valuemin="0"/);
  assert.match(html, /aria-valuemax="100"/);
  assert.match(html, /aria-valuenow="48"/);
  assert.match(html, /cursor-row-resize/);
  assert.match(html, /aria-label="Collapse preview panel"/);
  assert.doesNotMatch(html, /aria-label="Hide preview panel"/);
  assert.doesNotMatch(html, /title="Hide preview"/);
}

testWorkspaceExplorerSplitIsResizable();

function testWorkspaceExplorerExposesUploadControl() {
  const html = renderExplorer();

  assert.match(html, /aria-label="Upload files"/);
  assert.match(html, /title="Upload files"/);
  assert.match(html, /type="file"/);
  assert.match(html, /multiple/);
}

testWorkspaceExplorerExposesUploadControl();

function testWorkspaceExplorerSourceSupportsDropUploadAndFileDownload() {
  const source = readFileSync(new URL("./WorkspaceExplorer.tsx", import.meta.url), "utf8");

  assert.match(source, /onDrop/);
  assert.match(source, /onDragOver/);
  assert.match(source, /downloadWorkspaceFile/);
  assert.match(source, /aria-label=\{`Download \$\{entry\.name\}`\}/);
}

testWorkspaceExplorerSourceSupportsDropUploadAndFileDownload();

function testWorkspaceExplorerSplitStaysInsidePanelBounds() {
  const html = renderExplorerWithStoredSplitPercent("120");

  assert.match(html, /grid-template-rows:minmax\(0,1fr\) 0px/);
  assert.match(html, /aria-label="Show preview panel"/);
  assert.doesNotMatch(html, /aria-label="Resize workspace split"/);
  assert.doesNotMatch(html, /Select a text file/);
}

testWorkspaceExplorerSplitStaysInsidePanelBounds();

function testWorkspaceExplorerSplitAllowsFullHideOnlyWithinBounds() {
  assert.equal(getBoundedSplitPercent(120), 100);
  assert.equal(getBoundedSplitPercent(100), 100);
  assert.equal(getBoundedSplitPercent(-20), 0);
}

testWorkspaceExplorerSplitAllowsFullHideOnlyWithinBounds();

function testDoubleClickingFileRestoresOnlyHiddenPreviewPanel() {
  assert.equal(getSplitPercentAfterFileDoubleClick(100), 48);
  assert.equal(getSplitPercentAfterFileDoubleClick(64), 64);
}

testDoubleClickingFileRestoresOnlyHiddenPreviewPanel();

function testPreviewModeButtonIsRemoved() {
  const source = readFileSync(new URL("./WorkspaceExplorer.tsx", import.meta.url), "utf8");

  assert.doesNotMatch(source, /title="Preview"/);
  assert.doesNotMatch(source, />\s*Preview\s*</);
}

testPreviewModeButtonIsRemoved();

function testWorkspaceNetworkErrorIsActionable() {
  assert.equal(
    displayError("Failed to fetch"),
    "无法连接到 Ripple 服务。请确认后端服务正在运行，或检查 /v1 代理配置。"
  );
}

testWorkspaceNetworkErrorIsActionable();

function testWorkspaceSearchDefaultsToNameAndShowsMatchSource() {
  const source = readFileSync(new URL("./WorkspaceExplorer.tsx", import.meta.url), "utf8");

  assert.match(source, /useState<NonNullable<WorkspaceSearchOptions\["scope"\]>>\(\s*"name"\s*\)/);
  assert.match(source, /placeholder="Find files by name\.\.\."/);
  assert.match(source, /searchMatchLabel/);
}

testWorkspaceSearchDefaultsToNameAndShowsMatchSource();

function testWorkspaceExplorerCachesListingsAndAvoidsCurrentPathReloadEffect() {
  const source = readFileSync(new URL("./WorkspaceExplorer.tsx", import.meta.url), "utf8");

  assert.match(source, /workspaceListingCache/);
  assert.match(source, /workspaceLastPathCache/);
  assert.doesNotMatch(source, /\[currentPath,\s*loadDirectory,\s*refreshToken\]/);
}

testWorkspaceExplorerCachesListingsAndAvoidsCurrentPathReloadEffect();

console.log("workspace explorer tests passed");
