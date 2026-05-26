"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowUp,
  ChevronDown,
  Download,
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
  Upload,
  Copy,
  Scissors,
  Clipboard,
  Trash2,
  FilePlus,
  FolderPlus,
  MoreHorizontal,
} from "lucide-react";
import {
  downloadWorkspaceFile,
  fetchWorkspaceFilePreview,
  fetchWorkspaceListing,
  renameWorkspaceEntry,
  saveWorkspaceFile,
  searchWorkspaceFiles,
  uploadWorkspaceFiles,
  WorkspaceUploadConflictError,
  deleteWorkspaceEntry,
  pasteWorkspaceEntry,
  createWorkspaceEntry,
  type WorkspaceSearchOptions,
} from "@/lib/api";
import { saveBlobAsDownload } from "@/lib/platform";
import { readableApiErrorMessage } from "@/lib/apiErrors";
import { WorkspaceEntry, WorkspaceFilePreview, WorkspaceListing } from "@/types";

interface WorkspaceExplorerProps {
  userId: string;
  refreshToken: number;
  testInitialPreview?: WorkspaceFilePreview;
}

const SPLIT_PERCENT_STORAGE_KEY = "ripple.workspaceExplorer.splitPercent";
const DEFAULT_SPLIT_PERCENT = 48;
const MIN_SPLIT_PERCENT = 0;
const MAX_SPLIT_PERCENT = 100;
const DEFAULT_WORKSPACE_PATH = "/workspace";

const workspaceListingCache = new Map<string, WorkspaceListing>();
const workspaceLastPathCache = new Map<string, string>();

function workspaceCacheKey(userId: string, path: string): string {
  return `${userId}\n${path}`;
}

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

function searchMatchLabel(match: WorkspaceEntry["match"]): string | null {
  if (match === "name") return "Name";
  if (match === "path") return "Path";
  if (match === "content") return "Content";
  return null;
}

function SearchResultMeta({ entry }: { entry: WorkspaceEntry }) {
  const label = searchMatchLabel(entry.match);
  return (
    <span className="mt-0.5 flex min-w-0 items-center gap-1 font-[family-name:var(--font-mono)] text-[10px] text-[#6b7280]">
      <span className="truncate">{entry.path}</span>
      {label && (
        <span className="shrink-0 rounded border border-[#d0d7de] bg-[#f6f8fa] px-1 py-0.5 text-[9px] font-semibold text-[#57606a] uppercase">
          {label}
        </span>
      )}
    </span>
  );
}

function searchModeLabel(scope: WorkspaceSearchOptions["scope"]): string {
  if (scope === "content") return "Find content in /workspace";
  if (scope === "all") return "Find names + content in /workspace";
  return "Find names in /workspace";
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
  return readableApiErrorMessage(error);
}

