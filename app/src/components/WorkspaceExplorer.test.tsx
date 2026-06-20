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
  getWorkspacePathBreadcrumbs,
  getSplitPercentAfterFileDoubleClick,
  shouldDismissWorkspaceContextMenuOnEntryClick,
} from "./WorkspaceExplorer";

function readWorkspaceExplorerImplementationSource(): string {
  return [
    "./WorkspaceExplorer.tsx",
    "./workspace/WorkspaceActionMenus.tsx",
    "./workspace/WorkspaceFileList.tsx",
    "./workspace/WorkspaceTreePanel.tsx",
    "./workspace/WorkspaceToolbar.tsx",
    "./workspace/workspaceExplorerState.ts",
    "./workspace/workspaceExplorerUtils.tsx",
    "./workspace/WorkspaceConfirmDialog.tsx",
    "./workspace/WorkspaceCreateEntryDialog.tsx",
    "./workspace/WorkspacePreviewPanel.tsx",
  ]
    .map((path) => readFileSync(new URL(path, import.meta.url), "utf8"))
    .join("\n");
}

const workspaceExplorerSource = readWorkspaceExplorerImplementationSource();

test("workspace explorer script assertions are registered with Bun", () => {
  assert.match(workspaceExplorerSource, /WorkspaceExplorer/);
});

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

