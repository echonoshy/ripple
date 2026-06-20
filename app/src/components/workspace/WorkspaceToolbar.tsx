import React from "react";
import {
  ArrowUp,
  ChevronRight,
  FolderRoot,
  FolderUp,
  Loader2,
  MoreHorizontal,
  RefreshCw,
  Search,
  SlidersHorizontal,
  SquareCheck,
  Upload,
  X,
} from "lucide-react";
import { IconTile } from "@/components/icons/IconTile";
import MobilePageHeader from "@/components/workbench/MobilePageHeader";
import {
  LUCIDE_STANDARD_STROKE_WIDTH,
  TYPOGRAPHY_BODY_CLASS,
  TYPOGRAPHY_BODY_MEDIUM_CLASS,
  TYPOGRAPHY_META_CLASS,
  TYPOGRAPHY_META_MEDIUM_CLASS,
  TYPOGRAPHY_MICRO_MEDIUM_CLASS,
  TYPOGRAPHY_MOBILE_BODY_CLASS,
  TYPOGRAPHY_PAGE_TITLE_CLASS,
  WORKBENCH_ICON_BUTTON_CLASS,
  WORKBENCH_MOBILE_GHOST_ICON_BUTTON_ACTIVE_CLASS,
  WORKBENCH_SECONDARY_BUTTON_CLASS,
  WORKBENCH_SECTION_CLASS,
} from "@/components/workbench/stylePrimitives";
import { useI18n } from "@/i18n";
import type { WorkspaceSearchOptions } from "@/lib/api";
import type { WorkspaceListing } from "@/types";
import { DEFAULT_WORKSPACE_PATH, getWorkspacePathBreadcrumbs } from "./workspaceExplorerUtils";

interface WorkspaceToolbarProps {
  presentation: "compact" | "page";
  onBack?: () => void;
  query: string;
  onQueryChange: (value: string) => void;
  isSearchMode: boolean;
  isFilterOpen: boolean;
  setIsFilterOpen: React.Dispatch<React.SetStateAction<boolean>>;
  isMobileSearchOpen: boolean;
  setIsMobileSearchOpen: React.Dispatch<React.SetStateAction<boolean>>;
  isActionsMenuOpen: boolean;
  setIsActionsMenuOpen: React.Dispatch<React.SetStateAction<boolean>>;
  searchScope: NonNullable<WorkspaceSearchOptions["scope"]>;
  setSearchScope: React.Dispatch<
    React.SetStateAction<NonNullable<WorkspaceSearchOptions["scope"]>>
  >;
  searchKind: NonNullable<WorkspaceSearchOptions["kind"]>;
  setSearchKind: React.Dispatch<React.SetStateAction<NonNullable<WorkspaceSearchOptions["kind"]>>>;
  fileType: NonNullable<WorkspaceSearchOptions["fileType"]>;
  setFileType: React.Dispatch<
    React.SetStateAction<NonNullable<WorkspaceSearchOptions["fileType"]>>
  >;
  searchLimit: number;
  setSearchLimit: React.Dispatch<React.SetStateAction<number>>;
  listing: WorkspaceListing | null;
  currentPath: string;
  currentDisplayPath: string;
  desktopPathLabel: string;
  desktopPathDetail: string | null;
  mobilePathLabel: string;
  mobilePathDetail: string | null;
  currentLocationPath: string;
  isSelectionActive: boolean;
  toggleSelectionMode: () => void;
  uploadInputRef: React.RefObject<HTMLInputElement | null>;
  uploading: boolean;
  loading: boolean;
  loadDirectory: (path: string) => void;
}

