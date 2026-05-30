import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import WorkspaceExplorer, {
  displayError,
  getBoundedSplitPercent,
  getSplitPercentAfterFileDoubleClick,
} from "./WorkspaceExplorer";

function renderExplorer(overrides: Partial<React.ComponentProps<typeof WorkspaceExplorer>> = {}) {
  const props = {
    userId: "test-user",
    refreshToken: 0,
    ...overrides,
  };
  return renderToStaticMarkup(<WorkspaceExplorer {...props} />);
}

function renderExplorerWithStoredSplitPercent(
  storedValue: string,
  overrides: Partial<React.ComponentProps<typeof WorkspaceExplorer>> = {}
) {
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
    return renderExplorer(overrides);
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

function testWorkspaceExplorerUsesFinderThreePaneLayout() {
  const html = renderExplorer({
    presentation: "page",
    testInitialPreview: {
      path: "/workspace/notes.txt",
      name: "notes.txt",
      size_bytes: 123,
      modified_at: "2026-05-17T00:00:00Z",
      mime_type: "text/plain",
      encoding: "utf-8",
      content: "test content",
      truncated: false,
    },
  });

  assert.match(html, /data-ripple-workspace-explorer="finder-window"/);
  assert.match(html, /data-ripple-workspace-location="current-path"/);
  assert.match(html, /data-ripple-workspace-file-list="browser"/);
  assert.match(html, /data-ripple-workspace-preview="preview"/);
  assert.match(html, /lg:grid-cols-\[210px_minmax\(260px,330px\)_minmax\(0,1fr\)\]/);
  assert.match(html, /aria-label="Search workspace files"/);
  assert.match(html, /aria-label="Collapse preview panel"/);
  assert.doesNotMatch(html, /#ec6a5e/);
  assert.doesNotMatch(html, /#f5bf4f/);
  assert.doesNotMatch(html, /#61c554/);
  assert.doesNotMatch(html, /aria-hidden="true"><span class="h-3 w-3 rounded-full/);
  assert.doesNotMatch(html, /aria-label="Hide preview panel"/);
  assert.doesNotMatch(html, /title="Hide preview"/);
}

testWorkspaceExplorerUsesFinderThreePaneLayout();

function testWorkspaceExplorerPageStacksHeaderControlsAwayFromTitle() {
  const html = renderExplorer({ presentation: "page" });

  assert.match(html, /data-ripple-files-toolbar-layout="stacked"/);
  assert.match(html, /data-ripple-files-title-row="page"/);
  assert.match(html, /data-ripple-files-search-row="page"/);
  assert.match(html, /data-ripple-files-mobile-search-trigger/);
  assert.match(html, /data-ripple-workspace-current-path="toolbar"[^>]*lg:hidden/);

  const pageSearchRow = html.match(/<div[^>]*data-ripple-files-search-row="page"[^>]*>/)?.[0];
  assert.ok(pageSearchRow);
  assert.match(pageSearchRow, /hidden/);
  assert.match(pageSearchRow, /lg:flex/);
}

testWorkspaceExplorerPageStacksHeaderControlsAwayFromTitle();

function testWorkspaceExplorerBackButtonNamesSessionReturn() {
  const source = readFileSync(new URL("./WorkspaceExplorer.tsx", import.meta.url), "utf8");
  const html = renderExplorer({ presentation: "page", onBack: () => {} });

  assert.match(source, /MessageCircleReply/);
  assert.match(html, /aria-label="Back to session"/);
  assert.match(html, /title="Back to session"/);
  assert.match(html, /bg-\[#2f6bff\]/);
  assert.match(html, /text-white/);
  assert.doesNotMatch(html, /Back to settings/);
}

testWorkspaceExplorerBackButtonNamesSessionReturn();

function testWorkspaceExplorerPageShowsProjectControls() {
  const html = renderExplorer({
    presentation: "page",
    projects: [
      {
        projectId: "prj-demo",
        name: "Demo",
        rootPath: "/workspace/demo",
        createdAt: "2026-05-30T00:00:00Z",
        updatedAt: "2026-05-30T00:00:00Z",
        lastActiveAt: "2026-05-30T00:00:00Z",
        exists: true,
      },
    ],
    activeProjectId: "prj-demo",
    onCreateProject: async () => null,
  });

  assert.match(html, /data-ripple-files-project-switcher/);
  assert.match(html, /aria-label="Select project"/);
  assert.match(html, /Demo/);
  assert.match(html, /data-ripple-files-action="create-project"/);
  assert.match(html, /aria-label="Set current folder as project"/);
}

testWorkspaceExplorerPageShowsProjectControls();

function testWorkspaceExplorerPageShowsMobileParentFolderControl() {
  const html = renderExplorer({
    presentation: "page",
    testInitialListing: {
      path: "/workspace/novel",
      parent_path: "/workspace",
      entries: [],
    },
  });

  assert.match(html, /data-ripple-files-mobile-path-row/);
  assert.match(html, /data-ripple-files-action="parent-folder"/);
  assert.match(html, /aria-label="Go to parent folder"/);
  assert.match(
    html,
    /data-ripple-files-mobile-path-row[\s\S]*data-ripple-files-action="parent-folder"/
  );
}

testWorkspaceExplorerPageShowsMobileParentFolderControl();

function testWorkspaceExplorerPageKeepsMobileUploadSeparateFromParentFolder() {
  const html = renderExplorer({
    presentation: "page",
    testInitialListing: {
      path: "/workspace/novel",
      parent_path: "/workspace",
      entries: [],
    },
  });

  const parentButton = html.match(
    /<button[^>]*data-ripple-files-action="parent-folder"[^>]*>/
  )?.[0];
  const uploadButton = html.match(/<button[^>]*data-ripple-files-action="upload"[^>]*>/)?.[0];

  assert.ok(parentButton);
  assert.ok(uploadButton);
  assert.match(parentButton, /border-\[#dfe6f4\]/);
  assert.match(parentButton, /bg-white\/78/);
  assert.match(uploadButton, /border-\[#dfe6f4\]/);
  assert.match(uploadButton, /bg-white\/78/);
  assert.doesNotMatch(uploadButton, /bg-\[#2463eb\]/);
}

testWorkspaceExplorerPageKeepsMobileUploadSeparateFromParentFolder();

function testWorkspaceExplorerMobileSearchSheetKeepsSearchAndFiltersTogether() {
  const source = readFileSync(new URL("./WorkspaceExplorer.tsx", import.meta.url), "utf8");
  const sheetIndex = source.indexOf("data-ripple-files-mobile-search-sheet");

  assert.ok(sheetIndex >= 0);
  assert.match(source, /data-ripple-files-mobile-search-trigger/);
  assert.match(source, /data-ripple-files-mobile-actions-menu/);

  const afterSheetIndex = source.indexOf("{error &&", sheetIndex);
  assert.ok(afterSheetIndex > sheetIndex);

  const sheetSource = source.slice(sheetIndex, afterSheetIndex);
  assert.match(sheetSource, /aria-label="Search workspace files"/);
  assert.match(sheetSource, /value=\{searchScope\}/);
  assert.match(sheetSource, /value=\{searchKind\}/);
  assert.match(sheetSource, /value=\{fileType\}/);
  assert.match(sheetSource, /value=\{searchLimit\}/);
}

testWorkspaceExplorerMobileSearchSheetKeepsSearchAndFiltersTogether();

function testWorkspaceExplorerPageMergesRepeatedLocationLabels() {
  const html = renderExplorer({ presentation: "page" });

  assert.match(html, /data-ripple-workspace-location="current-path"/);
  assert.match(html, /data-ripple-workspace-location="current-path"[^>]*hidden/);
  assert.doesNotMatch(html, /grid-rows-\[auto_/);
  assert.doesNotMatch(html, />Workspace<\/div>/);
  assert.doesNotMatch(html, />Workspace<\/span>/);
  assert.doesNotMatch(html, />Current<\/div>/);
  assert.doesNotMatch(html, />Name<\/div>/);
  assert.doesNotMatch(html, /data-ripple-workspace-file-list-path=/);
}

testWorkspaceExplorerPageMergesRepeatedLocationLabels();

function testWorkspaceExplorerDefaultsToCompactPanelLayout() {
  const html = renderExplorer();

  assert.match(html, /data-presentation="compact"/);
  assert.doesNotMatch(html, /data-ripple-workspace-sidebar="places"/);
  assert.doesNotMatch(html, /lg:grid-cols-\[210px_minmax\(260px,330px\)_minmax\(0,1fr\)\]/);
  assert.doesNotMatch(html, /rounded-\[22px\]/);
  assert.doesNotMatch(html, /shadow-\[0_22px_70px/);
  assert.doesNotMatch(html, />Files<\/h1>/);
}

testWorkspaceExplorerDefaultsToCompactPanelLayout();

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
  assert.match(source, /getWorkspaceImagePreviewUrl/);
  assert.match(source, /aria-label=\{`More actions for \$\{entry\.name\}`\}/);
}

testWorkspaceExplorerSourceSupportsDropUploadAndFileDownload();

function testWorkspaceExplorerSplitStaysInsidePanelBounds() {
  const html = renderExplorerWithStoredSplitPercent("120", {
    testInitialPreview: {
      path: "/workspace/notes.txt",
      name: "notes.txt",
      size_bytes: 123,
      modified_at: "2026-05-17T00:00:00Z",
      mime_type: "text/plain",
      encoding: "utf-8",
      content: "test content",
      truncated: false,
    },
  });

  assert.match(html, /data-preview-state="collapsed"/);
  assert.doesNotMatch(html, /aria-label="Show preview panel"/);
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

function testWorkspaceExplorerDoesNotExposeHiddenFileSearchToggle() {
  const source = readFileSync(new URL("./WorkspaceExplorer.tsx", import.meta.url), "utf8");

  assert.doesNotMatch(source, /Include hidden files/);
  assert.doesNotMatch(source, /setIncludeHidden/);
}

testWorkspaceExplorerDoesNotExposeHiddenFileSearchToggle();

function testWorkspaceExplorerCachesListingsAndAvoidsCurrentPathReloadEffect() {
  const source = readFileSync(new URL("./WorkspaceExplorer.tsx", import.meta.url), "utf8");

  assert.match(source, /workspaceListingCache/);
  assert.match(source, /workspaceLastPathCache/);
  assert.doesNotMatch(source, /\[currentPath,\s*loadDirectory,\s*refreshToken\]/);
}

testWorkspaceExplorerCachesListingsAndAvoidsCurrentPathReloadEffect();

function testWorkspaceFileActionsStayVisibleOnTouchScreens() {
  const source = readFileSync(new URL("./WorkspaceExplorer.tsx", import.meta.url), "utf8");

  assert.match(source, /opacity-100/);
  assert.match(source, /sm:opacity-0/);
  assert.match(source, /sm:group-hover:opacity-100/);
}

testWorkspaceFileActionsStayVisibleOnTouchScreens();

function testWorkspaceContextMenuUsesViewportAwarePositioning() {
  const source = readFileSync(new URL("./WorkspaceExplorer.tsx", import.meta.url), "utf8");

  assert.match(source, /getWorkspaceContextMenuPosition/);
  assert.match(source, /getMeasuredViewportMenuPosition/);
  assert.match(source, /contextMenuRef/);
  assert.match(source, /getBoundingClientRect\(\)\.height/);
  assert.match(source, /useLayoutEffect/);
  assert.doesNotMatch(source, /rect\.bottom \+ 4/);
}

testWorkspaceContextMenuUsesViewportAwarePositioning();

console.log("workspace explorer tests passed");