export default function WorkspaceExplorer({
  userId,
  refreshToken,
  testInitialPreview,
}: WorkspaceExplorerProps) {
  const initialPath = workspaceLastPathCache.get(userId) || DEFAULT_WORKSPACE_PATH;
  const [currentPath, setCurrentPath] = useState(initialPath);
  const [listing, setListing] = useState<WorkspaceListing | null>(
    () => workspaceListingCache.get(workspaceCacheKey(userId, initialPath)) || null
  );
  const [preview, setPreview] = useState<WorkspaceFilePreview | null>(testInitialPreview || null);
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
    useState<NonNullable<WorkspaceSearchOptions["scope"]>>("name");
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
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [isDraggingUpload, setIsDraggingUpload] = useState(false);
  const [downloadingPath, setDownloadingPath] = useState<string | null>(null);
  const [imagePreviewUrl, setImagePreviewUrl] = useState<string | null>(null);

  const [clipboard, setClipboard] = useState<{
    path: string;
    name: string;
    kind: "file" | "directory";
    action: "copy" | "move";
  } | null>(null);

  const [contextMenu, setContextMenu] = useState<{
    visible: boolean;
    x: number;
    y: number;
    entry: WorkspaceEntry | null;
  }>({ visible: false, x: 0, y: 0, entry: null });

  const [creationModal, setCreationModal] = useState<{
    visible: boolean;
    kind: "file" | "directory";
  } | null>(null);
  const [creationDraft, setCreationDraft] = useState("");
  const [creationSaving, setCreationSaving] = useState(false);
  const splitPercentRef = useRef(splitPercent);
  const splitContainerRef = useRef<HTMLDivElement | null>(null);
  const uploadInputRef = useRef<HTMLInputElement | null>(null);
  const renameInputRef = useRef<HTMLInputElement | null>(null);
  const renameCommitKeyRef = useRef<string | null>(null);
  const currentPathRef = useRef(currentPath);
  const lastLoadedUserIdRef = useRef(userId);
  const directoryRequestIdRef = useRef(0);
  const directoryLoadRef = useRef<{ key: string; promise: Promise<void> } | null>(null);
  const isDirty = useMemo(() => Boolean(preview && draft !== preview.content), [draft, preview]);
  const normalizedQuery = query.trim();
  const isSearchMode = normalizedQuery.length > 0;
  const visibleEntries = isSearchMode ? searchResults : listing?.entries || [];

  useEffect(() => {
    splitPercentRef.current = splitPercent;
    window.localStorage.setItem(SPLIT_PERCENT_STORAGE_KEY, String(splitPercent));
  }, [splitPercent]);

  useEffect(() => {
    return () => {
      setImagePreviewUrl((prev) => {
        if (prev) {
          try {
            URL.revokeObjectURL(prev);
          } catch {
            // ignore
          }
        }
        return null;
      });
    };
  }, [preview?.path]);

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

  const loadDirectory = useCallback(
    async (path: string) => {
      const key = workspaceCacheKey(userId, path);
      const existingLoad = directoryLoadRef.current;
      if (existingLoad?.key === key) return existingLoad.promise;

      const requestId = directoryRequestIdRef.current + 1;
      directoryRequestIdRef.current = requestId;

      const promise = (async () => {
        setLoading(true);
        setError(null);
        try {
          const data = await fetchWorkspaceListing(path);
          if (directoryRequestIdRef.current !== requestId) return;
          workspaceListingCache.set(workspaceCacheKey(userId, data.path), data);
          workspaceLastPathCache.set(userId, data.path);
          currentPathRef.current = data.path;
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
          if (directoryRequestIdRef.current === requestId) {
            setError(err instanceof Error ? err.message : String(err));
          }
        } finally {
          if (directoryLoadRef.current?.key === key) {
            directoryLoadRef.current = null;
          }
          if (directoryRequestIdRef.current === requestId) {
            setLoading(false);
          }
        }
      })();

      directoryLoadRef.current = { key, promise };
      return promise;
    },
    [userId]
  );

  useEffect(() => {
    const userChanged = lastLoadedUserIdRef.current !== userId;
    const path = userChanged ? DEFAULT_WORKSPACE_PATH : currentPathRef.current;
    lastLoadedUserIdRef.current = userId;

    if (userChanged) {
      currentPathRef.current = path;
      setCurrentPath(path);
      setListing(workspaceListingCache.get(workspaceCacheKey(userId, path)) || null);
      setPreview(null);
      setDraft("");
      setIsEditing(false);
      setQuery("");
      setSearchResults([]);
    }

    void loadDirectory(path);
  }, [loadDirectory, refreshToken, userId]);

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

  const isImageFile = (entry: WorkspaceEntry) => {
    if (entry.mime_type?.startsWith("image/")) return true;
    const ext = entry.name.split(".").pop()?.toLowerCase();
    return ["png", "jpg", "jpeg", "gif", "svg", "webp", "bmp", "ico"].includes(ext || "");
  };

  const openEntry = async (entry: WorkspaceEntry) => {
    if (entry.kind === "directory") {
      await loadDirectory(entry.path);
      return;
    }
    setPreviewLoading(true);
    setError(null);
    setImagePreviewUrl((prev) => {
      if (prev) {
        try {
          URL.revokeObjectURL(prev);
        } catch {
          // ignore
        }
      }
      return null;
    });

    try {
      if (isImageFile(entry)) {
        const downloaded = await downloadWorkspaceFile(entry.path);
        const objectUrl = URL.createObjectURL(downloaded.blob);
        setPreview({
          path: entry.path,
          name: entry.name,
          size_bytes: entry.size_bytes,
          modified_at: entry.modified_at,
          mime_type: entry.mime_type || downloaded.blob.type || "image/png",
          encoding: "binary",
          content: "",
          truncated: false,
        });
        setImagePreviewUrl(objectUrl);
        setIsEditing(false);
        setSaveError(null);
      } else {
        const filePreview = await fetchWorkspaceFilePreview(entry.path, 256 * 1024);
        setPreview(filePreview);
        setDraft(filePreview.content);
        setIsEditing(false);
        setSaveError(null);
      }
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

  const refreshAfterUpload = useCallback(async () => {
    setQuery("");
    setSearchResults([]);
    await loadDirectory(currentPath);
  }, [currentPath, loadDirectory]);

  const uploadFilesToCurrentDirectory = useCallback(
    async (files: File[], overwrite: boolean = false) => {
      if (files.length === 0 || uploading) return;
      setUploading(true);
      setUploadError(null);
      setError(null);
      try {
        await uploadWorkspaceFiles(files, currentPath, overwrite);
        await refreshAfterUpload();
      } catch (err) {
        if (err instanceof WorkspaceUploadConflictError && !overwrite) {
          const conflictNames = err.conflicts.map((conflict) => conflict.name).join(", ");
          const confirmed = window.confirm(
            `Overwrite existing file${err.conflicts.length === 1 ? "" : "s"}: ${conflictNames}?`
          );
          if (confirmed) {
            try {
              await uploadWorkspaceFiles(files, currentPath, true);
              await refreshAfterUpload();
            } catch (overwriteErr) {
              setUploadError(
                overwriteErr instanceof Error ? overwriteErr.message : String(overwriteErr)
              );
            }
            return;
          }
        } else {
          setUploadError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        setUploading(false);
      }
    },
    [currentPath, refreshAfterUpload, uploading]
  );

  const handleUploadInputChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files || []);
    event.target.value = "";
    void uploadFilesToCurrentDirectory(files);
  };

  const hasDraggedFiles = (event: React.DragEvent<HTMLDivElement>) =>
    Array.from(event.dataTransfer.types).includes("Files");

  const handleDragEnter = (event: React.DragEvent<HTMLDivElement>) => {
    if (!hasDraggedFiles(event)) return;
    event.preventDefault();
    setIsDraggingUpload(true);
  };

  const handleDragOver = (event: React.DragEvent<HTMLDivElement>) => {
    if (!hasDraggedFiles(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    setIsDraggingUpload(true);
  };

  const handleDragLeave = (event: React.DragEvent<HTMLDivElement>) => {
    const nextTarget = event.relatedTarget;
    if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) return;
    setIsDraggingUpload(false);
  };

  const handleDrop = (event: React.DragEvent<HTMLDivElement>) => {
    if (!hasDraggedFiles(event)) return;
    event.preventDefault();
    setIsDraggingUpload(false);
    void uploadFilesToCurrentDirectory(Array.from(event.dataTransfer.files || []));
  };

  const handleDownloadFile = async (path: string) => {
    if (downloadingPath) return;
    setDownloadingPath(path);
    setError(null);
    try {
      const downloaded = await downloadWorkspaceFile(path);
      saveBlobAsDownload(downloaded.blob, downloaded.filename);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setDownloadingPath(null);
    }
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

  const handleCreate = async (event?: React.FormEvent) => {
    if (event) event.preventDefault();
    if (!creationModal || creationSaving) return;
    const name = creationDraft.trim();
    if (!name) {
      setCreationModal(null);
      return;
    }
    setCreationSaving(true);
    setError(null);
    try {
      const parentPrefix = currentPath === "/workspace" ? "/workspace" : currentPath;
      const targetPath = `${parentPrefix}/${name}`;
      const newEntry = await createWorkspaceEntry(targetPath, creationModal.kind);
      setListing((current) => {
        if (!current) return current;
        return {
          ...current,
          entries: sortWorkspaceEntries([...current.entries, newEntry]),
        };
      });
      setCreationModal(null);
      setCreationDraft("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setCreationSaving(false);
    }
  };

  const handleDelete = async (entry: WorkspaceEntry) => {
    const confirmed = window.confirm(`Are you sure you want to delete ${entry.name}?`);
    if (!confirmed) return;
    setError(null);
    try {
      await deleteWorkspaceEntry(entry.path);
      if (preview?.path === entry.path) {
        setPreview(null);
        setDraft("");
      }
      setListing((current) => {
        if (!current) return current;
        return {
          ...current,
          entries: current.entries.filter((item) => item.path !== entry.path),
        };
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleCut = (entry: WorkspaceEntry) => {
    setClipboard({
      path: entry.path,
      name: entry.name,
      kind: entry.kind,
      action: "move",
    });
    setContextMenu((prev) => ({ ...prev, visible: false }));
  };

  const handleCopy = (entry: WorkspaceEntry) => {
    setClipboard({
      path: entry.path,
      name: entry.name,
      kind: entry.kind,
      action: "copy",
    });
    setContextMenu((prev) => ({ ...prev, visible: false }));
  };

  const handlePaste = async () => {
    if (!clipboard) return;
    setError(null);
    try {
      const destination = currentPath;
      await pasteWorkspaceEntry(clipboard.path, destination, clipboard.action);
      if (clipboard.action === "move") {
        setClipboard(null);
      }
      await loadDirectory(destination);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setContextMenu((prev) => ({ ...prev, visible: false }));
    }
  };

  const handleCopyAbsoluteSandboxPath = (entry: WorkspaceEntry) => {
    navigator.clipboard.writeText(entry.path);
    setContextMenu((prev) => ({ ...prev, visible: false }));
  };

  const onMoreButtonClick = (event: React.MouseEvent, entry: WorkspaceEntry) => {
    event.preventDefault();
    event.stopPropagation();
    const rect = event.currentTarget.getBoundingClientRect();
    const menuWidth = 160;
    const x = Math.max(8, rect.right - menuWidth);
    const y = rect.bottom + 4;
    setContextMenu({
      visible: true,
      x,
      y,
      entry,
    });
  };

  const onEntryContextMenu = (event: React.MouseEvent, entry: WorkspaceEntry) => {
    event.preventDefault();
    event.stopPropagation();
    setContextMenu({
      visible: true,
      x: event.clientX,
      y: event.clientY,
      entry,
    });
  };

  const onContainerContextMenu = (event: React.MouseEvent) => {
    if (
      event.target === event.currentTarget ||
      (event.target as HTMLElement).classList.contains("context-trigger-area")
    ) {
      event.preventDefault();
      setContextMenu({
        visible: true,
        x: event.clientX,
        y: event.clientY,
        entry: null,
      });
    }
  };

  useEffect(() => {
    const handleGlobalClick = () => {
      setContextMenu((prev) => (prev.visible ? { ...prev, visible: false } : prev));
    };
    window.addEventListener("click", handleGlobalClick);
    return () => {
      window.removeEventListener("click", handleGlobalClick);
    };
  }, []);

  const isPreviewPanelHidden = splitPercent >= MAX_SPLIT_PERCENT || !preview;
  const splitGridTemplateRows = isPreviewPanelHidden
    ? "minmax(0,1fr) 0px"
    : `minmax(0,${splitPercent}%) minmax(0,1fr)`;

  return (
    <div
      className="relative flex h-full flex-col overflow-hidden bg-white text-[#0d0d0d]"
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <input
        ref={uploadInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={handleUploadInputChange}
      />
      {isDraggingUpload && (
        <div className="pointer-events-none absolute inset-0 z-50 flex items-center justify-center bg-white/85 p-4 backdrop-blur-sm">
          <div className="rounded-lg border border-dashed border-[#2463eb] bg-[#eef4ff] px-4 py-3 text-sm font-semibold text-[#0b57d0] shadow-lg">
            Drop files to upload
          </div>
        </div>
      )}
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
              placeholder="Find files by name..."
              className="h-8 w-full rounded-full border border-[#e5e7eb] bg-white pr-2 pl-8 text-sm text-[#0d0d0d] outline-none placeholder:text-[#8b8f94] focus:border-[#8da0ff]"
            />
          </div>
          <button
            type="button"
            className={`inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full border ${
              isFilterOpen
                ? "border-[#2f6bff]/30 bg-[#eef4ff] text-[#2f6bff]"
                : "border-[#e5e7eb] bg-white text-[#6b7280] hover:bg-[#f7f8fa] hover:text-[#0d0d0d]"
            }`}
            title="Search filters"
            aria-label="Search filters"
            onClick={() => setIsFilterOpen((open) => !open)}
          >
            <SlidersHorizontal size={14} />
          </button>
          <button
            type="button"
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-[#e5e7eb] bg-white text-[#6b7280] hover:bg-[#f7f8fa] hover:text-[#0d0d0d] disabled:cursor-not-allowed disabled:opacity-50"
            title="Upload files"
            aria-label="Upload files"
            disabled={uploading}
            onClick={() => uploadInputRef.current?.click()}
          >
            {uploading ? <Loader2 size={14} className="animate-spin" /> : <Upload size={14} />}
          </button>
        </div>
        {isFilterOpen && (
          <div className="mb-2 grid gap-2 rounded-2xl border border-[#e5e7eb] bg-[#fbfbfc] p-3 text-xs text-[#374151] shadow-sm sm:grid-cols-2">
            <label className="flex items-center gap-2">
              <span className="w-16 text-[#6b7280]">Scope</span>
              <select
                value={searchScope}
                onChange={(event) =>
                  setSearchScope(event.target.value as NonNullable<WorkspaceSearchOptions["scope"]>)
                }
                className="h-7 min-w-0 flex-1 rounded border border-[#d7dce3] bg-white px-2 text-xs"
              >
                <option value="name">Name/path (default)</option>
                <option value="all">Name and content</option>
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
            {isSearchMode ? searchModeLabel(searchScope) : listing?.path || currentPath}
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
      {uploadError && (
        <div className="m-4 mb-0 flex items-start gap-2 rounded-md border border-[#cf222e]/25 bg-[#ffebe9] p-3 text-xs font-medium text-[#cf222e]">
          <AlertTriangle size={14} className="mt-0.5 shrink-0" />
          <span className="break-words">{displayError(uploadError)}</span>
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
              {preview && splitPercent >= MAX_SPLIT_PERCENT && (
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
          <div
            onContextMenu={onContainerContextMenu}
            className="context-trigger-area h-full overflow-y-auto pb-10"
          >
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
                        {isSearchMode ? (
                          <SearchResultMeta entry={entry} />
                        ) : (
                          <span className="mt-0.5 block truncate font-[family-name:var(--font-mono)] text-[10px] text-[#6b7280]">
                            {`${entry.kind === "directory" ? "folder" : formatBytes(entry.size_bytes)}${
                              formatModified(entry.modified_at)
                                ? ` · ${formatModified(entry.modified_at)}`
                                : ""
                            }`}
                          </span>
                        )}
                      </span>
                      {renameSaving && <Loader2 size={13} className="shrink-0 animate-spin" />}
                    </form>
                  ) : (
                    <div
                      key={entry.path}
                      onContextMenu={(event) => onEntryContextMenu(event, entry)}
                      className={`group flex w-full items-center transition-colors hover:bg-[#f7f8fa] ${
                        preview?.path === entry.path ? "bg-[#eef4ff]" : "bg-white"
                      } ${
                        clipboard?.action === "move" && clipboard?.path === entry.path
                          ? "opacity-35 select-none"
                          : ""
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
                          {isSearchMode ? (
                            <SearchResultMeta entry={entry} />
                          ) : (
                            <span className="mt-0.5 block truncate font-[family-name:var(--font-mono)] text-[10px] text-[#6b7280]">
                              {`${entry.kind === "directory" ? "folder" : formatBytes(entry.size_bytes)}${
                                formatModified(entry.modified_at)
                                  ? ` · ${formatModified(entry.modified_at)}`
                                  : ""
                              }`}
                            </span>
                          )}
                        </span>
                      </button>
                      <button
                        type="button"
                        aria-label={`More actions for ${entry.name}`}
                        title="More actions"
                        onClick={(event) => onMoreButtonClick(event, entry)}
                        className="mr-2 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-transparent text-[#6b7280] opacity-100 transition-opacity hover:border-[#dde2ea] hover:bg-white hover:text-[#0d0d0d] focus:opacity-100 sm:h-7 sm:w-7 sm:opacity-0 sm:group-hover:opacity-100"
                      >
                        <MoreHorizontal size={14} />
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
                    onClick={() => void handleDownloadFile(preview.path)}
                    disabled={downloadingPath === preview.path}
                    className="inline-flex h-7 items-center gap-1 rounded-md border border-[#dde2ea] bg-white px-2 text-xs font-medium text-[#68707d] hover:bg-[#f7f8fa] disabled:cursor-not-allowed disabled:text-[#8b8f94]"
                    title="Download"
                  >
                    {downloadingPath === preview.path ? (
                      <Loader2 size={12} className="animate-spin" />
                    ) : (
                      <Download size={12} />
                    )}
                    Download
                  </button>
                  {!imagePreviewUrl && (
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
                  )}
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
                  {imagePreviewUrl ? (
                    <div className="flex min-h-[300px] flex-1 items-center justify-center overflow-auto bg-[#f8fafc] p-6">
                      <img
                        src={imagePreviewUrl}
                        alt={preview.name}
                        className="max-h-[480px] max-w-full rounded-md border border-[#e2e8f0] bg-white object-contain p-1.5 shadow-sm transition-all hover:shadow"
                      />
                    </div>
                  ) : isEditing ? (
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
                  Select a file
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* 右键菜单 */}
      {contextMenu.visible && (
        <div
          style={{ top: contextMenu.y, left: contextMenu.x }}
          className="fixed z-50 min-w-[160px] rounded-2xl border border-[#dfe6f4] bg-white p-1.5 text-xs text-[#374151] shadow-[0_12px_36px_-4px_rgba(0,0,0,0.12),0_4px_16px_-2px_rgba(0,0,0,0.06)] animate-in fade-in-50 zoom-in-95 duration-100"
          onClick={(e) => e.stopPropagation()}
          onContextMenu={(e) => e.preventDefault()}
        >
          {contextMenu.entry ? (
            <>
              <button
                type="button"
                onClick={() => {
                  if (contextMenu.entry) startRename(contextMenu.entry);
                  setContextMenu((prev) => ({ ...prev, visible: false }));
                }}
                className="flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left text-xs font-semibold text-[#374151] transition-all hover:bg-[#f3f4f6] active:bg-[#eef3ff]"
              >
                <Edit3 size={13} className="shrink-0 text-[#6b7280]" /> Rename
              </button>
              <button
                type="button"
                onClick={() => contextMenu.entry && handleCut(contextMenu.entry)}
                className="flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left text-xs font-semibold text-[#374151] transition-all hover:bg-[#f3f4f6] active:bg-[#eef3ff]"
              >
                <Scissors size={13} className="shrink-0 text-[#6b7280]" /> Cut (Move)
              </button>
              <button
                type="button"
                onClick={() => contextMenu.entry && handleCopy(contextMenu.entry)}
                className="flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left text-xs font-semibold text-[#374151] transition-all hover:bg-[#f3f4f6] active:bg-[#eef3ff]"
              >
                <Copy size={13} className="shrink-0 text-[#6b7280]" /> Copy
              </button>
              <button
                type="button"
                onClick={() =>
                  contextMenu.entry && handleCopyAbsoluteSandboxPath(contextMenu.entry)
                }
                className="flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left text-xs font-semibold text-[#374151] font-[family-name:var(--font-mono)] transition-all hover:bg-[#f3f4f6] active:bg-[#eef3ff]"
              >
                <FileText size={13} className="shrink-0 text-[#6b7280]" /> Copy Sandbox Path
              </button>
              {contextMenu.entry.kind === "file" && (
                <button
                  type="button"
                  onClick={() => {
                    if (contextMenu.entry) void handleDownloadFile(contextMenu.entry.path);
                    setContextMenu((prev) => ({ ...prev, visible: false }));
                  }}
                  className="flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left text-xs font-semibold text-[#374151] transition-all hover:bg-[#f3f4f6] active:bg-[#eef3ff]"
                >
                  <Download size={13} className="shrink-0 text-[#6b7280]" /> Download
                </button>
              )}
              <div className="my-1 border-t border-[#dfe6f4]" />
              <button
                type="button"
                onClick={() => contextMenu.entry && void handleDelete(contextMenu.entry)}
                className="flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left text-xs font-semibold text-[#cf222e] transition-colors hover:bg-[#ffebe9] active:bg-[#ffd5d6]"
              >
                <Trash2 size={13} className="shrink-0 text-[#cf222e]" /> Delete
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                disabled={!clipboard}
                onClick={handlePaste}
                className="flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left text-xs font-semibold text-[#374151] transition-all hover:bg-[#f3f4f6] active:bg-[#eef3ff] disabled:cursor-not-allowed disabled:opacity-40"
              >
                <Clipboard size={13} className="shrink-0 text-[#6b7280]" /> Paste {clipboard ? `(${clipboard.name})` : ""}
              </button>
              <div className="my-1 border-t border-[#dfe6f4]" />
              <button
                type="button"
                onClick={() => {
                  setCreationModal({ visible: true, kind: "file" });
                  setContextMenu((prev) => ({ ...prev, visible: false }));
                }}
                className="flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left text-xs font-semibold text-[#374151] transition-all hover:bg-[#f3f4f6] active:bg-[#eef3ff]"
              >
                <FilePlus size={13} className="shrink-0 text-[#6b7280]" /> New File
              </button>
              <button
                type="button"
                onClick={() => {
                  setCreationModal({ visible: true, kind: "directory" });
                  setContextMenu((prev) => ({ ...prev, visible: false }));
                }}
                className="flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left text-xs font-semibold text-[#374151] transition-all hover:bg-[#f3f4f6] active:bg-[#eef3ff]"
              >
                <FolderPlus size={13} className="shrink-0 text-[#6b7280]" /> New Folder
              </button>
            </>
          )}
        </div>
      )}

      {/* 新建模态对话框 */}
      {creationModal?.visible && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-[1px]">
          <form
            onSubmit={handleCreate}
            className="w-80 rounded-2xl border border-[#dfe6f4] bg-white p-5 shadow-2xl"
          >
            <h3 className="mb-3 text-sm font-semibold text-[#111827]">
              {creationModal.kind === "file" ? "Create New File" : "Create New Folder"}
            </h3>
            <input
              autoFocus
              value={creationDraft}
              onChange={(e) => setCreationDraft(e.target.value)}
              placeholder={creationModal.kind === "file" ? "e.g. main.py" : "e.g. src_folder"}
              className="mb-4 h-9 w-full rounded-full border border-[#dfe6f4] bg-white px-4 text-sm outline-none focus:border-[#8da0ff]"
              disabled={creationSaving}
            />
            <div className="flex justify-end gap-2 text-xs font-semibold">
              <button
                type="button"
                onClick={() => {
                  setCreationModal(null);
                  setCreationDraft("");
                }}
                className="rounded-full border border-[#dfe6f4] bg-white px-4 py-1.5 text-[#374151] transition-all duration-200 hover:bg-[#f9fafb]"
                disabled={creationSaving}
              >
                Cancel
              </button>
              <button
                type="submit"
                className="rounded-full bg-[linear-gradient(135deg,#2f6bff,#7b5cff)] px-4 py-1.5 text-white shadow-[0_8px_18px_rgba(64,92,255,0.18)] transition-all duration-200 hover:brightness-110 active:scale-[0.98]"
                disabled={creationSaving}
              >
                {creationSaving ? "Creating..." : "Create"}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