function testWorkspaceExplorerUsesFinderTwoPaneLayoutWithTopPathBar() {
  const longPath = "/workspace/outputs/reports/2026/june/customer-facing/presentation-assets";
  const html = renderExplorer({
    presentation: "page",
    testInitialListing: {
      path: longPath,
      parent_path: "/workspace/outputs/reports/2026/june/customer-facing",
      entries: [],
    },
    testInitialPreview: {
      path: `${longPath}/notes.txt`,
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
  assert.match(html, /data-ripple-files-path-row="page"/);
  assert.match(html, /data-ripple-files-path-row="page"[\s\S]*overflow-x-auto/);
  assert.match(html, /data-ripple-files-path-row="page"[\s\S]*whitespace-nowrap/);
  assert.match(html, new RegExp(longPath.replace(/\//g, "\\/")));
  assert.match(html, /data-ripple-files-action="parent-folder"/);
  assert.match(html, /data-ripple-files-action="root-folder"/);
  assert.match(html, /data-ripple-workspace-file-list="browser"/);
  assert.match(html, /data-ripple-workspace-preview="preview"/);
  assert.doesNotMatch(html, /lg:grid-cols-\[210px_/);
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

testWorkspaceExplorerUsesFinderTwoPaneLayoutWithTopPathBar();

function testWorkspaceExplorerPageShowsLazyDirectoryTree() {
  const source = readWorkspaceExplorerImplementationSource();
  const listing = {
    path: "/workspace",
    parent_path: null,
    entries: [
      {
        name: "clients",
        path: "/workspace/clients",
        kind: "directory" as const,
        size_bytes: 0,
        modified_at: "2026-05-17T00:00:00Z",
        is_hidden: false,
        mime_type: null,
      },
      {
        name: "notes.md",
        path: "/workspace/notes.md",
        kind: "file" as const,
        size_bytes: 42,
        modified_at: "2026-05-17T00:00:00Z",
        is_hidden: false,
        mime_type: "text/markdown",
      },
    ],
  };
  const html = renderExplorer({
    presentation: "page",
    testInitialListing: listing,
  });
  const htmlWithPreview = renderExplorer({
    presentation: "page",
    testInitialListing: listing,
    testInitialPreview: {
      path: "/workspace/notes.md",
      name: "notes.md",
      size_bytes: 42,
      modified_at: "2026-05-17T00:00:00Z",
      mime_type: "text/markdown",
      encoding: "utf-8",
      content: "# Notes",
      truncated: false,
    },
  });

  assert.match(source, /WorkspaceTreePanel/);
  assert.match(source, /treeExpandedPaths/);
  assert.match(source, /seedTreeListing/);
  assert.match(source, /revealWorkspacePathInTree/);
  assert.match(source, /<WorkspaceTreePanel\s+key=\{userId\}/);
  assert.match(html, /data-ripple-workspace-tree="navigation"/);
  assert.ok(html.includes('data-ripple-workspace-tree-entry="/workspace"'));
  assert.ok(html.includes('data-ripple-workspace-tree-entry="/workspace/clients"'));
  assert.match(html, /aria-label="Workspace folders"/);
  assert.match(html, /aria-current="page"/);
  assert.match(html, /lg:grid-cols-\[244px_minmax\(0,1fr\)\]/);
  assert.match(htmlWithPreview, /lg:grid-cols-\[244px_minmax\(0,1fr\)_minmax\(280px,360px\)\]/);
  assert.match(html, /clients/);
  assert.doesNotMatch(html, /data-ripple-workspace-place=/);
}

testWorkspaceExplorerPageShowsLazyDirectoryTree();

function testWorkspaceExplorerPathBreadcrumbsAreClickable() {
  const source = readWorkspaceExplorerImplementationSource();
  const crumbs = getWorkspacePathBreadcrumbs("/workspace/clients/acme/reports");
  const html = renderExplorer({
    presentation: "page",
    testInitialListing: {
      path: "/workspace/clients/acme/reports",
      parent_path: "/workspace/clients/acme",
      entries: [],
    },
  });

  assert.deepEqual(crumbs, [
    { label: "workspace", path: "/workspace", isCurrent: false },
    { label: "clients", path: "/workspace/clients", isCurrent: false },
    { label: "acme", path: "/workspace/clients/acme", isCurrent: false },
    { label: "reports", path: "/workspace/clients/acme/reports", isCurrent: true },
  ]);
  assert.match(source, /getWorkspacePathBreadcrumbs/);
  assert.match(html, /data-ripple-files-breadcrumbs/);
  assert.ok(html.includes('data-ripple-files-breadcrumb="/workspace/clients"'));
  assert.match(html, /data-ripple-files-breadcrumb-current="true"/);
  assert.match(html, /aria-label="Open workspace"/);
  assert.match(html, /aria-current="page"/);
}

testWorkspaceExplorerPathBreadcrumbsAreClickable();

function testWorkspaceExplorerPageStacksHeaderControlsAwayFromTitle() {
  const html = renderExplorer({ presentation: "page" });

  assert.match(html, /data-ripple-files-toolbar-layout="stacked"/);
  assert.match(html, /data-ripple-files-title-row="page"/);
  assert.match(html, /data-ripple-files-mobile-primary-header="true"/);
  assert.match(html, /data-ripple-files-search-row="page"/);
  assert.match(html, /data-ripple-files-mobile-search-trigger/);
  assert.match(workspaceExplorerSource, /TYPOGRAPHY_PAGE_TITLE_CLASS/);
  assert.match(html, /text-\[20px\] leading-\[30px\]/);

  const mobileTitleRow = html.match(/<div[^>]*data-ripple-files-title-row="page"[^>]*>/)?.[0];
  const pageSearchRow = html.match(/<div[^>]*data-ripple-files-search-row="page"[^>]*>/)?.[0];
  assert.ok(mobileTitleRow);
  assert.match(mobileTitleRow, /lg:hidden/);
  assert.match(mobileTitleRow, /py-2/);
  assert.doesNotMatch(mobileTitleRow, /py-3/);
  assert.doesNotMatch(mobileTitleRow, /grid-cols-\[44px_minmax\(0,1fr\)_auto\]/);
  assert.ok(pageSearchRow);
  assert.match(pageSearchRow, /hidden/);
  assert.match(pageSearchRow, /lg:flex/);
}

testWorkspaceExplorerPageStacksHeaderControlsAwayFromTitle();

function testWorkspaceExplorerBackButtonNamesSessionReturn() {
  const source = readWorkspaceExplorerImplementationSource();
  const html = renderExplorer({ presentation: "page", onBack: () => {} });

  assert.match(source, /MobilePageHeader/);
  assert.match(html, /data-ripple-mobile-page-header="true"/);
  assert.match(html, /aria-label="Back to session"/);
  assert.match(html, /title="Back to session"/);
  assert.match(html, /lucide-chevron-left/);
  assert.match(html, /border-\[#DEE0E3\]/);
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
  assert.match(html, /data-ripple-files-mobile-path-row[^>]*mx-3/);
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
  assert.match(parentButton, /h-8/);
  assert.match(parentButton, /w-8/);
  assert.doesNotMatch(parentButton, /h-11/);
  assert.doesNotMatch(parentButton, /w-11/);
  assert.match(parentButton, /border-\[#BACEFD\]/);
  assert.match(parentButton, /bg-\[#F0F5FF\]/);
  assert.match(parentButton, /text-\[#1456F0\]/);
  assert.match(workspaceExplorerSource, /<FolderUp size=\{14\}/);
  assert.match(uploadButton, /h-10/);
  assert.match(uploadButton, /w-10/);
  assert.doesNotMatch(uploadButton, /h-11/);
  assert.doesNotMatch(uploadButton, /w-11/);
  assert.match(uploadButton, /bg-transparent/);
  assert.doesNotMatch(uploadButton, /border-\[#DEE0E3\]/);
  assert.doesNotMatch(uploadButton, /bg-white/);
  assert.doesNotMatch(uploadButton, /border-white\/76/);
  assert.doesNotMatch(uploadButton, /bg-white\/72/);
  assert.doesNotMatch(uploadButton, /bg-\[#1456F0\]/);
}

testWorkspaceExplorerPageKeepsMobileUploadSeparateFromParentFolder();

function testWorkspaceExplorerMobileToolbarUsesCompactHeaderButtons() {
  assert.match(
    workspaceExplorerSource,
    /const filesMobileToolbarButtonClass =\s*"inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-transparent text-\[#2B2F36\]/
  );
  assert.match(workspaceExplorerSource, /WORKBENCH_MOBILE_GHOST_ICON_BUTTON_ACTIVE_CLASS/);
  assert.doesNotMatch(workspaceExplorerSource, /WORKBENCH_MOBILE_ICON_BUTTON_CLASS/);
  assert.doesNotMatch(workspaceExplorerSource, /MOBILE_GLASS_ICON_BUTTON_CLASS/);
  assert.match(workspaceExplorerSource, /LUCIDE_STANDARD_STROKE_WIDTH/);
  assert.match(
    workspaceExplorerSource,
    /data-ripple-files-mobile-search-trigger[\s\S]*className=\{`\$\{filesMobileToolbarButtonClass\}/
  );
  assert.match(
    workspaceExplorerSource,
    /data-ripple-files-action="toggle-selection"[\s\S]*className=\{`\$\{filesMobileToolbarButtonClass\}/
  );
  assert.match(
    workspaceExplorerSource,
    /data-ripple-files-action="upload"[\s\S]*className=\{filesMobileToolbarButtonClass\}/
  );
  assert.match(
    workspaceExplorerSource,
    /data-ripple-files-action="mobile-more"[\s\S]*className=\{filesMobileToolbarButtonClass\}/
  );
  assert.doesNotMatch(
    workspaceExplorerSource,
    /isSearchMode \? "border-\[#BACEFD\] bg-\[#F0F5FF\] text-\[#1456F0\]"/
  );
  assert.doesNotMatch(
    workspaceExplorerSource,
    /isSelectionActive \? "border-\[#BACEFD\] bg-\[#F0F5FF\] text-\[#1456F0\]"/
  );
  assert.match(
    workspaceExplorerSource,
    /<Search size=\{18\} strokeWidth=\{LUCIDE_STANDARD_STROKE_WIDTH\}/
  );
  assert.match(
    workspaceExplorerSource,
    /<SquareCheck size=\{18\} strokeWidth=\{LUCIDE_STANDARD_STROKE_WIDTH\}/
  );
  assert.match(
    workspaceExplorerSource,
    /<Upload size=\{18\} strokeWidth=\{LUCIDE_STANDARD_STROKE_WIDTH\}/
  );
  assert.match(
    workspaceExplorerSource,
    /<MoreHorizontal size=\{18\} strokeWidth=\{LUCIDE_STANDARD_STROKE_WIDTH\}/
  );
}

testWorkspaceExplorerMobileToolbarUsesCompactHeaderButtons();

function testWorkspaceExplorerUsesSharedDenseToolbarButtons() {
  const source = readWorkspaceExplorerImplementationSource();

  assert.match(source, /WORKBENCH_ICON_BUTTON_CLASS/);
  assert.match(source, /const filesToolbarIconButtonBaseClass = WORKBENCH_ICON_BUTTON_CLASS/);
  assert.match(
    source,
    /const filesToolbarIconButtonClass =\s*`\$\{filesToolbarIconButtonBaseClass\}/
  );
  assert.match(
    source,
    /const filesToolbarIconButtonActiveClass =\s*`\$\{filesToolbarIconButtonBaseClass\}/
  );
  assert.doesNotMatch(source, /filesToolbarIconButtonBaseClass =\s*\n\s*"inline-flex h-8 w-8/);
  assert.doesNotMatch(source, /const pageToolbarIconButtonClass/);
}

testWorkspaceExplorerUsesSharedDenseToolbarButtons();

function testWorkspaceExplorerToolbarActionsShareCompactMotion() {
  const searchFiltersIndex = workspaceExplorerSource.indexOf(
    'data-ripple-files-action="search-filters"'
  );
  const toggleSelectionIndex = workspaceExplorerSource.indexOf(
    'data-ripple-files-action="toggle-selection"',
    searchFiltersIndex
  );
  const uploadIndex = workspaceExplorerSource.indexOf(
    'data-ripple-files-action="upload"',
    toggleSelectionIndex
  );

  assert.ok(searchFiltersIndex >= 0);
  assert.ok(toggleSelectionIndex > searchFiltersIndex);
  assert.ok(uploadIndex > toggleSelectionIndex);

  const searchFiltersBlock = workspaceExplorerSource.slice(
    searchFiltersIndex,
    toggleSelectionIndex
  );
  const toggleSelectionBlock = workspaceExplorerSource.slice(toggleSelectionIndex, uploadIndex);

  assert.match(
    searchFiltersBlock,
    /className=\{\s*isFilterOpen \? filesToolbarIconButtonActiveClass : filesToolbarIconButtonClass\s*\}/
  );
  assert.match(
    toggleSelectionBlock,
    /className=\{\s*isSelectionActive \? filesToolbarIconButtonActiveClass : filesToolbarIconButtonClass\s*\}/
  );
  assert.doesNotMatch(searchFiltersBlock, /rounded-full/);
  assert.doesNotMatch(toggleSelectionBlock, /rounded-full/);
  assert.doesNotMatch(searchFiltersBlock, /MOBILE_GLASS_ICON_BUTTON_CLASS/);
  assert.doesNotMatch(toggleSelectionBlock, /MOBILE_GLASS_ICON_BUTTON_CLASS/);
  assert.match(
    workspaceExplorerSource,
    /data-ripple-files-action="upload"[\s\S]*className=\{filesToolbarIconButtonClass\}/
  );
  assert.match(
    workspaceExplorerSource,
    /data-ripple-files-action="compact-more"[\s\S]*className=\{filesToolbarIconButtonClass\}/
  );
  assert.match(
    workspaceExplorerSource,
    /data-ripple-files-action="refresh"[\s\S]*className=\{filesToolbarIconButtonClass\}/
  );
  assert.match(
    workspaceExplorerSource,
    /aria-label=\{t\("files\.refreshWorkspace"\)\}[\s\S]*className=\{filesToolbarIconButtonClass\}/
  );
  assert.doesNotMatch(workspaceExplorerSource, /pageToolbarPrimaryButtonClass/);
  assert.doesNotMatch(
    workspaceExplorerSource,
    /data-ripple-files-action="refresh"[\s\S]{0,220}pageToolbarIconButtonClass/
  );
}

testWorkspaceExplorerToolbarActionsShareCompactMotion();

function testWorkspaceExplorerDesktopDirectoryNavigationUsesSharedWorkbenchButtons() {
  const source = readWorkspaceExplorerImplementationSource();

  assert.match(source, /WORKBENCH_SECONDARY_BUTTON_CLASS/);
  assert.match(
    source,
    /const directoryNavigationButtonClass =\s*`\$\{WORKBENCH_SECONDARY_BUTTON_CLASS\}/
  );
  assert.match(
    source,
    /const directoryNavigationButtonClass =[\s\S]*TYPOGRAPHY_MICRO_MEDIUM_CLASS/
  );
  assert.match(source, /const directoryNavigationIconClass =\s*\n\s*"flex h-5 w-5/);
  assert.match(source, /className=\{directoryNavigationButtonClass\}[\s\S]*?<ArrowUp size=\{12\}/);
  assert.match(
    source,
    /className=\{directoryNavigationButtonClass\}[\s\S]*?<FolderRoot size=\{16\}/
  );
}

testWorkspaceExplorerDesktopDirectoryNavigationUsesSharedWorkbenchButtons();

function testWorkspaceExplorerUsesSolidWorkbenchChrome() {
  const source = readWorkspaceExplorerImplementationSource();

  assert.match(
    source,
    /WORKBENCH_MENU_CLASS|WORKBENCH_SECTION_CLASS|WORKBENCH_SECONDARY_BUTTON_CLASS/
  );
  assert.doesNotMatch(source, /backdrop-blur-xl/);
  assert.doesNotMatch(source, /rounded-\[28px\]/);
  assert.doesNotMatch(source, /shadow-\[0_18px_44px/);
  assert.doesNotMatch(source, /bg-white\/9[246]/);
  assert.doesNotMatch(source, /bg-\[#FFFFFF\]\/76/);
}

testWorkspaceExplorerUsesSolidWorkbenchChrome();

function testWorkspaceExplorerRootFolderControlsUseFolderRootIcon() {
  const pageHtml = renderExplorer({
    presentation: "page",
    testInitialListing: {
      path: "/workspace/scripts",
      parent_path: "/workspace",
      entries: [],
    },
  });
  const compactHtml = renderExplorer({
    testInitialListing: {
      path: "/workspace/scripts",
      parent_path: "/workspace",
      entries: [],
    },
  });
  const rootPageHtml = renderExplorer({
    presentation: "page",
    testInitialListing: {
      path: "/workspace",
      parent_path: null,
      entries: [],
    },
  });

  const pageRootButton = pageHtml.match(
    /<button[^>]*data-ripple-files-action="root-folder"[\s\S]*?<\/button>/
  )?.[0];
  const compactRootButton = compactHtml.match(
    /<button[^>]*data-ripple-files-action="root-folder"[\s\S]*?<\/button>/
  )?.[0];
  const mobileRootPathRow = rootPageHtml.match(
    /<div[^>]*data-ripple-files-mobile-path-row[\s\S]*?<\/div>/
  )?.[0];
  const desktopRootPathRow = rootPageHtml.match(
    /<div[^>]*data-ripple-files-path-row="page"[\s\S]*?<\/div>/
  )?.[0];

  assert.ok(pageRootButton);
  assert.ok(compactRootButton);
  assert.ok(mobileRootPathRow);
  assert.ok(desktopRootPathRow);
  assert.match(pageRootButton, /lucide-folder-root/);
  assert.match(compactRootButton, /lucide-folder-root/);
  assert.match(mobileRootPathRow, /lucide-folder-root/);
  assert.match(desktopRootPathRow, /lucide-folder-root/);
}

testWorkspaceExplorerRootFolderControlsUseFolderRootIcon();

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
  const source = readWorkspaceExplorerImplementationSource();
  const sheetIndex = source.indexOf("data-ripple-files-mobile-search-sheet");

  assert.ok(sheetIndex >= 0);
  assert.match(source, /data-ripple-files-mobile-search-trigger/);
  assert.match(source, /data-ripple-files-mobile-actions-sheet/);

  const afterSheetIndex = source.indexOf("interface WorkspaceSearchFiltersProps", sheetIndex);
  assert.ok(afterSheetIndex > sheetIndex);

  const sheetSource = source.slice(sheetIndex, afterSheetIndex);
  assert.match(sheetSource, /aria-label=\{t\("files\.searchWorkspaceFiles"\)\}/);
  assert.match(sheetSource, /<WorkspaceSearchFilters/);
  assert.match(source, /value=\{searchScope\}/);
  assert.match(source, /value=\{searchKind\}/);
  assert.match(source, /value=\{fileType\}/);
  assert.match(source, /value=\{searchLimit\}/);
}

testWorkspaceExplorerMobileSearchSheetKeepsSearchAndFiltersTogether();

function testWorkspaceExplorerUsesMobileActionSheetForPageMoreActions() {
  const source = readWorkspaceExplorerImplementationSource();

  assert.match(
    source,
    /import MobileActionSheet from "@\/components\/workbench\/MobileActionSheet"/
  );
  assert.match(source, /data-ripple-files-mobile-actions-sheet/);
  assert.match(source, /MobileActionSheet[\s\S]*t\("files\.moreFileActions"\)/);
  assert.match(source, /data-ripple-files-selection-bottom-bar/);
  assert.doesNotMatch(source, /data-ripple-files-mobile-actions-menu/);
}

testWorkspaceExplorerUsesMobileActionSheetForPageMoreActions();

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
  const source = readWorkspaceExplorerImplementationSource();

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
  const source = readWorkspaceExplorerImplementationSource();

  assert.match(source, /import \{ PdfPreview \} from ".*PdfPreview"/);
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
  const source = readWorkspaceExplorerImplementationSource();

  assert.match(source, /setDocumentPreview\(\{\s*blob:\s*documentPreview\.blob/);
  assert.match(source, /filename:\s*documentPreview\.filename/);
  assert.match(source, /blob=\{documentPreview\.blob\}/);
  assert.match(source, /filename=\{documentPreview\.filename\}/);
}

testWorkspaceExplorerPassesDocumentBlobToPdfPreview();

function testWorkspaceExplorerDocumentPreviewFillsAvailableHeight() {
  const source = readWorkspaceExplorerImplementationSource();

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
  const source = readWorkspaceExplorerImplementationSource();
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
  assert.match(
    source,
    /data-ripple-workspace-preview-fullscreen[\s\S]*pt-\[max\(env\(safe-area-inset-top\),0px\)\]/
  );
  assert.match(
    source,
    /data-ripple-workspace-preview-fullscreen[\s\S]*pb-\[max\(env\(safe-area-inset-bottom\),0px\)\]/
  );
  assert.match(source, /min-h-\[56px\]/);
  assert.match(source, /aria-label=\{t\("files\.closeFullscreenPreview"\)\}/);
  assert.match(source, /className="inline-flex h-11 w-11 shrink-0/);
  assert.match(html, /aria-label="Open fullscreen preview"/);
}

testWorkspaceExplorerPreviewSupportsFullscreenOpenAndClose();

function testWorkspaceExplorerMobilePreviewChromeIsCompact() {
  const source = readWorkspaceExplorerImplementationSource();
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
    /data-ripple-workspace-preview-title-path[\s\S]*className=\{`hidden truncate[\s\S]*TYPOGRAPHY_META_CLASS/
  );
  assert.match(source, /data-ripple-workspace-preview-metadata[\s\S]*TYPOGRAPHY_META_MEDIUM_CLASS/);
  assert.match(source, /min-h-\[40px\]/);
  assert.match(source, /sm:min-h-\[68px\]/);
  assert.match(source, /TYPOGRAPHY_BODY_MEDIUM_CLASS/);
  assert.match(source, /size=\{isPagePresentation \? "sm" : "md"\}/);
  assert.match(html, /data-ripple-workspace-preview-title-path/);
  assert.doesNotMatch(html, /data-ripple-workspace-preview-action="download"/);
  assert.match(html, /data-ripple-workspace-preview-metadata/);
}

testWorkspaceExplorerMobilePreviewChromeIsCompact();

function testWorkspaceExplorerPagePreviewSupportsMobileVerticalResize() {
  const source = readWorkspaceExplorerImplementationSource();
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
  const source = readWorkspaceExplorerImplementationSource();

  assert.match(source, /function initialIsCoarsePointer/);
  assert.match(source, /matchMedia\("\(pointer: coarse\)"\)/);
  assert.match(source, /const \[isCoarsePointer, setIsCoarsePointer\]/);
  assert.match(source, /draggable=\{!isCoarsePointer\}/);
  assert.match(source, /if \(isCoarsePointer\) \{/);
  assert.match(source, /event\.preventDefault\(\)/);
}

testWorkspaceExplorerTouchPreviewClicksAvoidDragInterference();

function testWorkspaceExplorerPreviewRequestsIgnoreStaleResults() {
  const source = readWorkspaceExplorerImplementationSource();

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
  const source = readWorkspaceExplorerImplementationSource();

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
  const source = readWorkspaceExplorerImplementationSource();

  assert.match(source, /useState<NonNullable<WorkspaceSearchOptions\["scope"\]>>\(\s*"name"\s*\)/);
  assert.match(source, /placeholder=\{t\("files\.findFilesByName"\)\}/);
  assert.match(source, /searchMatchLabel/);
}

testWorkspaceSearchDefaultsToNameAndShowsMatchSource();

function testWorkspaceExplorerDoesNotExposeHiddenFileSearchToggle() {
  const source = readWorkspaceExplorerImplementationSource();

  assert.doesNotMatch(source, /Include hidden files/);
  assert.doesNotMatch(source, /setIncludeHidden/);
}

testWorkspaceExplorerDoesNotExposeHiddenFileSearchToggle();

function testWorkspaceExplorerCachesListingsAndAvoidsCurrentPathReloadEffect() {
  const source = readWorkspaceExplorerImplementationSource();

  assert.match(source, /workspaceListingCache/);
  assert.match(source, /workspaceLastPathCache/);
  assert.doesNotMatch(source, /\[currentPath,\s*loadDirectory,\s*refreshToken\]/);
}

testWorkspaceExplorerCachesListingsAndAvoidsCurrentPathReloadEffect();

function testWorkspaceLinkOpenLoadsParentDirectoryBeforePreview() {
  const source = readWorkspaceExplorerImplementationSource();

  assert.equal(
    getWorkspaceParentPath("/workspace/meeting_record/通用会议16.json"),
    "/workspace/meeting_record"
  );
  assert.equal(getWorkspaceParentPath("/workspace/summary.md"), "/workspace");
  assert.match(source, /await loadDirectory\(getWorkspaceParentPath\(targetPath\)\)/);
}

testWorkspaceLinkOpenLoadsParentDirectoryBeforePreview();

function testWorkspaceExplorerOpensPendingFileRequestAfterMount() {
  const source = readWorkspaceExplorerImplementationSource();

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
  const source = readWorkspaceExplorerImplementationSource();
  const effectStart = source.indexOf("if (!openFileRequest) return;");
  const effectEnd = source.indexOf(
    "}, [openFileRequest, onOpenFileRequestConsumed, openWorkspaceFilePath, userId]);",
    effectStart
  );

  assert.ok(effectStart >= 0);
  assert.ok(effectEnd > effectStart);

  const pendingOpenEffectSource = source.slice(effectStart, effectEnd);

  assert.match(
    pendingOpenEffectSource,
    /await openWorkspaceFilePath\(openFileRequest\.path, openFileRequest\.lineNumber\)[\s\S]*onOpenFileRequestConsumed\?\.\(openFileRequest\.id\)/
  );
  assert.doesNotMatch(
    pendingOpenEffectSource,
    /openFileRequest\.userId[\s\S]*onOpenFileRequestConsumed\?\.\(openFileRequest\.id\)[\s\S]*return;/
  );
}

testWorkspaceExplorerConsumesPendingFileRequestAfterPreviewOpenSettles();

function testWorkspaceLinkOpenReopensCollapsedPreviewPanel() {
  const source = readWorkspaceExplorerImplementationSource();

  assert.match(source, /setSplitPercent\(\(current\) =>/);
  assert.match(source, /current >= MAX_SPLIT_PERCENT \? DEFAULT_SPLIT_PERCENT : current/);
}

testWorkspaceLinkOpenReopensCollapsedPreviewPanel();

function testWorkspaceFileClickReopensCollapsedPreviewPanel() {
  const source = readWorkspaceExplorerImplementationSource();
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
  const source = readWorkspaceExplorerImplementationSource();

  assert.match(source, /opacity-100/);
  assert.match(source, /sm:opacity-0/);
  assert.match(source, /sm:group-hover:opacity-100/);
}

testWorkspaceFileActionsStayVisibleOnTouchScreens();

function testWorkspaceExplorerSupportsMultiSelectionBatchActions() {
  const source = readWorkspaceExplorerImplementationSource();
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

function testWorkspaceExplorerSelectionBarUsesStableTwoRowLayout() {
  const source = readWorkspaceExplorerImplementationSource();

  const barIndex = source.indexOf("data-ripple-files-selection-bar");
  const statusIndex = source.indexOf("data-ripple-files-selection-status-row", barIndex);
  const choiceActionsIndex = source.indexOf(
    "data-ripple-files-selection-choice-actions",
    statusIndex
  );
  const batchActionsIndex = source.indexOf(
    "data-ripple-files-selection-batch-actions",
    choiceActionsIndex
  );

  assert.ok(barIndex >= 0);
  assert.ok(statusIndex > barIndex);
  assert.ok(choiceActionsIndex > statusIndex);
  assert.ok(batchActionsIndex > choiceActionsIndex);

  const barSource = source.slice(barIndex, source.indexOf("<div", batchActionsIndex + 1));
  assert.match(barSource, /grid gap-2/);
  assert.match(barSource, /sm:flex-row/);
  assert.match(barSource, /\[scrollbar-width:none\]/);
  assert.match(barSource, /shrink-0/);
}

testWorkspaceExplorerSelectionBarUsesStableTwoRowLayout();

function testWorkspaceExplorerPageRowsOmitMobileSwipeActions() {
  const source = readWorkspaceExplorerImplementationSource();
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

  assert.doesNotMatch(source, /import SwipeActionRow/);
  assert.doesNotMatch(source, /data-ripple-files-swipe-row/);
  assert.doesNotMatch(source, /trailingActions=\{/);
  assert.doesNotMatch(source, /onSwipeRightCommit=\{/);
  assert.match(source, /toggleEntrySelection\(entry\)/);
  assert.match(source, /startRename\(entry\)/);
  assert.match(source, /startRename\(contextMenu\.entry\)/);
  assert.match(source, /handleDelete\(contextMenu\.entry\)/);
  assert.match(source, /openWorkspaceContextMenuForEntry/);
  assert.doesNotMatch(html, /data-ripple-swipe-row/);
  assert.doesNotMatch(html, /data-ripple-files-swipe-row/);
  assert.doesNotMatch(html, /aria-disabled="true"/);
  assert.doesNotMatch(html, /data-ripple-swipe-actions/);
  assert.doesNotMatch(html, /aria-label="Delete"/);
}

testWorkspaceExplorerPageRowsOmitMobileSwipeActions();

function testWorkspaceExplorerSupportsDragMoveIntoDirectories() {
  const source = readWorkspaceExplorerImplementationSource();
  const html = renderExplorer({
    presentation: "page",
    testInitialListing: {
      path: "/workspace/projects",
      parent_path: "/workspace",
      entries: [
        {
          name: "alpha.txt",
          path: "/workspace/projects/alpha.txt",
          kind: "file",
          size_bytes: 10,
          modified_at: "2026-05-17T00:00:00Z",
          is_hidden: false,
          mime_type: "text/plain",
        },
        {
          name: "archive",
          path: "/workspace/projects/archive",
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
  assert.doesNotMatch(source, /isWritableWorkspacePath/);
  assert.match(source, /selectedEntryPaths\.has\(entry\.path\) \? selectedEntries : \[entry\]/);
  assert.match(html, /draggable="true"/);
  assert.match(html, /data-ripple-files-drop-target="directory"/);
  assert.doesNotMatch(html, /data-ripple-files-drop-target="file"/);
}

testWorkspaceExplorerSupportsDragMoveIntoDirectories();

function testWorkspaceContextMenuUsesViewportAwarePositioning() {
  const source = readWorkspaceExplorerImplementationSource();

  assert.match(source, /getWorkspaceContextMenuPosition/);
  assert.match(source, /getMeasuredViewportMenuPosition/);
  assert.match(source, /contextMenuRef/);
  assert.match(source, /getBoundingClientRect\(\)\.height/);
  assert.match(source, /useLayoutEffect/);
  assert.match(source, /createPortal/);
  assert.match(source, /contextMenuPortal/);
  assert.match(source, /document\.body/);
  assert.doesNotMatch(source, /rect\.bottom \+ 4/);
}

testWorkspaceContextMenuUsesViewportAwarePositioning();

function testWorkspaceContextMenuExposesExpectedRightClickActions() {
  const source = readWorkspaceExplorerImplementationSource();

  assert.match(source, /onContextMenu=\{onContainerContextMenu\}/);
  assert.match(source, /onContextMenu=\{\(event\) => onEntryContextMenu\(event, entry\)\}/);
  assert.match(source, /onMoreButtonClick\(event, entry\)/);
  assert.match(source, /startRename\(contextMenu\.entry\)/);
  assert.match(source, /handleCut\(contextMenu\.entry\)/);
  assert.match(source, /handleCopy\(contextMenu\.entry\)/);
  assert.match(source, /handleCopyAbsoluteSandboxPath\(contextMenu\.entry\)/);
  assert.match(source, /contextMenu\.entry\.kind === "file"/);
  assert.match(source, /handleDownloadFile\(contextMenu\.entry\.path\)/);
  assert.match(source, /handleDelete\(contextMenu\.entry\)/);
  assert.match(source, /onClick=\{handlePaste\}/);
  assert.match(source, /clearClipboard/);
  assert.match(source, /setCreationModal\(\{ visible: true, kind: "file" \}\)/);
  assert.match(source, /setCreationModal\(\{ visible: true, kind: "directory" \}\)/);
}

testWorkspaceContextMenuExposesExpectedRightClickActions();

function testWorkspaceEntryClickDismissesOpenContextMenuBeforeOpeningEntry() {
  const source = readWorkspaceExplorerImplementationSource();

  assert.equal(shouldDismissWorkspaceContextMenuOnEntryClick(true), true);
  assert.equal(shouldDismissWorkspaceContextMenuOnEntryClick(false), false);
  assert.match(
    source,
    /shouldDismissWorkspaceContextMenuOnEntryClick\(contextMenu\.visible\)[\s\S]*?event\.preventDefault\(\);[\s\S]*?event\.stopPropagation\(\);[\s\S]*?setContextMenu\(\(prev\) => \(\{ \.\.\.prev, visible: false \}\)\);[\s\S]*?return;/
  );
}

testWorkspaceEntryClickDismissesOpenContextMenuBeforeOpeningEntry();

function testWorkspaceExplorerCompactToolbarOffersCreationActionsFromMoreMenu() {
  const source = readWorkspaceExplorerImplementationSource();
  const html = renderExplorer();

  assert.match(html, /data-ripple-files-action="compact-more"/);
  assert.match(html, /aria-label="More file actions"/);
  assert.match(source, /data-ripple-files-compact-actions-menu/);
  assert.match(source, /t\("files\.newFile"\)/);
  assert.match(source, /t\("files\.newFolder"\)/);
}

testWorkspaceExplorerCompactToolbarOffersCreationActionsFromMoreMenu();

function testWorkspaceExplorerDoesNotRenderFixedWorkspacePlaces() {
  const html = renderExplorer({
    presentation: "page",
    testInitialListing: {
      path: "/workspace",
      parent_path: null,
      entries: [],
    },
  });

  assert.doesNotMatch(workspaceExplorerSource, /WorkspacePlacesNav/);
  assert.doesNotMatch(workspaceExplorerSource, /WORKSPACE_FIXED_PLACES/);
  assert.doesNotMatch(html, /data-ripple-workspace-places/);
  assert.doesNotMatch(html, /data-ripple-workspace-place="skills"/);
  assert.doesNotMatch(html, /data-ripple-workspace-place="uploads"/);
  assert.doesNotMatch(html, /data-ripple-workspace-place="outputs"/);
  assert.doesNotMatch(html, />Skills</);
  assert.doesNotMatch(html, />Uploads</);
  assert.doesNotMatch(html, />Outputs</);
  assert.doesNotMatch(html, />Recent</);
  assert.doesNotMatch(html, /data-ripple-workspace-place="recent"/);
}

testWorkspaceExplorerDoesNotRenderFixedWorkspacePlaces();

function testWorkspaceExplorerWritesToTheCurrentWorkspaceDirectory() {
  const source = readWorkspaceExplorerImplementationSource();
  const html = renderExplorer({
    presentation: "page",
    testInitialListing: {
      path: "/workspace/projects/client-a",
      parent_path: "/workspace",
      entries: [],
    },
  });

  assert.doesNotMatch(source, /workspaceFileCenter/);
  assert.doesNotMatch(source, /WorkspacePlace/);
  assert.doesNotMatch(source, /workspaceOperationTarget/);
  assert.doesNotMatch(source, /getWorkspaceUploadTargetPath/);
  assert.doesNotMatch(source, /canWriteInCurrentPath/);
  assert.doesNotMatch(source, /fixedPlaceRequired/);
  assert.doesNotMatch(source, /data-ripple-files-write-scope/);
  assert.doesNotMatch(source, /uploadTargetPath/);
  assert.match(source, /uploadWorkspaceFiles\(files,\s*currentPath/);
  assert.match(source, /pasteWorkspaceEntry\(item\.path,\s*destination,\s*clipboard\.action\)/);
  assert.doesNotMatch(source, /disabled=\{!canWriteInCurrentPath\}/);
  assert.doesNotMatch(source, /disabled=\{!clipboard \|\| !canWriteInCurrentPath\}/);
  assert.doesNotMatch(html, /data-ripple-files-write-scope=/);
}

testWorkspaceExplorerWritesToTheCurrentWorkspaceDirectory();

function testWorkspaceExplorerUsesAppConfirmationsAndMobileEntryActionSheet() {
  const source = readWorkspaceExplorerImplementationSource();
  const confirmationSource = readFileSync(
    new URL("./workspace/WorkspaceConfirmDialog.tsx", import.meta.url),
    "utf8"
  );

  assert.match(confirmationSource, /data-ripple-files-confirm-dialog/);
  assert.match(source, /data-ripple-files-mobile-entry-actions-sheet/);
  assert.match(source, /onTouchStart=\{\(event\) => handleEntryLongPressStart\(event, entry\)\}/);
  assert.match(source, /onTouchEnd=\{handleEntryLongPressEnd\}/);
  assert.doesNotMatch(`${source}\n${confirmationSource}`, /window\.confirm/);
}

testWorkspaceExplorerUsesAppConfirmationsAndMobileEntryActionSheet();

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