export default function WorkspaceToolbar({
  presentation,
  onBack,
  query,
  onQueryChange,
  isSearchMode,
  isFilterOpen,
  setIsFilterOpen,
  isMobileSearchOpen,
  setIsMobileSearchOpen,
  setIsActionsMenuOpen,
  searchScope,
  setSearchScope,
  searchKind,
  setSearchKind,
  fileType,
  setFileType,
  searchLimit,
  setSearchLimit,
  listing,
  currentPath,
  currentDisplayPath,
  desktopPathLabel,
  desktopPathDetail,
  mobilePathLabel,
  mobilePathDetail,
  currentLocationPath,
  isSelectionActive,
  toggleSelectionMode,
  uploadInputRef,
  uploading,
  loading,
  loadDirectory,
}: WorkspaceToolbarProps) {
  const { t } = useI18n();
  const isPagePresentation = presentation === "page";
  const filesToolbarIconButtonBaseClass = WORKBENCH_ICON_BUTTON_CLASS;
  const filesToolbarIconButtonClass = `${filesToolbarIconButtonBaseClass} text-[#646A73] hover:text-[#1F2329]`;
  const filesToolbarIconButtonActiveClass = `${filesToolbarIconButtonBaseClass} border-[#1456F0]/30 bg-[#F0F5FF] text-[#1456F0] hover:bg-[#F0F5FF]`;
  const filesMobileToolbarButtonClass =
    "inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-transparent text-[#2B2F36] transition-colors hover:bg-[#F8F9FA] active:bg-[#EFF0F1] disabled:cursor-not-allowed disabled:opacity-50";
  const filesMobilePrimaryHeaderClass =
    "flex min-w-0 items-center gap-2 border-b border-[#DEE0E3] bg-white px-3 py-2 lg:hidden";
  const pageParentButtonClass =
    "inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-[#BACEFD] bg-[#F0F5FF] text-[#1456F0] transition-colors hover:bg-[#e5efff] lg:hidden";
  const directoryNavigationButtonClass = `${WORKBENCH_SECONDARY_BUTTON_CLASS} h-8 shrink-0 whitespace-nowrap px-2.5 text-[#46556f] hover:border-[#BACEFD] hover:bg-[#F0F5FF] hover:text-[#1456F0] ${TYPOGRAPHY_MICRO_MEDIUM_CLASS}`;
  const directoryNavigationIconClass =
    "flex h-5 w-5 items-center justify-center rounded-full bg-[#F0F5FF] text-[#1456F0] ring-1 ring-[#BACEFD] transition-colors group-hover:bg-[#E8F0FF] group-hover:text-[#1456F0]";
  const breadcrumbs = getWorkspacePathBreadcrumbs(currentLocationPath);
  const mobileFileActions = (
    <>
      <button
        type="button"
        data-ripple-files-mobile-search-trigger
        onClick={() => {
          setIsActionsMenuOpen(false);
          setIsMobileSearchOpen(true);
        }}
        className={`${filesMobileToolbarButtonClass} ${
          isSearchMode ? WORKBENCH_MOBILE_GHOST_ICON_BUTTON_ACTIVE_CLASS : ""
        }`}
        title={t("files.searchWorkspaceFiles")}
        aria-label={t("files.searchWorkspaceFiles")}
      >
        <Search size={18} strokeWidth={LUCIDE_STANDARD_STROKE_WIDTH} />
      </button>
      <button
        type="button"
        data-ripple-files-action="toggle-selection"
        onClick={toggleSelectionMode}
        className={`${filesMobileToolbarButtonClass} ${
          isSelectionActive ? WORKBENCH_MOBILE_GHOST_ICON_BUTTON_ACTIVE_CLASS : ""
        }`}
        title={isSelectionActive ? t("files.doneSelecting") : t("files.selectFiles")}
        aria-label={isSelectionActive ? t("files.doneSelecting") : t("files.selectFiles")}
      >
        {isSelectionActive ? (
          <X size={18} strokeWidth={LUCIDE_STANDARD_STROKE_WIDTH} />
        ) : (
          <SquareCheck size={18} strokeWidth={LUCIDE_STANDARD_STROKE_WIDTH} />
        )}
      </button>
      <button
        type="button"
        data-ripple-files-action="upload"
        className={filesMobileToolbarButtonClass}
        title={t("files.uploadFiles")}
        aria-label={t("files.uploadFiles")}
        disabled={uploading}
        onClick={() => uploadInputRef.current?.click()}
      >
        {uploading ? (
          <Loader2 size={18} strokeWidth={LUCIDE_STANDARD_STROKE_WIDTH} className="animate-spin" />
        ) : (
          <Upload size={18} strokeWidth={LUCIDE_STANDARD_STROKE_WIDTH} />
        )}
      </button>
      <button
        type="button"
        data-ripple-files-action="mobile-more"
        className={filesMobileToolbarButtonClass}
        title={t("files.moreFileActions")}
        aria-label={t("files.moreFileActions")}
        onClick={(event) => {
          event.stopPropagation();
          setIsMobileSearchOpen(false);
          setIsActionsMenuOpen((open) => !open);
        }}
      >
        <MoreHorizontal size={18} strokeWidth={LUCIDE_STANDARD_STROKE_WIDTH} />
      </button>
    </>
  );

  return (
    <>
      <div
        className={
          isPagePresentation
            ? "shrink-0 bg-white shadow-[0_1px_2px_rgba(31,35,41,0.04)] lg:border-b lg:border-[#DEE0E3] lg:px-3 lg:py-3"
            : "shrink-0 border-b border-[#EFF0F1] bg-white px-4 py-3"
        }
      >
        <div
          data-ripple-files-toolbar-layout={isPagePresentation ? "stacked" : "compact"}
          className={isPagePresentation ? "flex flex-col gap-3" : "mb-2 flex items-center gap-2"}
        >
          {isPagePresentation && (
            <>
              {onBack ? (
                <MobilePageHeader
                  title={t("files.title")}
                  backLabel={t("files.backToSession")}
                  onBack={onBack}
                  actions={mobileFileActions}
                />
              ) : (
                <div
                  data-ripple-files-mobile-primary-header="true"
                  data-ripple-files-title-row="page"
                  className={filesMobilePrimaryHeaderClass}
                >
                  <div className="min-w-0 flex-1">
                    <h1
                      data-ripple-files-title="primary"
                      className={`truncate text-[#1F2329] ${TYPOGRAPHY_PAGE_TITLE_CLASS}`}
                    >
                      {t("files.title")}
                    </h1>
                  </div>
                  <div className="flex min-w-0 shrink-0 items-center justify-end gap-1.5">
                    {mobileFileActions}
                  </div>
                </div>
              )}
              <div
                data-ripple-files-title-row="page"
                className="hidden min-w-0 items-center gap-2 lg:flex"
              >
                <div className="min-w-0 flex-1">
                  <h1 className={`text-[#1F2329] ${TYPOGRAPHY_PAGE_TITLE_CLASS}`}>
                    {t("files.title")}
                  </h1>
                </div>
              </div>
            </>
          )}
          <div
            data-ripple-files-search-row={isPagePresentation ? "page" : undefined}
            className={
              isPagePresentation
                ? "hidden min-w-0 items-center gap-2 lg:flex"
                : "flex min-w-0 flex-1 items-center gap-2"
            }
          >
            <div className="relative min-w-0 flex-1">
              <Search
                size={14}
                className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-[#8F959E]"
              />
              <input
                value={query}
                onChange={(event) => onQueryChange(event.target.value)}
                placeholder={t("files.findFilesByName")}
                aria-label={t("files.searchWorkspaceFiles")}
                className={
                  isPagePresentation
                    ? `h-9 w-full rounded-lg border border-[#DEE0E3] bg-white pr-3 pl-9 text-[#1F2329] outline-none placeholder:text-[12px] placeholder:text-[#8F959E] focus:border-[#1456F0] ${TYPOGRAPHY_BODY_CLASS}`
                    : `h-8 w-full rounded-full border border-[#EFF0F1] bg-white pr-2 pl-9 text-[#1F2329] outline-none placeholder:text-[12px] placeholder:text-[#8F959E] focus:border-[#8FB1FF] ${TYPOGRAPHY_BODY_CLASS}`
                }
              />
            </div>
            <button
              type="button"
              data-ripple-files-action="search-filters"
              className={
                isFilterOpen ? filesToolbarIconButtonActiveClass : filesToolbarIconButtonClass
              }
              title={t("files.searchFilters")}
              aria-label={t("files.searchFilters")}
              onClick={() => setIsFilterOpen((open) => !open)}
            >
              <SlidersHorizontal size={14} />
            </button>
            <button
              type="button"
              data-ripple-files-action="toggle-selection"
              className={
                isSelectionActive ? filesToolbarIconButtonActiveClass : filesToolbarIconButtonClass
              }
              title={isSelectionActive ? t("files.doneSelecting") : t("files.selectFiles")}
              aria-label={isSelectionActive ? t("files.doneSelecting") : t("files.selectFiles")}
              onClick={toggleSelectionMode}
            >
              {isSelectionActive ? <X size={14} /> : <SquareCheck size={14} />}
            </button>
            <button
              type="button"
              data-ripple-files-action="upload"
              className={filesToolbarIconButtonClass}
              title={t("files.uploadFiles")}
              aria-label={t("files.uploadFiles")}
              disabled={uploading}
              onClick={() => uploadInputRef.current?.click()}
            >
              {uploading ? <Loader2 size={14} className="animate-spin" /> : <Upload size={14} />}
            </button>
            {!isPagePresentation && (
              <button
                type="button"
                data-ripple-files-action="compact-more"
                className={filesToolbarIconButtonClass}
                title={t("files.moreFileActions")}
                aria-label={t("files.moreFileActions")}
                onClick={(event) => {
                  event.stopPropagation();
                  setIsActionsMenuOpen((open) => !open);
                }}
              >
                <MoreHorizontal size={14} />
              </button>
            )}
            {isPagePresentation && (
              <button
                type="button"
                data-ripple-files-action="refresh"
                onClick={() => loadDirectory(currentPath)}
                className={filesToolbarIconButtonClass}
                title={t("files.refreshWorkspace")}
                aria-label={t("files.refreshWorkspace")}
                disabled={loading}
              >
                {loading ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
              </button>
            )}
          </div>
        </div>
        {isPagePresentation && (
          <div
            data-ripple-files-mobile-path-row
            className="mx-3 mt-3 flex min-w-0 items-center gap-2 rounded-xl border border-[#DEE0E3] bg-white px-2.5 py-2 text-[#646A73] lg:hidden"
          >
            {listing?.parent_path ? (
              <button
                type="button"
                data-ripple-files-action="parent-folder"
                className={pageParentButtonClass}
                title={t("files.goToParentFolder")}
                aria-label={t("files.goToParentFolder")}
                onClick={() => loadDirectory(listing.parent_path || DEFAULT_WORKSPACE_PATH)}
              >
                <FolderUp size={14} />
              </button>
            ) : (
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[#F8F9FA] text-[#1456F0]">
                <FolderRoot size={16} />
              </span>
            )}
            <div className="min-w-0 flex-1">
              <div
                className={`truncate font-[family-name:var(--font-mono)] text-[#2B2F36] ${TYPOGRAPHY_META_MEDIUM_CLASS}`}
              >
                {mobilePathLabel}
              </div>
              {mobilePathDetail && (
                <div className={`mt-0.5 truncate text-[#646A73] ${TYPOGRAPHY_META_MEDIUM_CLASS}`}>
                  {mobilePathDetail}
                </div>
              )}
            </div>
            {isSearchMode && (
              <button
                type="button"
                onClick={() => setIsMobileSearchOpen(true)}
                className={`inline-flex h-8 shrink-0 items-center rounded-lg border border-[#BACEFD] bg-[#F0F5FF] px-2 text-[#1456F0] ${TYPOGRAPHY_META_MEDIUM_CLASS}`}
              >
                {t("files.edit")}
              </button>
            )}
          </div>
        )}
        {isPagePresentation && (
          <div
            data-ripple-files-path-row="page"
            data-ripple-workspace-location="current-path"
            className="mt-3 hidden min-w-0 items-center gap-2 rounded-xl border border-[#DEE0E3] bg-white px-2.5 py-2 text-[#646A73] lg:flex"
          >
            <div className="flex shrink-0 items-center gap-1">
              {listing?.parent_path ? (
                <button
                  type="button"
                  data-ripple-files-action="parent-folder"
                  className={directoryNavigationButtonClass}
                  title={t("files.goToParentFolder")}
                  aria-label={t("files.goToParentFolder")}
                  onClick={() => loadDirectory(listing.parent_path || DEFAULT_WORKSPACE_PATH)}
                >
                  <span className={directoryNavigationIconClass}>
                    <ArrowUp size={12} />
                  </span>
                </button>
              ) : null}
              {currentPath !== DEFAULT_WORKSPACE_PATH ? (
                <button
                  type="button"
                  data-ripple-files-action="root-folder"
                  className={directoryNavigationButtonClass}
                  title={t("files.goToWorkspaceRoot")}
                  aria-label={t("files.goToWorkspaceRoot")}
                  onClick={() => loadDirectory(DEFAULT_WORKSPACE_PATH)}
                >
                  <span className={directoryNavigationIconClass}>
                    <FolderRoot size={16} />
                  </span>
                </button>
              ) : null}
              {!listing?.parent_path && currentPath === DEFAULT_WORKSPACE_PATH ? (
                <IconTile tone="accent" size="sm">
                  <FolderRoot size={16} />
                </IconTile>
              ) : null}
            </div>
            <div className="min-w-0 flex-1">
              {isSearchMode ? (
                <div
                  className={`max-w-full overflow-x-auto overscroll-x-contain font-[family-name:var(--font-mono)] text-[#2B2F36] [scrollbar-width:thin] ${TYPOGRAPHY_META_MEDIUM_CLASS}`}
                >
                  <span className="whitespace-nowrap">{desktopPathLabel}</span>
                </div>
              ) : (
                <WorkspaceBreadcrumbs breadcrumbs={breadcrumbs} loadDirectory={loadDirectory} />
              )}
              {desktopPathDetail && (
                <div
                  className={`mt-0.5 flex min-w-0 items-center gap-1.5 text-[#646A73] ${TYPOGRAPHY_META_MEDIUM_CLASS}`}
                >
                  <span className="shrink-0">{desktopPathDetail}</span>
                  <span className="min-w-0 overflow-x-auto overscroll-x-contain font-[family-name:var(--font-mono)] whitespace-nowrap [scrollbar-width:thin]">
                    {currentLocationPath}
                  </span>
                </div>
              )}
            </div>
          </div>
        )}
        {isFilterOpen && (
          <div
            className={
              isPagePresentation
                ? `mt-3 hidden gap-2 p-3 text-[#2B2F36] lg:grid lg:grid-cols-2 ${TYPOGRAPHY_META_CLASS} ${WORKBENCH_SECTION_CLASS}`
                : `mb-2 grid gap-2 rounded-2xl border border-[#EFF0F1] bg-[#fbfbfc] p-3 text-[#2B2F36] shadow-sm sm:grid-cols-2 ${TYPOGRAPHY_META_CLASS}`
            }
          >
            <WorkspaceSearchFilters
              searchScope={searchScope}
              setSearchScope={setSearchScope}
              searchKind={searchKind}
              setSearchKind={setSearchKind}
              fileType={fileType}
              setFileType={setFileType}
              searchLimit={searchLimit}
              setSearchLimit={setSearchLimit}
              compact
            />
          </div>
        )}
        {!isPagePresentation && (
          <div className="flex items-center justify-between gap-2">
            <p
              className={`min-w-0 truncate font-[family-name:var(--font-mono)] text-[#646A73] ${TYPOGRAPHY_META_CLASS}`}
            >
              {currentDisplayPath}
            </p>
            <button
              type="button"
              onClick={() => loadDirectory(currentPath)}
              className={filesToolbarIconButtonClass}
              title={t("files.refreshWorkspace")}
              aria-label={t("files.refreshWorkspace")}
              disabled={loading}
            >
              {loading ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
            </button>
          </div>
        )}
      </div>

      {isPagePresentation && isMobileSearchOpen && (
        <div
          data-ripple-files-mobile-search-sheet
          className="fixed inset-0 z-50 flex items-end bg-[#1F2329]/18 p-2 pb-[max(env(safe-area-inset-bottom),8px)] backdrop-blur-[1px] lg:hidden"
          onClick={() => setIsMobileSearchOpen(false)}
        >
          <div
            className="w-full rounded-2xl border border-[#DEE0E3] bg-white text-[#1F2329] shadow-[0_-8px_24px_rgba(31,35,41,0.10)]"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex items-center gap-2 border-b border-[#EFF0F1] px-3 py-3">
              <button
                type="button"
                onClick={() => setIsMobileSearchOpen(false)}
                className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-[#DEE0E3] bg-white text-[#646A73] hover:bg-[#F8F9FA]"
                aria-label={t("files.closeSearch")}
                title={t("files.closeSearch")}
              >
                <X size={16} />
              </button>
              <div className="min-w-0 flex-1">
                <div className={`text-[#1F2329] ${TYPOGRAPHY_BODY_MEDIUM_CLASS}`}>
                  {t("files.searchWorkspace")}
                </div>
                <div
                  className={`mt-0.5 truncate font-[family-name:var(--font-mono)] text-[#646A73] ${TYPOGRAPHY_META_CLASS}`}
                >
                  {listing?.path || currentPath}
                </div>
              </div>
              <button
                type="button"
                onClick={() => onQueryChange("")}
                disabled={!isSearchMode}
                className={`inline-flex h-9 items-center rounded-xl border border-[#DEE0E3] bg-white px-3 text-[#646A73] hover:bg-[#F8F9FA] disabled:cursor-not-allowed disabled:opacity-45 ${TYPOGRAPHY_META_MEDIUM_CLASS}`}
              >
                {t("files.clear")}
              </button>
            </div>
            <div className="grid gap-3 px-3 py-3">
              <div className="relative">
                <Search
                  size={14}
                  className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-[#8F959E]"
                />
                <input
                  value={query}
                  onChange={(event) => onQueryChange(event.target.value)}
                  placeholder={t("files.findFilesByName")}
                  aria-label={t("files.searchWorkspaceFiles")}
                  autoFocus
                  className={`h-11 w-full rounded-xl border border-[#DEE0E3] bg-[#F8F9FA] pr-3 pl-9 text-[#1F2329] outline-none placeholder:text-[15px] placeholder:text-[#8F959E] focus:border-[#1456F0] ${TYPOGRAPHY_MOBILE_BODY_CLASS}`}
                />
              </div>
              <div className="flex min-w-0 gap-1.5 overflow-x-auto pb-0.5">
                <span
                  className={`shrink-0 rounded-full border border-[#BACEFD] bg-[#F0F5FF] px-2 py-1 text-[#0F4BD8] ${TYPOGRAPHY_MICRO_MEDIUM_CLASS}`}
                >
                  {searchScope === "content"
                    ? t("files.content")
                    : searchScope === "all"
                      ? t("files.nameContent")
                      : t("files.namePath")}
                </span>
                <span
                  className={`shrink-0 rounded-full border border-[#DEE0E3] bg-[#F8F9FA] px-2 py-1 text-[#646A73] ${TYPOGRAPHY_MICRO_MEDIUM_CLASS}`}
                >
                  {searchKind === "directory"
                    ? t("files.folders")
                    : searchKind === "file"
                      ? t("files.files")
                      : t("files.filesFolders")}
                </span>
                <span
                  className={`shrink-0 rounded-full border border-[#DEE0E3] bg-[#F8F9FA] px-2 py-1 text-[#646A73] ${TYPOGRAPHY_MICRO_MEDIUM_CLASS}`}
                >
                  {fileType === "all" ? t("files.allTypes") : fileType}
                </span>
                <span
                  className={`shrink-0 rounded-full border border-[#DEE0E3] bg-[#F8F9FA] px-2 py-1 text-[#646A73] ${TYPOGRAPHY_MICRO_MEDIUM_CLASS}`}
                >
                  {t("files.resultsCount", { count: searchLimit })}
                </span>
              </div>
              <div className={`grid gap-2 text-[#2B2F36] ${TYPOGRAPHY_BODY_CLASS}`}>
                <WorkspaceSearchFilters
                  searchScope={searchScope}
                  setSearchScope={setSearchScope}
                  searchKind={searchKind}
                  setSearchKind={setSearchKind}
                  fileType={fileType}
                  setFileType={setFileType}
                  searchLimit={searchLimit}
                  setSearchLimit={setSearchLimit}
                />
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function WorkspaceBreadcrumbs({
  breadcrumbs,
  loadDirectory,
}: {
  breadcrumbs: ReturnType<typeof getWorkspacePathBreadcrumbs>;
  loadDirectory: (path: string) => void;
}) {
  const { t } = useI18n();

  return (
    <nav
      data-ripple-files-breadcrumbs
      aria-label={t("files.pathBreadcrumbs")}
      className={`flex max-w-full min-w-0 items-center gap-1 overflow-x-auto overscroll-x-contain font-[family-name:var(--font-mono)] text-[#2B2F36] [scrollbar-width:thin] ${TYPOGRAPHY_META_MEDIUM_CLASS}`}
    >
      {breadcrumbs.map((crumb, index) => (
        <React.Fragment key={crumb.path}>
          {index > 0 && <ChevronRight size={12} className="shrink-0 text-[#8F959E]" />}
          {crumb.isCurrent ? (
            <span
              data-ripple-files-breadcrumb={crumb.path}
              data-ripple-files-breadcrumb-current="true"
              aria-current="page"
              className="shrink-0 rounded-md bg-[#F0F5FF] px-1.5 py-0.5 text-[#1456F0]"
            >
              {crumb.label}
            </span>
          ) : (
            <button
              type="button"
              data-ripple-files-breadcrumb={crumb.path}
              onClick={() => loadDirectory(crumb.path)}
              aria-label={t("files.openFolder", { name: crumb.label })}
              title={crumb.path}
              className="shrink-0 rounded-md px-1.5 py-0.5 text-[#46556F] hover:bg-[#F0F5FF] hover:text-[#1456F0]"
            >
              {crumb.label}
            </button>
          )}
        </React.Fragment>
      ))}
    </nav>
  );
}

interface WorkspaceSearchFiltersProps {
  searchScope: NonNullable<WorkspaceSearchOptions["scope"]>;
  setSearchScope: React.Dispatch<
    React.SetStateAction<NonNullable<WorkspaceSearchOptions["scope"]>>
  >;
  searchKind: NonNullable<WorkspaceSearchOptions["kind"]>;
  setSearchKind: React.Dispatch<React.SetStateAction<NonNullable<WorkspaceSearchOptions["kind"]>>>;
  fileType: NonNullable<WorkspaceSearchOptions["fileType"]>;
  setFileType: React.Dispatch<
    React.SetStateAction<NonNullable<WorkspaceSearchOptions["fileType"]>>
  >;
  searchLimit: number;
  setSearchLimit: React.Dispatch<React.SetStateAction<number>>;
  compact?: boolean;
}

function WorkspaceSearchFilters({
  searchScope,
  setSearchScope,
  searchKind,
  setSearchKind,
  fileType,
  setFileType,
  searchLimit,
  setSearchLimit,
  compact = false,
}: WorkspaceSearchFiltersProps) {
  const { t } = useI18n();
  const inputClass = compact
    ? `h-8 min-w-0 flex-1 rounded-lg border border-[#DEE0E3] bg-white px-2 ${TYPOGRAPHY_META_CLASS}`
    : `h-10 min-w-0 flex-1 rounded-xl border border-[#DEE0E3] bg-white px-2 ${TYPOGRAPHY_MOBILE_BODY_CLASS}`;

  return (
    <>
      <label className="flex items-center gap-2">
        <span className="w-16 text-[#646A73]">{t("files.scope")}</span>
        <select
          value={searchScope}
          onChange={(event) =>
            setSearchScope(event.target.value as NonNullable<WorkspaceSearchOptions["scope"]>)
          }
          className={inputClass}
        >
          <option value="name">{t("files.scopeName")}</option>
          <option value="all">{t("files.scopeAll")}</option>
          <option value="content">{t("files.scopeContent")}</option>
        </select>
      </label>
      <label className="flex items-center gap-2">
        <span className="w-16 text-[#646A73]">{t("files.kind")}</span>
        <select
          value={searchKind}
          onChange={(event) =>
            setSearchKind(event.target.value as NonNullable<WorkspaceSearchOptions["kind"]>)
          }
          className={inputClass}
        >
          <option value="all">{t("files.kindAll")}</option>
          <option value="file">{t("files.kindFile")}</option>
          <option value="directory">{t("files.kindDirectory")}</option>
        </select>
      </label>
      <label className="flex items-center gap-2">
        <span className="w-16 text-[#646A73]">{t("files.fileType")}</span>
        <select
          value={fileType}
          onChange={(event) =>
            setFileType(event.target.value as NonNullable<WorkspaceSearchOptions["fileType"]>)
          }
          className={inputClass}
        >
          <option value="all">{t("files.allTypes")}</option>
          <option value="code">{t("files.code")}</option>
          <option value="markdown">{t("files.markdown")}</option>
          <option value="text">{t("files.text")}</option>
          <option value="image">{t("files.images")}</option>
        </select>
      </label>
      <label className="flex items-center gap-2">
        <span className="w-16 text-[#646A73]">{t("files.results")}</span>
        <select
          value={searchLimit}
          onChange={(event) => setSearchLimit(Number(event.target.value))}
          className={inputClass}
        >
          <option value={20}>20</option>
          <option value={50}>50</option>
        </select>
      </label>
    </>
  );
}
