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
import { fetchWorkspaceFilePreview, fetchWorkspaceListing, saveWorkspaceFile } from "@/lib/api";
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

function displayError(error: string): string {
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
  const [error, setError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [splitPercent, setSplitPercent] = useState(initialSplitPercent);
  const splitPercentRef = useRef(splitPercent);
  const splitContainerRef = useRef<HTMLDivElement | null>(null);
  const isDirty = useMemo(() => Boolean(preview && draft !== preview.content), [draft, preview]);
  const visibleEntries = useMemo(() => {
    if (!listing) return [];
    const normalized = query.trim().toLowerCase();
    if (!normalized) return listing.entries;
    return listing.entries.filter((entry) => entry.name.toLowerCase().includes(normalized));
  }, [listing, query]);

  useEffect(() => {
    splitPercentRef.current = splitPercent;
    window.localStorage.setItem(SPLIT_PERCENT_STORAGE_KEY, String(splitPercent));
  }, [splitPercent]);

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
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search files..."
              className="h-8 w-full rounded-md border border-[#e5e7eb] bg-white pr-2 pl-8 text-sm text-[#0d0d0d] outline-none placeholder:text-[#8b8f94] focus:border-[#2463eb]"
            />
          </div>
          <button
            type="button"
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-[#e5e7eb] bg-white text-[#6b7280] hover:bg-[#f7f8fa] hover:text-[#0d0d0d]"
            title="Filter files"
          >
            <SlidersHorizontal size={14} />
          </button>
        </div>
        <div className="flex items-center justify-between gap-2">
          <p className="min-w-0 truncate font-[family-name:var(--font-mono)] text-[11px] text-[#6b7280]">
            {listing?.path || currentPath}
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

      <div
        ref={splitContainerRef}
        className="grid min-h-0 flex-1"
        style={{ gridTemplateRows: splitGridTemplateRows }}
      >
        <div className="min-h-0 overflow-hidden border-b border-[#e5e7eb] bg-white">
          <div className="flex items-center justify-between border-b border-[#e5e7eb] bg-white px-3 py-2">
            <span className="text-xs font-semibold tracking-wider text-[#6b7280] uppercase">
              Workspace
            </span>
            <div className="flex items-center gap-1">
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
              {listing?.parent_path && (
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
            {loading && !listing ? (
              <div className="flex h-40 items-center justify-center gap-2 text-sm font-medium text-[#68707d]">
                <Loader2 size={16} className="animate-spin" />
                Loading
              </div>
            ) : listing && visibleEntries.length === 0 ? (
              <div className="flex h-40 items-center justify-center px-4 text-center text-sm font-medium text-[#6b7280]">
                Empty workspace
              </div>
            ) : (
              <div>
                {visibleEntries.map((entry) => (
                  <button
                    key={entry.path}
                    type="button"
                    onClick={() => void openEntry(entry)}
                    onDoubleClick={() => handleFileDoubleClick(entry)}
                    className={`flex w-full items-center gap-2.5 px-3 py-2 text-left transition-colors hover:bg-[#f7f8fa] ${
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
                      <span
                        className={`block truncate font-[family-name:var(--font-mono)] text-[13px] font-medium text-[#0d0d0d] ${
                          entry.is_hidden ? "opacity-55" : ""
                        }`}
                      >
                        {entry.name}
                      </span>
                      <span className="mt-0.5 block truncate font-[family-name:var(--font-mono)] text-[10px] text-[#6b7280]">
                        {entry.kind === "directory" ? "folder" : formatBytes(entry.size_bytes)}
                        {formatModified(entry.modified_at)
                          ? ` · ${formatModified(entry.modified_at)}`
                          : ""}
                      </span>
                    </span>
                  </button>
                ))}
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
