import React from "react";
import {
  ArrowUp,
  Copy,
  FileText,
  Folder,
  FolderRoot,
  Loader2,
  MoreHorizontal,
  Scissors,
  Trash2,
} from "lucide-react";
import { IconTile } from "@/components/icons/IconTile";
import {
  TYPOGRAPHY_BODY_CLASS,
  TYPOGRAPHY_BODY_MEDIUM_CLASS,
  TYPOGRAPHY_META_CLASS,
  TYPOGRAPHY_META_MEDIUM_CLASS,
  TYPOGRAPHY_MICRO_MEDIUM_CLASS,
  TYPOGRAPHY_MOBILE_BODY_CLASS,
} from "@/components/workbench/stylePrimitives";
import { useI18n } from "@/i18n";
import type { WorkspaceEntry, WorkspaceFilePreview, WorkspaceListing } from "@/types";
import {
  DEFAULT_WORKSPACE_PATH,
  SearchResultMeta,
  formatBytes,
  formatModified,
} from "./workspaceExplorerUtils";
import type { WorkspaceClipboardState } from "./WorkspaceActionMenus";

interface WorkspaceFileListProps {
  isPagePresentation: boolean;
  isPreviewPanelHidden: boolean;
  loading: boolean;
  listing: WorkspaceListing | null;
  searchLoading: boolean;
  visibleEntries: WorkspaceEntry[];
  isSearchMode: boolean;
  currentPath: string;
  selectedEntryCount: number;
  isSelectionActive: boolean;
  allVisibleEntriesSelected: boolean;
  selectedEntryPaths: Set<string>;
  selectedEntries: WorkspaceEntry[];
  preview: WorkspaceFilePreview | null;
  locale: string;
  renamingPath: string | null;
  renameDraft: string;
  renameSaving: boolean;
  renameInputRef: React.RefObject<HTMLInputElement | null>;
  dragTargetPath: string | null;
  draggedEntryPaths: Set<string>;
  clipboard: WorkspaceClipboardState | null;
  isCoarsePointer: boolean;
  loadDirectory: (path: string) => void;
  selectAllVisibleEntries: () => void;
  clearSelection: () => void;
  handleBatchClipboard: (action: "copy" | "move") => void;
  handleBatchDelete: () => void;
  setRenameDraft: React.Dispatch<React.SetStateAction<string>>;
  commitRename: (entry: WorkspaceEntry) => void;
  handleRenameBlur: (entry: WorkspaceEntry) => () => void;
  handleRenameKeyDown: (event: React.KeyboardEvent<HTMLInputElement>) => void;
  handleEntryDragStart: (event: React.DragEvent<HTMLDivElement>, entry: WorkspaceEntry) => void;
  handleEntryDragEnd: () => void;
  handleDirectoryDragOver: (event: React.DragEvent<HTMLDivElement>, entry: WorkspaceEntry) => void;
  handleDirectoryDragLeave: (event: React.DragEvent<HTMLDivElement>, entry: WorkspaceEntry) => void;
  handleDirectoryDrop: (event: React.DragEvent<HTMLDivElement>, entry: WorkspaceEntry) => void;
  onContainerContextMenu: (event: React.MouseEvent) => void;
  onEntryContextMenu: (event: React.MouseEvent, entry: WorkspaceEntry) => void;
  handleEntryLongPressStart: (event: React.TouchEvent<HTMLDivElement>, entry: WorkspaceEntry) => void;
  handleEntryLongPressEnd: () => void;
  handleEntryClick: (event: React.MouseEvent, entry: WorkspaceEntry) => void;
  handleFileDoubleClick: (entry: WorkspaceEntry) => void;
  startRename: (entry: WorkspaceEntry) => void;
  toggleEntrySelection: (entry: WorkspaceEntry, selected?: boolean) => void;
  onMoreButtonClick: (event: React.MouseEvent, entry: WorkspaceEntry) => void;
}

