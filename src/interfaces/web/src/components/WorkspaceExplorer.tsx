"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowUp,
  ChevronDown,
  Edit3,
  Eye,
  FileText,
  Folder,
  Loader2,
  RefreshCw,
  Save,
  Search,
  SlidersHorizontal,
  Undo2,
} from "lucide-react";
import {
  fetchWorkspaceFilePreview,
  fetchWorkspaceListing,
  renameWorkspaceEntry,
  saveWorkspaceFile,
  searchWorkspaceFiles,
  type WorkspaceSearchOptions,
} from "@/lib/api";
import { WorkspaceEntry, WorkspaceFilePreview, WorkspaceListing } from "@/types";

interface WorkspaceExplorerProps {
  userId: string;
  refreshToken: number;
}

const SPLIT_PERCENT_STORAGE_KEY = "ripple.workspaceExplorer.splitPercent";
const DEFAULT_SPLIT_PERCENT = 48;
const MIN_SPLIT_PERCENT = 0;
const MAX_SPLIT_PERCENT = 100;

export function getBoundedSplitPercent(value: number): number {
  return Math.min(MAX_SPLIT_PERCENT, Math.max(MIN_SPLIT_PERCENT, Math.round(value)));
}

export function getSplitPercentAfterFileDoubleClick(currentSplitPercent: number): number {
  return currentSplitPercent >= MAX_SPLIT_PERCENT ? DEFAULT_SPLIT_PERCENT : currentSplitPercent;
}

function initialSplitPercent(): number {
  if (typeof window === "undefined") return DEFAULT_SPLIT_PERCENT;
  const rawValue = window.localStorage.getItem(SPLIT_PERCENT_STORAGE_KEY);
  if (rawValue === null) return DEFAULT_SPLIT_PERCENT;
  const stored = Number(rawValue);
  return Number.isFinite(stored) ? getBoundedSplitPercent(stored) : DEFAULT_SPLIT_PERCENT;
}

