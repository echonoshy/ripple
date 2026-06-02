import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider, type LocalePreference } from "@/i18n";
import WorkspaceExplorer, {
  displayError,
  getBoundedSplitPercent,
  getSplitPercentFromVerticalResize,
  getWorkspacePreviewKind,
  getWorkspaceParentPath,
  getSplitPercentAfterFileDoubleClick,
} from "./WorkspaceExplorer";

function renderExplorer(
  overrides: Partial<React.ComponentProps<typeof WorkspaceExplorer>> = {},
  locale: LocalePreference = "en-US"
) {
  const props = {
    userId: "test-user",
    refreshToken: 0,
    ...overrides,
  };
  return renderToStaticMarkup(
    <I18nProvider initialPreference={locale}>
      <WorkspaceExplorer {...props} />
    </I18nProvider>
  );
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
  assert.doesNotMatch(html, /rounded-\[22px\]/);
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
  assert.match(html, /bg-\[#007aff\]/);
  assert.match(html, /text-white/);
  assert.doesNotMatch(html, /Back to settings/);
}

testWorkspaceExplorerBackButtonNamesSessionReturn();

function testWorkspaceExplorerPageOmitsProjectControls() {
  const html = renderExplorer({ presentation: "page" });

  assert.doesNotMatch(html, /data-ripple-files-project-switcher/);
  assert.doesNotMatch(html, /aria-label="Select project"/);
  assert.doesNotMatch(html, /data-ripple-files-action="create-project"/);
  assert.doesNotMatch(html, /aria-label="Set current folder as project"/);
}

testWorkspaceExplorerPageOmitsProjectControls();

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

function testWorkspaceExplorerMobileParentFolderButtonUsesIconOnly() {
  const html = renderExplorer({
    presentation: "page",
    testInitialListing: {
      path: "/workspace/novel",
      parent_path: "/workspace",
      entries: [],
    },
  });

  const parentButton = html.match(
    /<button[^>]*data-ripple-files-action="parent-folder"[^>]*>[\s\S]*?<\/button>/
  )?.[0];

  assert.ok(parentButton);
  assert.match(parentButton, /aria-label="Go to parent folder"/);
  assert.match(parentButton, /title="Go to parent folder"/);
  assert.match(parentButton, /lucide-folder-up/);
  assert.doesNotMatch(parentButton, />Up</);
}

testWorkspaceExplorerMobileParentFolderButtonUsesIconOnly();

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
  assert.match(parentButton, /border-\[#d7e3f8\]/);
  assert.match(parentButton, /bg-\[#eef4ff\]/);
  assert.match(parentButton, /text-\[#007aff\]/);
  assert.match(uploadButton, /border-\[#d7d7dd\]/);
  assert.match(uploadButton, /bg-white\/82/);
  assert.doesNotMatch(uploadButton, /bg-\[#007aff\]/);
}

testWorkspaceExplorerPageKeepsMobileUploadSeparateFromParentFolder();

function testWorkspaceExplorerUsesSharedDenseToolbarButtons() {
  const source = readFileSync(new URL("./WorkspaceExplorer.tsx", import.meta.url), "utf8");

  assert.match(source, /DENSE_GLASS_ICON_BUTTON_CLASS/);
  assert.doesNotMatch(source, /const pageToolbarIconButtonClass =\s*\n\s*"inline-flex h-9 w-9/);
}

testWorkspaceExplorerUsesSharedDenseToolbarButtons();

function testWorkspaceExplorerDesktopDirectoryNavigationUsesSharedGlassButtons() {
  const source = readFileSync(new URL("./WorkspaceExplorer.tsx", import.meta.url), "utf8");

  assert.match(source, /const directoryNavigationButtonClass =\s*\n\s*"group inline-flex h-8/);
  assert.match(source, /const directoryNavigationIconClass =\s*\n\s*"flex h-5 w-5/);
  assert.match(source, /className=\{directoryNavigationButtonClass\}[\s\S]*?<ArrowUp size=\{12\}/);
  assert.match(source, /className=\{directoryNavigationButtonClass\}[\s\S]*?<Folder size=\{12\}/);
}

testWorkspaceExplorerDesktopDirectoryNavigationUsesSharedGlassButtons();

function testWorkspaceExplorerCompactDirectoryNavigationOffersParentAndRootControls() {
  const html = renderExplorer({
    testInitialListing: {
      path: "/workspace/scripts",
      parent_path: "/workspace",
      entries: [],
    },
  });

  assert.match(html, /data-ripple-files-action="parent-folder"/);
  assert.match(html, /aria-label="Go to parent folder"/);
  assert.match(html, />Up</);
  assert.match(html, /data-ripple-files-action="root-folder"/);
  assert.match(html, /aria-label="Go to workspace root"/);
  assert.match(html, />Root</);
}

testWorkspaceExplorerCompactDirectoryNavigationOffersParentAndRootControls();

function testWorkspaceExplorerMobileSearchSheetKeepsSearchAndFiltersTogether() {
  const source = readFileSync(new URL("./WorkspaceExplorer.tsx", import.meta.url), "utf8");
  const sheetIndex = source.indexOf("data-ripple-files-mobile-search-sheet");

  assert.ok(sheetIndex >= 0);
  assert.match(source, /data-ripple-files-mobile-search-trigger/);
  assert.match(source, /data-ripple-files-mobile-actions-menu/);

  const afterSheetIndex = source.indexOf("{error &&", sheetIndex);
  assert.ok(afterSheetIndex > sheetIndex);

  const sheetSource = source.slice(sheetIndex, afterSheetIndex);
  assert.match(sheetSource, /aria-label=\{t\("files\.searchWorkspaceFiles"\)\}/);
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
  assert.match(source, /aria-label=\{t\("files\.moreActionsFor"/);
}

testWorkspaceExplorerSourceSupportsDropUploadAndFileDownload();

function testWorkspaceExplorerClassifiesReadOnlyDocumentPreviewFormats() {
  assert.equal(
    getWorkspacePreviewKind({
      name: "report.pdf",
      mime_type: "application/pdf",
    }),
    "pdf"
  );
  assert.equal(
    getWorkspacePreviewKind({
      name: "slides.pptx",
      mime_type: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    }),
    "document"
  );
  assert.equal(
    getWorkspacePreviewKind({
      name: "sheet.xlsx",
      mime_type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    }),
    "document"
  );
  assert.equal(
    getWorkspacePreviewKind({
      name: "notes.txt",
      mime_type: "text/plain",
    }),
    "text"
  );
}

testWorkspaceExplorerClassifiesReadOnlyDocumentPreviewFormats();

function testWorkspaceExplorerRendersDocumentPreviewWithPdfJsRenderer() {
  const source = readFileSync(new URL("./WorkspaceExplorer.tsx", import.meta.url), "utf8");

  assert.match(source, /import \{ PdfPreview \} from "\.\/PdfPreview"/);
  assert.match(source, /fetchWorkspaceDocumentPreview/);
  assert.match(source, /documentPreview/);
  assert.match(source, /data-ripple-workspace-document-preview/);
  assert.match(source, /<PdfPreview/);
  assert.doesNotMatch(source, /<iframe/);
  assert.doesNotMatch(source, /getDocumentPreviewFrameUrl/);
  assert.doesNotMatch(source, /setIsEditing\(.*documentPreview/);
}

testWorkspaceExplorerRendersDocumentPreviewWithPdfJsRenderer();

function testWorkspaceExplorerPassesDocumentBlobToPdfPreview() {
  const source = readFileSync(new URL("./WorkspaceExplorer.tsx", import.meta.url), "utf8");

  assert.match(source, /setDocumentPreview\(\{\s*blob:\s*documentPreview\.blob/);
  assert.match(source, /filename:\s*documentPreview\.filename/);
  assert.match(source, /blob=\{documentPreview\.blob\}/);
  assert.match(source, /filename=\{documentPreview\.filename\}/);
}

testWorkspaceExplorerPassesDocumentBlobToPdfPreview();

function testWorkspaceExplorerDocumentPreviewFillsAvailableHeight() {
  const source = readFileSync(new URL("./WorkspaceExplorer.tsx", import.meta.url), "utf8");

  assert.doesNotMatch(source, /className="flex min-h-full flex-col"/);
  assert.match(source, /className="flex h-full min-h-0 flex-col"/);
  assert.match(
    source,
    /data-ripple-workspace-document-preview[\s\S]*"min-h-0 flex-1 overflow-hidden/
  );
  assert.match(source, /<PdfPreview[\s\S]*className="h-full min-h-0"/);
}

testWorkspaceExplorerDocumentPreviewFillsAvailableHeight();

function testWorkspaceExplorerPreviewSupportsFullscreenOpenAndClose() {
  const source = readFileSync(new URL("./WorkspaceExplorer.tsx", import.meta.url), "utf8");
  const html = renderExplorer({
    presentation: "page",
    testInitialPreview: {
      path: "/workspace/reports/quarterly.pdf",
      name: "quarterly.pdf",
      size_bytes: 123,
      modified_at: "2026-05-17T00:00:00Z",
      mime_type: "application/pdf",
      encoding: "utf-8",
      content: "",
      truncated: false,
    },
  });

  assert.match(source, /Maximize2/);
  assert.match(source, /isPreviewFullscreenOpen/);
  assert.match(source, /setIsPreviewFullscreenOpen\(true\)/);
  assert.match(source, /setIsPreviewFullscreenOpen\(false\)/);
  assert.match(source, /event\.key === "Escape"/);
  assert.match(source, /data-ripple-workspace-preview-fullscreen/);
  assert.match(html, /aria-label="Open fullscreen preview"/);
}

testWorkspaceExplorerPreviewSupportsFullscreenOpenAndClose();

function testWorkspaceExplorerMobilePreviewChromeIsCompact() {
  const source = readFileSync(new URL("./WorkspaceExplorer.tsx", import.meta.url), "utf8");
  const html = renderExplorer({
    presentation: "page",
    testInitialPreview: {
      path: "/workspace/reports/quarterly.pdf",
      name: "quarterly.pdf",
      size_bytes: 123,
      modified_at: "2026-05-17T00:00:00Z",
      mime_type: "application/pdf",
      encoding: "utf-8",
      content: "",
      truncated: false,
    },
  });

  assert.match(source, /data-ripple-workspace-preview-title-path/);
  assert.doesNotMatch(source, /data-ripple-workspace-preview-action="download"/);
  assert.match(source, /data-ripple-workspace-preview-metadata/);
  assert.match(
    source,
    /data-ripple-workspace-preview-title-path[\s\S]*className="[^"]*hidden[^"]*sm:block/
  );
  assert.match(
    source,
    /data-ripple-workspace-preview-metadata[\s\S]*"hidden flex-wrap items-center gap-2 [^"]* sm:flex"/
  );
  assert.match(source, /min-h-\[40px\]/);
  assert.match(source, /sm:min-h-\[68px\]/);
  assert.match(source, /text-\[12px\][^"]*sm:text-\[14px\]/);
  assert.match(source, /size=\{isPagePresentation \? "sm" : "md"\}/);
  assert.match(html, /data-ripple-workspace-preview-title-path/);
  assert.doesNotMatch(html, /data-ripple-workspace-preview-action="download"/);
  assert.match(html, /data-ripple-workspace-preview-metadata/);
}

testWorkspaceExplorerMobilePreviewChromeIsCompact();

function testWorkspaceExplorerPagePreviewSupportsMobileVerticalResize() {
  const source = readFileSync(new URL("./WorkspaceExplorer.tsx", import.meta.url), "utf8");
  const html = renderExplorer({
    presentation: "page",
    testInitialPreview: {
      path: "/workspace/reports/quarterly.pdf",
      name: "quarterly.pdf",
      size_bytes: 123,
      modified_at: "2026-05-17T00:00:00Z",
      mime_type: "application/pdf",
      encoding: "utf-8",
      content: "",
      truncated: false,
    },
  });

  assert.match(source, /--ripple-workspace-list-row/);
  assert.match(source, /grid-rows-\[var\(--ripple-workspace-list-row\)\]/);
  assert.match(source, /lg:grid-rows-none/);
  assert.match(source, /isPagePresentation[\s\S]*\?[\s\S]*"[^"]*lg:hidden/);
  assert.match(html, /data-ripple-workspace-preview-resize/);
}

testWorkspaceExplorerPagePreviewSupportsMobileVerticalResize();

function testWorkspaceExplorerTouchPreviewClicksAvoidDragInterference() {
  const source = readFileSync(new URL("./WorkspaceExplorer.tsx", import.meta.url), "utf8");

  assert.match(source, /function initialIsCoarsePointer/);
  assert.match(source, /matchMedia\("\(pointer: coarse\)"\)/);
  assert.match(source, /const \[isCoarsePointer, setIsCoarsePointer\]/);
  assert.match(source, /draggable=\{!isCoarsePointer\}/);
  assert.match(source, /if \(isCoarsePointer\) \{/);
  assert.match(source, /event\.preventDefault\(\)/);
}

testWorkspaceExplorerTouchPreviewClicksAvoidDragInterference();

function testWorkspaceExplorerPreviewRequestsIgnoreStaleResults() {
  const source = readFileSync(new URL("./WorkspaceExplorer.tsx", import.meta.url), "utf8");

  assert.match(source, /previewRequestIdRef/);
  assert.match(source, /const requestId = previewRequestIdRef\.current \+ 1/);
  assert.match(source, /previewRequestIdRef\.current = requestId/);
  assert.match(source, /if \(previewRequestIdRef\.current !== requestId\) return/);
}

testWorkspaceExplorerPreviewRequestsIgnoreStaleResults();

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

function testWorkspaceExplorerCalculatesVerticalPreviewResizeFromPointer() {
  assert.equal(
    getSplitPercentFromVerticalResize({
      containerTop: 100,
      containerHeight: 500,
      pointerY: 250,
    }),
    30
  );
  assert.equal(
    getSplitPercentFromVerticalResize({
      containerTop: 100,
      containerHeight: 500,
      pointerY: 25,
    }),
    0
  );
  assert.equal(
    getSplitPercentFromVerticalResize({
      containerTop: 100,
      containerHeight: 500,
      pointerY: 700,
    }),
    100
  );
}

testWorkspaceExplorerCalculatesVerticalPreviewResizeFromPointer();

function testWorkspaceExplorerExposesPreviewResizeHandle() {
  const html = renderExplorer({
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

  assert.match(html, /aria-label="Resize preview panel"/);
  assert.match(html, /aria-orientation="horizontal"/);
  assert.match(html, /data-ripple-workspace-preview-resize/);
}

testWorkspaceExplorerExposesPreviewResizeHandle();

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
  assert.match(source, /placeholder=\{t\("files\.findFilesByName"\)\}/);
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

function testWorkspaceLinkOpenLoadsParentDirectoryBeforePreview() {
  const source = readFileSync(new URL("./WorkspaceExplorer.tsx", import.meta.url), "utf8");

  assert.equal(
    getWorkspaceParentPath("/workspace/meeting_record/通用会议16.json"),
    "/workspace/meeting_record"
  );
  assert.equal(getWorkspaceParentPath("/workspace/summary.md"), "/workspace");
  assert.match(source, /await loadDirectory\(getWorkspaceParentPath\(targetPath\)\)/);
}

testWorkspaceLinkOpenLoadsParentDirectoryBeforePreview();

function testWorkspaceExplorerOpensPendingFileRequestAfterMount() {
  const source = readFileSync(new URL("./WorkspaceExplorer.tsx", import.meta.url), "utf8");

  assert.match(source, /openFileRequest\?: WorkspaceFileOpenRequest \| null/);
  assert.match(source, /openFileRequest\.id/);
  assert.match(
    source,
    /openWorkspaceFilePath\(openFileRequest\.path, openFileRequest\.lineNumber\)/
  );
  assert.doesNotMatch(source, /window\.addEventListener\("open-workspace-file"/);
}

testWorkspaceExplorerOpensPendingFileRequestAfterMount();

function testWorkspaceExplorerConsumesPendingFileRequestAfterPreviewOpenSettles() {
  const source = readFileSync(new URL("./WorkspaceExplorer.tsx", import.meta.url), "utf8");

  assert.match(
    source,
    /await openWorkspaceFilePath\(openFileRequest\.path, openFileRequest\.lineNumber\)[\s\S]*onOpenFileRequestConsumed\?\.\(openFileRequest\.id\)/
  );
  assert.doesNotMatch(
    source,
    /openFileRequest\.userId[\s\S]*onOpenFileRequestConsumed\?\.\(openFileRequest\.id\)[\s\S]*return;/
  );
}

testWorkspaceExplorerConsumesPendingFileRequestAfterPreviewOpenSettles();

function testWorkspaceLinkOpenReopensCollapsedPreviewPanel() {
  const source = readFileSync(new URL("./WorkspaceExplorer.tsx", import.meta.url), "utf8");

  assert.match(source, /setSplitPercent\(\(current\) =>/);
  assert.match(source, /current >= MAX_SPLIT_PERCENT \? DEFAULT_SPLIT_PERCENT : current/);
}

testWorkspaceLinkOpenReopensCollapsedPreviewPanel();

function testWorkspaceFileClickReopensCollapsedPreviewPanel() {
  const source = readFileSync(new URL("./WorkspaceExplorer.tsx", import.meta.url), "utf8");
  const openEntryStart = source.indexOf("const openEntry = async");
  const startRenameStart = source.indexOf("const startRename =", openEntryStart);

  assert.ok(openEntryStart >= 0);
  assert.ok(startRenameStart > openEntryStart);

  const openEntrySource = source.slice(openEntryStart, startRenameStart);
  assert.match(
    openEntrySource,
    /setSplitPercent\(\(current\) =>\s*getSplitPercentAfterFileDoubleClick\(current\)\s*\)/
  );
}

testWorkspaceFileClickReopensCollapsedPreviewPanel();

function testWorkspaceFileActionsStayVisibleOnTouchScreens() {
  const source = readFileSync(new URL("./WorkspaceExplorer.tsx", import.meta.url), "utf8");

  assert.match(source, /opacity-100/);
  assert.match(source, /sm:opacity-0/);
  assert.match(source, /sm:group-hover:opacity-100/);
}

testWorkspaceFileActionsStayVisibleOnTouchScreens();

function testWorkspaceExplorerSupportsMultiSelectionBatchActions() {
  const source = readFileSync(new URL("./WorkspaceExplorer.tsx", import.meta.url), "utf8");
  const html = renderExplorer({
    presentation: "page",
    testInitialListing: {
      path: "/workspace",
      parent_path: null,
      entries: [
        {
          name: "alpha.txt",
          path: "/workspace/alpha.txt",
          kind: "file",
          size_bytes: 10,
          modified_at: "2026-05-17T00:00:00Z",
          is_hidden: false,
          mime_type: "text/plain",
        },
      ],
    },
  });

  assert.doesNotMatch(html, /data-ripple-files-select-entry/);
  assert.match(html, /data-ripple-files-action="toggle-selection"/);
  assert.match(html, /aria-label="Select files"/);
  assert.match(source, /selectedEntryPaths/);
  assert.match(source, /isSelectionMode/);
  assert.match(source, /selectedEntries/);
  assert.match(source, /data-ripple-files-selection-bar/);
  assert.match(source, /t\("files\.selectAll"\)/);
  assert.match(source, /t\("files\.clearSelection"\)/);
  assert.match(source, /handleBatchDelete/);
  assert.match(source, /handleBatchClipboard/);
  assert.match(source, /items:\s*selectedEntries/);
  assert.match(source, /t\("files\.paste"\)/);
  assert.match(source, /clipboard\.items\.length/);
  assert.match(source, /clearClipboard/);
  assert.match(source, /t\("files\.clearClipboard"\)/);
}

testWorkspaceExplorerSupportsMultiSelectionBatchActions();

function testWorkspaceExplorerPageRowsExposeMobileSwipeActions() {
  const source = readFileSync(new URL("./WorkspaceExplorer.tsx", import.meta.url), "utf8");
  const html = renderExplorer({
    presentation: "page",
    testInitialListing: {
      path: "/workspace",
      parent_path: null,
      entries: [
        {
          name: "alpha.txt",
          path: "/workspace/alpha.txt",
          kind: "file",
          size_bytes: 10,
          modified_at: "2026-05-17T00:00:00Z",
          is_hidden: false,
          mime_type: "text/plain",
        },
      ],
    },
  });

  assert.match(source, /import SwipeActionRow/);
  assert.match(source, /data-ripple-files-swipe-row/);
  assert.match(source, /trailingActions=\{/);
  assert.match(source, /onSwipeRightCommit=\{/);
  assert.match(source, /toggleEntrySelection\(entry\)/);
  assert.match(source, /startRename\(entry\)/);
  assert.match(source, /handleDelete\(entry\)/);
  assert.match(source, /openWorkspaceContextMenuForEntry/);
  assert.match(html, /data-ripple-swipe-row/);
  assert.match(html, /data-ripple-files-swipe-row/);
  assert.match(html, /aria-disabled="true"/);
  assert.doesNotMatch(html, /data-ripple-swipe-actions/);
  assert.doesNotMatch(html, /aria-label="Delete"/);
}

testWorkspaceExplorerPageRowsExposeMobileSwipeActions();

function testWorkspaceExplorerSupportsDragMoveIntoDirectories() {
  const source = readFileSync(`${process.cwd()}/src/components/WorkspaceExplorer.tsx`, "utf8");
  const html = renderExplorer({
    presentation: "page",
    testInitialListing: {
      path: "/workspace",
      parent_path: null,
      entries: [
        {
          name: "alpha.txt",
          path: "/workspace/alpha.txt",
          kind: "file",
          size_bytes: 10,
          modified_at: "2026-05-17T00:00:00Z",
          is_hidden: false,
          mime_type: "text/plain",
        },
        {
          name: "archive",
          path: "/workspace/archive",
          kind: "directory",
          size_bytes: 0,
          modified_at: "2026-05-17T00:00:00Z",
          is_hidden: false,
          mime_type: null,
        },
      ],
    },
  });

  assert.match(source, /WORKSPACE_DRAG_ENTRY_MIME/);
  assert.match(source, /handleEntryDragStart/);
  assert.match(source, /handleDirectoryDrop/);
  assert.match(source, /canMoveEntriesToDirectory/);
  assert.match(source, /hasDraggedWorkspaceEntries/);
  assert.match(source, /setData\(WORKSPACE_DRAG_ENTRY_MIME/);
  assert.match(source, /pasteWorkspaceEntry\(entry\.path,\s*target\.path,\s*"move"\)/);
  assert.match(source, /target\.path\.startsWith\(`\$\{entry\.path\}\/`\)/);
  assert.match(source, /getWorkspaceParentPath\(entry\.path\) !== target\.path/);
  assert.match(source, /selectedEntryPaths\.has\(entry\.path\) \? selectedEntries : \[entry\]/);
  assert.match(html, /draggable="true"/);
  assert.match(html, /data-ripple-files-drop-target="directory"/);
  assert.doesNotMatch(html, /data-ripple-files-drop-target="file"/);
}

testWorkspaceExplorerSupportsDragMoveIntoDirectories();

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

function testWorkspaceExplorerCompactToolbarOffersCreationActionsFromMoreMenu() {
  const source = readFileSync(new URL("./WorkspaceExplorer.tsx", import.meta.url), "utf8");
  const html = renderExplorer();

  assert.match(html, /data-ripple-files-action="compact-more"/);
  assert.match(html, /aria-label="More file actions"/);
  assert.match(source, /data-ripple-files-compact-actions-menu/);
  assert.match(source, /t\("files\.newFile"\)/);
  assert.match(source, /t\("files\.newFolder"\)/);
}

testWorkspaceExplorerCompactToolbarOffersCreationActionsFromMoreMenu();

function testWorkspaceExplorerRendersChineseChrome() {
  const html = renderExplorer(
    {
      presentation: "page",
      onBack: () => {},
      testInitialListing: {
        path: "/workspace",
        parent_path: null,
        entries: [],
      },
    },
    "zh-CN"
  );

  assert.match(html, />文件</);
  assert.match(html, /aria-label="返回会话"/);
  assert.match(html, /aria-label="搜索工作区文件"/);
  assert.match(html, />工作区为空</);
}

testWorkspaceExplorerRendersChineseChrome();

console.log("workspace explorer tests passed");