export default function WorkspaceFileList({
  isPagePresentation,
  isPreviewPanelHidden,
  loading,
  listing,
  searchLoading,
  visibleEntries,
  isSearchMode,
  currentPath,
  selectedEntryCount,
  isSelectionActive,
  allVisibleEntriesSelected,
  selectedEntryPaths,
  preview,
  locale,
  renamingPath,
  renameDraft,
  renameSaving,
  renameInputRef,
  dragTargetPath,
  draggedEntryPaths,
  clipboard,
  isCoarsePointer,
  loadDirectory,
  selectAllVisibleEntries,
  clearSelection,
  handleBatchClipboard,
  handleBatchDelete,
  setRenameDraft,
  commitRename,
  handleRenameBlur,
  handleRenameKeyDown,
  handleEntryDragStart,
  handleEntryDragEnd,
  handleDirectoryDragOver,
  handleDirectoryDragLeave,
  handleDirectoryDrop,
  onContainerContextMenu,
  onEntryContextMenu,
  handleEntryLongPressStart,
  handleEntryLongPressEnd,
  handleEntryClick,
  handleFileDoubleClick,
  startRename,
  toggleEntrySelection,
  onMoreButtonClick,
}: WorkspaceFileListProps) {
  const { t } = useI18n();

  return (
    <section
      data-ripple-workspace-file-list="browser"
      className={
        isPagePresentation
          ? `flex min-h-0 flex-col overflow-hidden border-b border-[#DEE0E3]/70 bg-[#FFFFFF] lg:border-b-0 ${
              isPreviewPanelHidden ? "" : "lg:border-r"
            }`
          : "flex min-h-0 flex-col overflow-hidden border-b border-[#EFF0F1] bg-white"
      }
    >
      {!isPagePresentation && (
        <div className="flex items-center justify-between border-b border-[#EFF0F1] bg-white px-3 py-2">
          <span className={`tracking-wider text-[#646A73] uppercase ${TYPOGRAPHY_META_MEDIUM_CLASS}`}>
            {isSearchMode ? t("files.searchResults") : t("files.workspace")}
          </span>
          <div className="flex items-center gap-1">
            {searchLoading && <Loader2 size={13} className="shrink-0 animate-spin text-[#646A73]" />}
            {!isSearchMode && (listing?.parent_path || currentPath !== DEFAULT_WORKSPACE_PATH) && (
              <>
                {listing?.parent_path && (
                  <button
                    type="button"
                    data-ripple-files-action="parent-folder"
                    title={t("files.goToParentFolder")}
                    aria-label={t("files.goToParentFolder")}
                    onClick={() => loadDirectory(listing.parent_path || DEFAULT_WORKSPACE_PATH)}
                    className={`flex items-center gap-1 rounded-md border border-[#EFF0F1] bg-white px-2 py-1 text-[#646A73] hover:bg-[#F8F9FA] hover:text-[#1F2329] ${TYPOGRAPHY_MICRO_MEDIUM_CLASS}`}
                  >
                    <ArrowUp size={12} />
                    {t("files.up")}
                  </button>
                )}
                {currentPath !== DEFAULT_WORKSPACE_PATH && (
                  <button
                    type="button"
                    data-ripple-files-action="root-folder"
                    title={t("files.goToWorkspaceRoot")}
                    aria-label={t("files.goToWorkspaceRoot")}
                    onClick={() => loadDirectory(DEFAULT_WORKSPACE_PATH)}
                    className={`flex items-center gap-1 rounded-md border border-[#EFF0F1] bg-white px-2 py-1 text-[#646A73] hover:bg-[#F8F9FA] hover:text-[#1F2329] ${TYPOGRAPHY_MICRO_MEDIUM_CLASS}`}
                  >
                    <FolderRoot size={16} />
                    {t("files.root")}
                  </button>
                )}
              </>
            )}
          </div>
        </div>
      )}
      {isPagePresentation && searchLoading && visibleEntries.length > 0 && (
        <div className="flex h-[34px] items-center justify-end border-b border-[#DEE0E3]/60 px-3 text-[#646A73]">
          <Loader2 size={13} className="animate-spin" />
        </div>
      )}
      {isSelectionActive && (
        <div
          data-ripple-files-selection-bar
          data-ripple-files-selection-bottom-bar={isPagePresentation ? "true" : undefined}
          className={
            isPagePresentation
              ? `fixed right-3 bottom-[calc(84px+env(safe-area-inset-bottom)+8px)] left-3 z-30 grid gap-2 rounded-2xl border border-[#DEE0E3]/80 bg-white/94 px-3 py-2.5 text-[#2B2F36] shadow-[0_16px_38px_rgba(31,35,41,0.16)] backdrop-blur-2xl lg:static lg:rounded-none lg:border-x-0 lg:border-t-0 lg:border-b lg:bg-[#F8F9FA] lg:shadow-none ${TYPOGRAPHY_BODY_CLASS}`
              : `grid gap-2 border-b border-[#DEE0E3]/70 bg-[#F8F9FA] px-3 py-2.5 text-[#2B2F36] ${TYPOGRAPHY_BODY_CLASS}`
          }
        >
          <div
            data-ripple-files-selection-status-row
            className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center sm:justify-between"
          >
            <span className="min-w-0 leading-8 font-semibold">
              {t("files.selectedCount", { count: selectedEntryCount })}
            </span>
            <div
              data-ripple-files-selection-choice-actions
              className="flex min-w-0 items-center gap-2 overflow-x-auto overscroll-x-contain pb-0.5 [scrollbar-width:none] sm:justify-end"
            >
              <button
                type="button"
                onClick={selectAllVisibleEntries}
                disabled={allVisibleEntriesSelected}
                className={`inline-flex h-8 shrink-0 items-center justify-center rounded-full border border-[#DEE0E3] bg-white px-3 hover:bg-[#F8F9FA] disabled:cursor-not-allowed disabled:opacity-50 ${TYPOGRAPHY_META_MEDIUM_CLASS}`}
              >
                {t("files.selectAll")}
              </button>
              <button
                type="button"
                onClick={clearSelection}
                className={`inline-flex h-8 shrink-0 items-center justify-center rounded-full border border-[#DEE0E3] bg-white px-3 hover:bg-[#F8F9FA] ${TYPOGRAPHY_META_MEDIUM_CLASS}`}
              >
                {t("files.clearSelection")}
              </button>
            </div>
          </div>
          <div
            data-ripple-files-selection-batch-actions
            className="flex min-w-0 items-center gap-2 overflow-x-auto overscroll-x-contain pb-0.5 [scrollbar-width:none]"
          >
            <button
              type="button"
              onClick={() => handleBatchClipboard("copy")}
              disabled={selectedEntryCount === 0}
              className={`inline-flex h-8 shrink-0 items-center justify-center gap-1 rounded-full border border-[#DEE0E3] bg-white px-3 hover:bg-[#F8F9FA] disabled:cursor-not-allowed disabled:opacity-50 ${TYPOGRAPHY_META_MEDIUM_CLASS}`}
            >
              <Copy size={12} />
              {t("files.copy")}
            </button>
            <button
              type="button"
              onClick={() => handleBatchClipboard("move")}
              disabled={selectedEntryCount === 0}
              className={`inline-flex h-8 shrink-0 items-center justify-center gap-1 rounded-full border border-[#DEE0E3] bg-white px-3 hover:bg-[#F8F9FA] disabled:cursor-not-allowed disabled:opacity-50 ${TYPOGRAPHY_META_MEDIUM_CLASS}`}
            >
              <Scissors size={12} />
              {t("files.move")}
            </button>
            <button
              type="button"
              onClick={() => handleBatchDelete()}
              disabled={selectedEntryCount === 0}
              className={`inline-flex h-8 shrink-0 items-center justify-center gap-1 rounded-full border border-[#B42318]/25 bg-white px-3 text-[#B42318] hover:bg-[#FFF1F0] disabled:cursor-not-allowed disabled:opacity-50 ${TYPOGRAPHY_META_MEDIUM_CLASS}`}
            >
              <Trash2 size={12} />
              {t("files.delete")}
            </button>
          </div>
        </div>
      )}
      <div
        onContextMenu={onContainerContextMenu}
        className={
          isPagePresentation
            ? "context-trigger-area min-h-0 flex-1 overflow-y-auto p-2 pb-10"
            : "context-trigger-area min-h-0 flex-1 overflow-y-auto pb-10"
        }
      >
        {(loading && !listing) || (searchLoading && visibleEntries.length === 0) ? (
          <div className={`flex h-40 items-center justify-center gap-2 text-[#646A73] ${TYPOGRAPHY_BODY_MEDIUM_CLASS}`}>
            <Loader2 size={16} className="animate-spin" />
            {t("files.loading")}
          </div>
        ) : (listing || isSearchMode) && visibleEntries.length === 0 ? (
          <div
            className={`flex h-40 items-center justify-center px-4 text-center text-[#646A73] ${TYPOGRAPHY_BODY_MEDIUM_CLASS}`}
          >
            {isSearchMode ? t("files.noMatchingFiles") : t("files.emptyWorkspace")}
          </div>
        ) : (
          <div>
            {visibleEntries.map((entry) =>
              renamingPath === entry.path ? (
                <form
                  key={entry.path}
                  onSubmit={(event) => {
                    event.preventDefault();
                    commitRename(entry);
                  }}
                  className={
                    isPagePresentation
                      ? `mb-1 grid min-h-10 w-full grid-cols-[20px_minmax(0,1fr)_auto] items-center gap-2 rounded-xl px-2 py-1.5 text-left ${
                          preview?.path === entry.path ? "bg-[#F0F5FF]" : "bg-transparent"
                        }`
                      : `flex w-full items-center gap-2.5 px-3 py-1.5 text-left ${
                          preview?.path === entry.path ? "bg-[#F0F5FF]" : "bg-white"
                        }`
                  }
                >
                  <IconTile tone={entry.kind === "directory" ? "accent" : "neutral"} size="xs">
                    {entry.kind === "directory" ? <Folder size={14} /> : <FileText size={14} />}
                  </IconTile>
                  <span className="min-w-0 flex-1">
                    <input
                      ref={renameInputRef}
                      value={renameDraft}
                      onChange={(event) => setRenameDraft(event.target.value)}
                      onBlur={handleRenameBlur(entry)}
                      onKeyDown={handleRenameKeyDown}
                      disabled={renameSaving}
                      spellCheck={false}
                      className={`h-10 w-full rounded-lg border border-[#1456F0] bg-white px-2 font-[family-name:var(--font-mono)] text-[#1F2329] outline-none lg:h-8 lg:text-[14px] lg:leading-[22px] ${TYPOGRAPHY_MOBILE_BODY_CLASS}`}
                    />
                    <WorkspaceEntryMeta
                      entry={entry}
                      isSearchMode={isSearchMode}
                      locale={locale}
                    />
                  </span>
                  {renameSaving && <Loader2 size={13} className="shrink-0 animate-spin" />}
                </form>
              ) : (
                <div
                  key={entry.path}
                  draggable={!isCoarsePointer}
                  data-ripple-files-drop-target={entry.kind === "directory" ? "directory" : undefined}
                  onDragStart={(event) => handleEntryDragStart(event, entry)}
                  onDragEnd={handleEntryDragEnd}
                  onDragOver={
                    entry.kind === "directory"
                      ? (event) => handleDirectoryDragOver(event, entry)
                      : undefined
                  }
                  onDragLeave={
                    entry.kind === "directory"
                      ? (event) => handleDirectoryDragLeave(event, entry)
                      : undefined
                  }
                  onDrop={
                    entry.kind === "directory"
                      ? (event) => handleDirectoryDrop(event, entry)
                      : undefined
                  }
                  onContextMenu={(event) => onEntryContextMenu(event, entry)}
                  onTouchStart={(event) => handleEntryLongPressStart(event, entry)}
                  onTouchEnd={handleEntryLongPressEnd}
                  onTouchCancel={handleEntryLongPressEnd}
                  className={
                    isPagePresentation
                      ? `group mb-1 grid min-h-10 w-full ${
                          isSelectionActive
                            ? "grid-cols-[28px_minmax(0,1fr)_auto]"
                            : "grid-cols-[minmax(0,1fr)_auto]"
                        } items-center rounded-xl transition-colors hover:bg-[#F8F9FA] ${
                          selectedEntryPaths.has(entry.path)
                            ? "bg-[#eaf2ff] shadow-[inset_0_0_0_1px_rgba(20,86,240,0.14)]"
                            : preview?.path === entry.path
                              ? "bg-[#F0F5FF] shadow-[inset_0_0_0_1px_rgba(20,86,240,0.08)]"
                              : "bg-transparent"
                        } ${
                          dragTargetPath === entry.path
                            ? "bg-[#F0F5FF] shadow-[inset_0_0_0_2px_rgba(20,86,240,0.24)]"
                            : ""
                        } ${draggedEntryPaths.has(entry.path) ? "opacity-45" : ""} ${
                          clipboard?.action === "move" &&
                          clipboard?.items.some((item) => item.path === entry.path)
                            ? "opacity-35 select-none"
                            : ""
                        }`
                      : `group flex w-full items-center transition-colors hover:bg-[#F8F9FA] ${
                          selectedEntryPaths.has(entry.path)
                            ? "bg-[#eaf2ff]"
                            : preview?.path === entry.path
                              ? "bg-[#F0F5FF]"
                              : "bg-white"
                        } ${dragTargetPath === entry.path ? "bg-[#F0F5FF]" : ""} ${
                          draggedEntryPaths.has(entry.path) ? "opacity-45" : ""
                        } ${
                          clipboard?.action === "move" &&
                          clipboard?.items.some((item) => item.path === entry.path)
                            ? "opacity-35 select-none"
                            : ""
                        }`
                  }
                >
                  {isSelectionActive ? (
                    <label
                      className={
                        isPagePresentation
                          ? "flex h-full items-center justify-center pl-2"
                          : "flex h-full items-center justify-center pl-3"
                      }
                      onClick={(event) => event.stopPropagation()}
                    >
                      <input
                        type="checkbox"
                        data-ripple-files-select-entry
                        checked={selectedEntryPaths.has(entry.path)}
                        aria-label={t("files.selectEntry", { name: entry.name })}
                        onChange={(event) => toggleEntrySelection(entry, event.target.checked)}
                        className="h-4 w-4 rounded border-[#D0D3D6] text-[#1456F0] accent-[#1456F0]"
                      />
                    </label>
                  ) : null}
                  <button
                    type="button"
                    onClick={(event) => handleEntryClick(event, entry)}
                    onDoubleClick={() => handleFileDoubleClick(entry)}
                    onKeyDown={(event) => {
                      if (event.key === "F2") {
                        event.preventDefault();
                        startRename(entry);
                      }
                    }}
                    className={
                      isPagePresentation
                        ? "flex min-w-0 items-center gap-2.5 px-2 py-2 text-left"
                        : "flex min-w-0 flex-1 items-center gap-2.5 px-3 py-2 text-left"
                    }
                  >
                    <IconTile tone={entry.kind === "directory" ? "accent" : "neutral"} size="xs">
                      {entry.kind === "directory" ? <Folder size={14} /> : <FileText size={14} />}
                    </IconTile>
                    <span className="min-w-0 flex-1">
                      <span
                        className={`block truncate font-[family-name:var(--font-mono)] text-[#1F2329] ${TYPOGRAPHY_BODY_MEDIUM_CLASS} ${
                          entry.is_hidden ? "opacity-55" : ""
                        }`}
                      >
                        {entry.name}
                      </span>
                      <WorkspaceEntryMeta
                        entry={entry}
                        isSearchMode={isSearchMode}
                        locale={locale}
                      />
                    </span>
                  </button>
                  <button
                    type="button"
                    aria-label={t("files.moreActionsFor", { name: entry.name })}
                    title={t("files.moreActions")}
                    onClick={(event) => onMoreButtonClick(event, entry)}
                    className={
                      isPagePresentation
                        ? "mr-2 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-transparent text-[#646A73] opacity-100 transition-opacity hover:border-[#DEE0E3] hover:bg-white/78 hover:text-[#1F2329] focus:opacity-100 sm:h-7 sm:w-7 sm:opacity-0 sm:group-hover:opacity-100"
                        : "mr-2 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-transparent text-[#646A73] opacity-100 transition-opacity hover:border-[#DEE0E3] hover:bg-white hover:text-[#1F2329] focus:opacity-100 sm:h-7 sm:w-7 sm:opacity-0 sm:group-hover:opacity-100"
                    }
                  >
                    <MoreHorizontal size={14} />
                  </button>
                </div>
              )
            )}
          </div>
        )}
      </div>
    </section>
  );
}

function WorkspaceEntryMeta({
  entry,
  isSearchMode,
  locale,
}: {
  entry: WorkspaceEntry;
  isSearchMode: boolean;
  locale: string;
}) {
  const { t } = useI18n();
  if (isSearchMode) return <SearchResultMeta entry={entry} />;

  return (
    <span
      className={`mt-0.5 block truncate font-[family-name:var(--font-mono)] text-[#646A73] ${TYPOGRAPHY_META_CLASS}`}
    >
      {`${entry.kind === "directory" ? t("files.folder") : formatBytes(entry.size_bytes)}${
        formatModified(entry.modified_at, locale) ? ` · ${formatModified(entry.modified_at, locale)}` : ""
      }`}
    </span>
  );
}