function sortWorkspaceEntries(entries: WorkspaceEntry[]): WorkspaceEntry[] {
  return [...entries].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "directory" ? -1 : 1;
    return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
  });
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function formatModified(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString([], {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function displayError(error: string): string {
  if (
    error.includes("Failed to rename entry (404)") ||
    error.includes("File or folder no longer exists")
  ) {
    return "File or folder no longer exists. Refresh workspace.";
  }
  if (error.includes("(404)")) return "Workspace is not ready for this user.";
  if (error.includes("(415)")) return "This file cannot be previewed as text.";
  if (error.includes("(403)")) return "Access denied for this path.";
  return error;
}

export default function WorkspaceExplorer({ userId, refreshToken }: WorkspaceExplorerProps) {
  const [currentPath, setCurrentPath] = useState("/workspace");
  const [listing, setListing] = useState<WorkspaceListing | null>(null);
  const [preview, setPreview] = useState<WorkspaceFilePreview | null>(null);
  const [draft, setDraft] = useState("");
  const [isEditing, setIsEditing] = useState(false);
  const [loading, setLoading] = useState(false);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [query, setQuery] = useState("");
  const [searchResults, setSearchResults] = useState<WorkspaceEntry[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [isFilterOpen, setIsFilterOpen] = useState(false);
  const [searchScope, setSearchScope] =
    useState<NonNullable<WorkspaceSearchOptions["scope"]>>("all");
  const [searchKind, setSearchKind] = useState<NonNullable<WorkspaceSearchOptions["kind"]>>("all");
  const [fileType, setFileType] = useState<NonNullable<WorkspaceSearchOptions["fileType"]>>("all");
  const [includeHidden, setIncludeHidden] = useState(false);
  const [searchLimit, setSearchLimit] = useState(50);
  const [error, setError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [renamingPath, setRenamingPath] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [renameSaving, setRenameSaving] = useState(false);
  const [splitPercent, setSplitPercent] = useState(initialSplitPercent);
  const splitPercentRef = useRef(splitPercent);
  const splitContainerRef = useRef<HTMLDivElement | null>(null);
  const renameInputRef = useRef<HTMLInputElement | null>(null);
  const renameCommitKeyRef = useRef<string | null>(null);
  const isDirty = useMemo(() => Boolean(preview && draft !== preview.content), [draft, preview]);
  const normalizedQuery = query.trim();
  const isSearchMode = normalizedQuery.length > 0;
  const visibleEntries = isSearchMode ? searchResults : listing?.entries || [];

  useEffect(() => {
    splitPercentRef.current = splitPercent;
    window.localStorage.setItem(SPLIT_PERCENT_STORAGE_KEY, String(splitPercent));
  }, [splitPercent]);

  useEffect(() => {
    if (!renamingPath) return;
    queueMicrotask(() => {
      renameInputRef.current?.focus();
      renameInputRef.current?.select();
    });
  }, [renamingPath]);

  const updateSplitPercent = useCallback((value: number) => {
    setSplitPercent(getBoundedSplitPercent(value));
  }, []);

  const handleSplitResizeStart = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      const containerHeight = splitContainerRef.current?.getBoundingClientRect().height || 0;
      if (containerHeight <= 0) return;

      const startY = event.clientY;
      const startPercent = splitPercentRef.current;

      const handlePointerMove = (moveEvent: PointerEvent) => {
        updateSplitPercent(startPercent + ((moveEvent.clientY - startY) / containerHeight) * 100);
      };
      const handlePointerUp = () => {
        window.removeEventListener("pointermove", handlePointerMove);
        window.removeEventListener("pointerup", handlePointerUp);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
      };

      document.body.style.cursor = "row-resize";
      document.body.style.userSelect = "none";
      window.addEventListener("pointermove", handlePointerMove);
      window.addEventListener("pointerup", handlePointerUp);
    },
    [updateSplitPercent]
  );

  const handleSplitResizeKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key === "ArrowUp") {
        event.preventDefault();
        updateSplitPercent(splitPercentRef.current - (event.shiftKey ? 8 : 3));
      }
      if (event.key === "ArrowDown") {
        event.preventDefault();
        updateSplitPercent(splitPercentRef.current + (event.shiftKey ? 8 : 3));
      }
    },
    [updateSplitPercent]
  );

  const loadDirectory = useCallback(async (path: string) => {
    setLoading(true);
    setError(null);
    try {
      const data = await fetchWorkspaceListing(path);
      setListing(data);
      setCurrentPath(data.path);
      setPreview(null);
      setDraft("");
      setIsEditing(false);
      setSaveError(null);
      setRenamingPath(null);
      setRenameDraft("");
      setRenameSaving(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    queueMicrotask(() => {
      void loadDirectory("/workspace");
    });
  }, [loadDirectory, userId]);

  useEffect(() => {
    queueMicrotask(() => {
      void loadDirectory(currentPath);
    });
  }, [currentPath, loadDirectory, refreshToken]);

  useEffect(() => {
    if (!normalizedQuery) return;

    let cancelled = false;
    const timer = window.setTimeout(() => {
      setSearchLoading(true);
      setSearchError(null);
      searchWorkspaceFiles(normalizedQuery, {
        limit: searchLimit,
        scope: searchScope,
        kind: searchKind,
        fileType,
        includeHidden,
      })
        .then((entries) => {
          if (!cancelled) setSearchResults(entries);
        })
        .catch((err) => {
          if (!cancelled) {
            setSearchResults([]);
            setSearchError(err instanceof Error ? err.message : String(err));
          }
        })
        .finally(() => {
          if (!cancelled) setSearchLoading(false);
        });
    }, 200);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [fileType, includeHidden, normalizedQuery, searchKind, searchLimit, searchScope]);

  const openEntry = async (entry: WorkspaceEntry) => {
    if (entry.kind === "directory") {
      await loadDirectory(entry.path);
      return;
    }
    setPreviewLoading(true);
    setError(null);
    try {
      const filePreview = await fetchWorkspaceFilePreview(entry.path, 256 * 1024);
      setPreview(filePreview);
      setDraft(filePreview.content);
      setIsEditing(false);
      setSaveError(null);
    } catch (err) {
      setPreview(null);
      setDraft("");
      setIsEditing(false);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPreviewLoading(false);
    }
  };

  const startRename = (entry: WorkspaceEntry) => {
    setRenamingPath(entry.path);
    setRenameDraft(entry.name);
    setError(null);
    renameCommitKeyRef.current = null;
  };

  const cancelRename = () => {
    setRenamingPath(null);
    setRenameDraft("");
    setRenameSaving(false);
    renameCommitKeyRef.current = null;
  };

  const commitRename = async (entry: WorkspaceEntry) => {
    if (renameSaving) return;
    const nextName = renameDraft.trim();
    if (!nextName || nextName === entry.name) {
      cancelRename();
      return;
    }

    const commitKey = `${entry.path}\n${nextName}`;
    if (renameCommitKeyRef.current === commitKey) return;
    renameCommitKeyRef.current = commitKey;

    setRenameSaving(true);
    setError(null);
    try {
      const renamed = await renameWorkspaceEntry(entry.path, nextName);
      setListing((current) => {
        if (!current) return current;
        return {
          ...current,
          entries: sortWorkspaceEntries(
            current.entries.map((item) => (item.path === entry.path ? renamed : item))
          ),
        };
      });
      setSearchResults((current) =>
        current.map((item) => (item.path === entry.path ? renamed : item))
      );
      setPreview((current) =>
        current?.path === entry.path
          ? { ...current, path: renamed.path, name: renamed.name, modified_at: renamed.modified_at }
          : current
      );
      setRenamingPath(null);
      setRenameDraft("");
    } catch (err) {
      renameCommitKeyRef.current = null;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRenameSaving(false);
    }
  };

  const handleRenameBlur = (entry: WorkspaceEntry) => () => {
    void commitRename(entry);
  };

  const handleRenameKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      cancelRename();
    }
  };

  const handleSave = async () => {
    if (!preview || saving || !isDirty || preview.truncated) return;
    setSaving(true);
    setSaveError(null);
    try {
      const saved = await saveWorkspaceFile(preview.path, draft, preview.modified_at);
      setPreview(saved);
      setDraft(saved.content);
      setIsEditing(false);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const handleRevert = () => {
    if (!preview) return;
    setDraft(preview.content);
    setSaveError(null);
  };
  const handleQueryChange = (value: string) => {
    setQuery(value);
    if (!value.trim()) {
      setSearchResults([]);
      setSearchError(null);
      setSearchLoading(false);
    }
  };
  const handleFileDoubleClick = (entry: WorkspaceEntry) => {
    if (entry.kind !== "file") return;
    setSplitPercent((current) => getSplitPercentAfterFileDoubleClick(current));
    void openEntry(entry);
  };
  const isPreviewPanelHidden = splitPercent >= MAX_SPLIT_PERCENT;
  const splitGridTemplateRows = isPreviewPanelHidden
    ? "minmax(0,1fr) 0px"
    : `minmax(0,${splitPercent}%) minmax(0,1fr)`;

  return (
    <div className="flex h-full flex-col overflow-hidden bg-white text-[#0d0d0d]">
      <div className="shrink-0 border-b border-[#e5e7eb] bg-white px-4 py-3">
        <div className="mb-2 flex items-center gap-2">
          <div className="relative min-w-0 flex-1">
            <Search
              size={14}
              className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-[#8b8f94]"
            />
            <input
              value={query}
              onChange={(event) => handleQueryChange(event.target.value)}
              placeholder="Find in workspace..."
              className="h-8 w-full rounded-md border border-[#e5e7eb] bg-white pr-2 pl-8 text-sm text-[#0d0d0d] outline-none placeholder:text-[#8b8f94] focus:border-[#2463eb]"
            />
          </div>
          <button
            type="button"
            className={`inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md border ${
              isFilterOpen
                ? "border-[#2463eb] bg-[#eef4ff] text-[#0b57d0]"
                : "border-[#e5e7eb] bg-white text-[#6b7280] hover:bg-[#f7f8fa] hover:text-[#0d0d0d]"
            }`}
            title="Search filters"
            aria-label="Search filters"
            onClick={() => setIsFilterOpen((open) => !open)}
          >
            <SlidersHorizontal size={14} />
          </button>
        </div>
        {isFilterOpen && (
          <div className="mb-2 grid gap-2 rounded-md border border-[#e5e7eb] bg-[#fbfbfc] p-2 text-xs text-[#374151] sm:grid-cols-2">
            <label className="flex items-center gap-2">
              <span className="w-16 text-[#6b7280]">Scope</span>
              <select
                value={searchScope}
                onChange={(event) =>
                  setSearchScope(event.target.value as NonNullable<WorkspaceSearchOptions["scope"]>)
                }
                className="h-7 min-w-0 flex-1 rounded border border-[#d7dce3] bg-white px-2 text-xs"
              >
                <option value="all">Name and content</option>
                <option value="name">Name/path</option>
                <option value="content">Content</option>
              </select>
            </label>
            <label className="flex items-center gap-2">
              <span className="w-16 text-[#6b7280]">Kind</span>
              <select
                value={searchKind}
                onChange={(event) =>
                  setSearchKind(event.target.value as NonNullable<WorkspaceSearchOptions["kind"]>)
                }
                className="h-7 min-w-0 flex-1 rounded border border-[#d7dce3] bg-white px-2 text-xs"
              >
                <option value="all">Files and folders</option>
                <option value="file">Files</option>
                <option value="directory">Folders</option>
              </select>
            </label>
            <label className="flex items-center gap-2">
              <span className="w-16 text-[#6b7280]">Type</span>
              <select
                value={fileType}
                onChange={(event) =>
                  setFileType(event.target.value as NonNullable<WorkspaceSearchOptions["fileType"]>)
                }
                className="h-7 min-w-0 flex-1 rounded border border-[#d7dce3] bg-white px-2 text-xs"
              >
                <option value="all">All types</option>
                <option value="code">Code</option>
                <option value="markdown">Markdown</option>
                <option value="text">Text</option>
                <option value="image">Images</option>
              </select>
            </label>
            <label className="flex items-center gap-2">
              <span className="w-16 text-[#6b7280]">Results</span>
              <select
                value={searchLimit}
                onChange={(event) => setSearchLimit(Number(event.target.value))}
                className="h-7 min-w-0 flex-1 rounded border border-[#d7dce3] bg-white px-2 text-xs"
              >
                <option value={20}>20</option>
                <option value={50}>50</option>
              </select>
            </label>
            <label className="flex items-center gap-2 sm:col-span-2">
              <input
                type="checkbox"
                checked={includeHidden}
                onChange={(event) => setIncludeHidden(event.target.checked)}
              />
              <span>Include hidden files</span>
            </label>
          </div>
        )}
        <div className="flex items-center justify-between gap-2">
          <p className="min-w-0 truncate font-[family-name:var(--font-mono)] text-[11px] text-[#6b7280]">
            {isSearchMode ? "Search in /workspace" : listing?.path || currentPath}
          </p>
          <button
            type="button"
            onClick={() => void loadDirectory(currentPath)}
            className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-transparent text-[#6b7280] hover:border-[#e5e7eb] hover:bg-[#f7f8fa] hover:text-[#0d0d0d]"
            title="Refresh workspace"
            disabled={loading}
          >
            {loading ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
          </button>
        </div>
      </div>

      {error && (
        <div className="m-4 mb-0 flex items-start gap-2 rounded-md border border-[#cf222e]/25 bg-[#ffebe9] p-3 text-xs font-medium text-[#cf222e]">
          <AlertTriangle size={14} className="mt-0.5 shrink-0" />
          <span className="break-words">{displayError(error)}</span>
        </div>
      )}
      {searchError && (
        <div className="m-4 mb-0 flex items-start gap-2 rounded-md border border-[#cf222e]/25 bg-[#ffebe9] p-3 text-xs font-medium text-[#cf222e]">
          <AlertTriangle size={14} className="mt-0.5 shrink-0" />
          <span className="break-words">{displayError(searchError)}</span>
        </div>
      )}

      <div
        ref={splitContainerRef}
        className="grid min-h-0 flex-1"
        style={{ gridTemplateRows: splitGridTemplateRows }}
      >
        <div className="min-h-0 overflow-hidden border-b border-[#e5e7eb] bg-white">
          <div className="flex items-center justify-between border-b border-[#e5e7eb] bg-white px-3 py-2">
            <span className="text-xs font-semibold tracking-wider text-[#6b7280] uppercase">
              {isSearchMode ? "Search results" : "Workspace"}
            </span>
            <div className="flex items-center gap-1">
              {searchLoading && <Loader2 size={13} className="animate-spin text-[#6b7280]" />}
              {isPreviewPanelHidden && (
                <button
                  type="button"
                  aria-label="Show preview panel"
                  title="Show preview"
                  onClick={() => updateSplitPercent(DEFAULT_SPLIT_PERCENT)}
                  className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-[#e5e7eb] bg-white text-[#6b7280] hover:bg-[#f7f8fa] hover:text-[#0d0d0d]"
                >
                  <Eye size={13} />
                </button>
              )}
              {!isSearchMode && listing?.parent_path && (
                <button
                  type="button"
                  onClick={() => void loadDirectory(listing.parent_path || "/workspace")}
                  className="flex items-center gap-1 rounded-md border border-[#e5e7eb] bg-white px-2 py-1 text-[11px] font-medium text-[#6b7280] hover:bg-[#f7f8fa] hover:text-[#0d0d0d]"
                >
                  <ArrowUp size={12} />
                  Up
                </button>
              )}
            </div>
          </div>
          <div className="h-full overflow-y-auto pb-10">
            {(loading && !listing) || (searchLoading && visibleEntries.length === 0) ? (
              <div className="flex h-40 items-center justify-center gap-2 text-sm font-medium text-[#68707d]">
                <Loader2 size={16} className="animate-spin" />
                Loading
              </div>
            ) : (listing || isSearchMode) && visibleEntries.length === 0 ? (
              <div className="flex h-40 items-center justify-center px-4 text-center text-sm font-medium text-[#6b7280]">
                {isSearchMode ? "No matching files" : "Empty workspace"}
              </div>
            ) : (
              <div>
                {visibleEntries.map((entry) =>
                  renamingPath === entry.path ? (
                    <form
                      key={entry.path}
                      onSubmit={(event) => {
                        event.preventDefault();
                        void commitRename(entry);
                      }}
                      className={`flex w-full items-center gap-2.5 px-3 py-1.5 text-left ${
                        preview?.path === entry.path ? "bg-[#eef4ff]" : "bg-white"
                      }`}
                    >
                      <span
                        className={`flex h-5 w-5 shrink-0 items-center justify-center text-[#374151] ${
                          entry.kind === "directory" ? "bg-[#f7f8fa]" : "bg-white"
                        }`}
                      >
                        {entry.kind === "directory" ? <Folder size={14} /> : <FileText size={14} />}
                      </span>
                      <span className="min-w-0 flex-1">
                        <input
                          ref={renameInputRef}
                          value={renameDraft}
                          onChange={(event) => setRenameDraft(event.target.value)}
                          onBlur={handleRenameBlur(entry)}
                          onKeyDown={handleRenameKeyDown}
                          disabled={renameSaving}
                          spellCheck={false}
                          className="h-7 w-full rounded-md border border-[#2463eb] bg-white px-2 font-[family-name:var(--font-mono)] text-[13px] font-medium text-[#0d0d0d] outline-none"
                        />
                        <span className="mt-0.5 block truncate font-[family-name:var(--font-mono)] text-[10px] text-[#6b7280]">
                          {isSearchMode
                            ? entry.path
                            : `${entry.kind === "directory" ? "folder" : formatBytes(entry.size_bytes)}${
                                formatModified(entry.modified_at)
                                  ? ` · ${formatModified(entry.modified_at)}`
                                  : ""
                              }`}
                        </span>
                      </span>
                      {renameSaving && <Loader2 size={13} className="shrink-0 animate-spin" />}
                    </form>
                  ) : (
                    <div
                      key={entry.path}
                      className={`group flex w-full items-center transition-colors hover:bg-[#f7f8fa] ${
                        preview?.path === entry.path ? "bg-[#eef4ff]" : "bg-white"
                      }`}
                    >
                      <button
                        type="button"
                        onClick={() => void openEntry(entry)}
                        onDoubleClick={() => handleFileDoubleClick(entry)}
                        onKeyDown={(event) => {
                          if (event.key === "F2") {
                            event.preventDefault();
                            startRename(entry);
                          }
                        }}
                        className="flex min-w-0 flex-1 items-center gap-2.5 px-3 py-2 text-left"
                      >
                        <span
                          className={`flex h-5 w-5 shrink-0 items-center justify-center text-[#374151] ${
                            entry.kind === "directory" ? "bg-[#f7f8fa]" : "bg-white"
                          }`}
                        >
                          {entry.kind === "directory" ? (
                            <Folder size={14} />
                          ) : (
                            <FileText size={14} />
                          )}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span
                            className={`block truncate font-[family-name:var(--font-mono)] text-[13px] font-medium text-[#0d0d0d] ${
                              entry.is_hidden ? "opacity-55" : ""
                            }`}
                          >
                            {entry.name}
                          </span>
                          <span className="mt-0.5 block truncate font-[family-name:var(--font-mono)] text-[10px] text-[#6b7280]">
                            {isSearchMode
                              ? entry.path
                              : `${entry.kind === "directory" ? "folder" : formatBytes(entry.size_bytes)}${
                                  formatModified(entry.modified_at)
                                    ? ` · ${formatModified(entry.modified_at)}`
                                    : ""
                                }`}
                          </span>
                        </span>
                      </button>
                      <button
                        type="button"
                        aria-label={`Rename ${entry.name}`}
                        title="Rename"
                        onClick={() => startRename(entry)}
                        className="mr-2 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-transparent text-[#6b7280] opacity-0 transition-opacity group-hover:opacity-100 hover:border-[#dde2ea] hover:bg-white hover:text-[#0d0d0d] focus:opacity-100"
                      >
                        <Edit3 size={12} />
                      </button>
                    </div>
                  )
                )}
              </div>
            )}
          </div>
        </div>

        {!isPreviewPanelHidden && (
          <div className="relative flex min-h-0 flex-col overflow-hidden bg-white">
            <div
              role="separator"
              aria-label="Resize workspace split"
              aria-orientation="horizontal"
              aria-valuemin={MIN_SPLIT_PERCENT}
              aria-valuemax={MAX_SPLIT_PERCENT}
              aria-valuenow={splitPercent}
              aria-valuetext={`${splitPercent}%`}
              tabIndex={0}
              onPointerDown={handleSplitResizeStart}
              onKeyDown={handleSplitResizeKeyDown}
              className="group absolute top-0 right-0 left-0 z-20 flex h-2 -translate-y-1/2 cursor-row-resize items-center justify-center bg-transparent transition-colors outline-none hover:bg-[#dbe6ff] focus:bg-[#dbe6ff]"
            >
              <span className="h-0.5 w-12 rounded-full bg-[#2463eb] opacity-0 transition-opacity group-hover:opacity-100 group-focus:opacity-100" />
            </div>
            <div className="flex shrink-0 items-center gap-2 border-b border-[#e5e7eb] bg-white px-3 py-2 text-[#6b7280]">
              <FileText size={13} />
              <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-[#0d0d0d]">
                {preview?.path || "Select a file"}
              </span>
              {previewLoading && <Loader2 size={12} className="animate-spin" />}
              {preview && (
                <div className="flex shrink-0 items-center gap-1">
                  <button
                    type="button"
                    disabled={preview.truncated}
                    onClick={() => setIsEditing((current) => !current)}
                    className={`inline-flex h-7 items-center gap-1 rounded-md border px-2 text-xs font-medium ${
                      isEditing
                        ? "border-[#171a1f] bg-white text-[#171a1f]"
                        : "border-[#dde2ea] bg-white text-[#68707d] hover:bg-[#f7f8fa] disabled:cursor-not-allowed disabled:text-[#8b8f94]"
                    }`}
                    title={preview.truncated ? "Truncated files cannot be edited safely" : "Edit"}
                  >
                    <Edit3 size={12} />
                    Edit
                  </button>
                </div>
              )}
              <button
                type="button"
                aria-label="Collapse preview panel"
                title="Collapse panel"
                onClick={() => updateSplitPercent(MAX_SPLIT_PERCENT)}
                className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-[#dde2ea] bg-white text-[#68707d] hover:bg-[#f7f8fa] hover:text-[#0d0d0d]"
              >
                <ChevronDown size={13} />
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-auto bg-white">
              {preview ? (
                <div className="flex min-h-full flex-col">
                  <div className="flex flex-wrap items-center gap-2 border-b border-[#dde2ea] px-3 py-2 font-[family-name:var(--font-mono)] text-[11px] font-medium text-[#68707d]">
                    <span>{formatBytes(preview.size_bytes)}</span>
                    <span>{preview.mime_type}</span>
                    <span>{formatModified(preview.modified_at)}</span>
                    {isDirty && (
                      <span className="rounded-full border border-[#0969da]/25 bg-[#ddf4ff] px-1.5 py-0.5 text-[10px] text-[#0969da] uppercase">
                        unsaved
                      </span>
                    )}
                    {preview.truncated && (
                      <span className="rounded-full border border-[#bf8700]/35 bg-[#fff8c5] px-1.5 py-0.5 text-[10px] text-[#7d4e00] uppercase">
                        truncated
                      </span>
                    )}
                    {isEditing && (
                      <div className="ml-auto flex items-center gap-1">
                        <button
                          type="button"
                          onClick={handleRevert}
                          disabled={!isDirty || saving}
                          className="inline-flex h-7 items-center gap-1 rounded-md border border-[#dde2ea] bg-white px-2 text-xs font-medium text-[#68707d] hover:bg-[#f7f8fa] disabled:cursor-not-allowed disabled:text-[#8b8f94]"
                        >
                          <Undo2 size={12} />
                          Revert
                        </button>
                        <button
                          type="button"
                          onClick={() => void handleSave()}
                          disabled={!isDirty || saving || preview.truncated}
                          className="inline-flex h-7 items-center gap-1 rounded-md border border-[#171a1f] bg-[#171a1f] px-2 text-xs font-semibold text-white hover:bg-[#2a2f37] disabled:cursor-not-allowed disabled:border-[#dde2ea] disabled:bg-[#f7f8fa] disabled:text-[#8b8f94]"
                        >
                          {saving ? (
                            <Loader2 size={12} className="animate-spin" />
                          ) : (
                            <Save size={12} />
                          )}
                          Save
                        </button>
                      </div>
                    )}
                  </div>
                  {saveError && (
                    <div className="m-3 mb-0 flex items-start gap-2 rounded-md border border-[#cf222e]/25 bg-[#ffebe9] p-3 text-xs font-medium text-[#cf222e]">
                      <AlertTriangle size={14} className="mt-0.5 shrink-0" />
                      <span>{saveError}</span>
                    </div>
                  )}
                  {isEditing ? (
                    <textarea
                      value={draft}
                      onChange={(event) => setDraft(event.target.value)}
                      spellCheck={false}
                      className="min-h-0 flex-1 resize-none overflow-auto border-0 bg-white p-3 font-[family-name:var(--font-mono)] text-[12px] leading-relaxed text-[#171a1f] outline-none"
                    />
                  ) : (
                    <pre className="min-h-0 flex-1 overflow-auto p-3 font-[family-name:var(--font-mono)] text-[12px] leading-relaxed break-words whitespace-pre-wrap text-[#171a1f]">
                      {preview.content}
                    </pre>
                  )}
                </div>
              ) : (
                <div className="flex h-full items-center justify-center px-4 text-center text-sm font-medium text-[#68707d]">
                  Select a text file
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
