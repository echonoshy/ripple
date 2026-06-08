"use client";

import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle } from "lucide-react";
import WorkspaceActionMenus from "@/components/workspace/WorkspaceActionMenus";
import WorkspaceConfirmDialog, {
  type WorkspaceConfirmation,
} from "@/components/workspace/WorkspaceConfirmDialog";
import WorkspaceCreateEntryDialog, {
  type WorkspaceCreationModalState,
} from "@/components/workspace/WorkspaceCreateEntryDialog";
import {
  WorkspacePreviewFullscreen,
  WorkspacePreviewPanel,
} from "@/components/workspace/WorkspacePreviewPanel";
import WorkspaceFileList from "@/components/workspace/WorkspaceFileList";
import WorkspaceToolbar from "@/components/workspace/WorkspaceToolbar";
import {
  TYPOGRAPHY_BODY_MEDIUM_CLASS,
  TYPOGRAPHY_META_MEDIUM_CLASS,
  WORKBENCH_SECTION_CLASS,
} from "@/components/workbench/stylePrimitives";
import {
  DEFAULT_SPLIT_PERCENT,
  DEFAULT_WORKSPACE_PATH,
  MAX_SPLIT_PERCENT,
  MIN_SPLIT_PERCENT,
  SPLIT_PERCENT_STORAGE_KEY,
  displayError,
  getBoundedSplitPercent,
  getSplitPercentAfterFileDoubleClick,
  getSplitPercentFromVerticalResize,
  getWorkspacePreviewKind,
  canMoveEntriesToDirectory,
  getWorkspaceParentPath,
  searchModeLabel,
  shouldDismissWorkspaceContextMenuOnEntryClick,
  sortWorkspaceEntries,
  workspaceEntryNameFromPath,
} from "@/components/workspace/workspaceExplorerUtils";
import { useI18n } from "@/i18n";
import {
  downloadWorkspaceFile,
  fetchWorkspaceDocumentPreview,
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
import { getClientStorageItem, saveBlobAsDownload, setClientStorageItem } from "@/lib/platform";
import {
  getMeasuredViewportMenuPosition,
  getResponsiveMenuBottomInsetPx,
  VIEWPORT_MENU_MARGIN_PX,
  type ViewportMenuAnchorRect,
} from "@/lib/menuPosition";
import { getWorkspaceImagePreviewUrl } from "@/lib/workspaceImageCache";
import {
  WorkspaceEntry,
  WorkspaceFileOpenRequest,
  WorkspaceFilePreview,
  WorkspaceListing,
} from "@/types";

export {
  displayError,
  getBoundedSplitPercent,
  getSplitPercentAfterFileDoubleClick,
  getSplitPercentFromVerticalResize,
  getWorkspaceParentPath,
  getWorkspacePreviewKind,
  shouldDismissWorkspaceContextMenuOnEntryClick,
};

interface WorkspaceExplorerProps {
  userId: string;
  refreshToken: number;
  presentation?: "compact" | "page";
  onBack?: () => void;
  openFileRequest?: WorkspaceFileOpenRequest | null;
  onOpenFileRequestConsumed?: (requestId: number) => void;
  testInitialPreview?: WorkspaceFilePreview;
  testInitialListing?: WorkspaceListing;
}

const WORKSPACE_CONTEXT_MENU_WIDTH = 220;
const WORKSPACE_FILE_CONTEXT_MENU_HEIGHT = 244;
const WORKSPACE_DIRECTORY_CONTEXT_MENU_HEIGHT = 208;
const WORKSPACE_EMPTY_CONTEXT_MENU_HEIGHT = 132;
const WORKSPACE_DRAG_ENTRY_MIME = "application/x-ripple-workspace-entry";

interface WorkspaceDragPayload {
  paths: string[];
}

const workspaceListingCache = new Map<string, WorkspaceListing>();
const workspaceLastPathCache = new Map<string, string>();

function workspaceCacheKey(userId: string, path: string): string {
  return `${userId}\n${path}`;
}

function workspaceContextMenuHeight(entry: WorkspaceEntry | null): number {
  if (!entry) return WORKSPACE_EMPTY_CONTEXT_MENU_HEIGHT;
  return entry.kind === "file"
    ? WORKSPACE_FILE_CONTEXT_MENU_HEIGHT
    : WORKSPACE_DIRECTORY_CONTEXT_MENU_HEIGHT;
}

function getWorkspaceContextMenuPosition({
  anchorRect,
  entry,
  align,
  measuredMenuHeight,
}: {
  anchorRect: ViewportMenuAnchorRect;
  entry: WorkspaceEntry | null;
  align: "left" | "right";
  measuredMenuHeight?: number | null;
}): { x: number; y: number } {
  const position = getMeasuredViewportMenuPosition({
    anchorRect,
    menuWidth: WORKSPACE_CONTEXT_MENU_WIDTH,
    estimatedMenuHeight: workspaceContextMenuHeight(entry),
    measuredMenuHeight,
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight,
    bottomInset: getResponsiveMenuBottomInsetPx(),
    margin: VIEWPORT_MENU_MARGIN_PX,
    align,
  });

  return { x: position.left, y: position.top };
}

function initialSplitPercent(): number {
  const rawValue = getClientStorageItem(SPLIT_PERCENT_STORAGE_KEY);
  if (rawValue === null) return DEFAULT_SPLIT_PERCENT;
  const stored = Number(rawValue);
  return Number.isFinite(stored) ? getBoundedSplitPercent(stored) : DEFAULT_SPLIT_PERCENT;
}

function initialIsCoarsePointer(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia("(pointer: coarse)").matches;
}

function hasDraggedWorkspaceEntries(event: React.DragEvent<Element>): boolean {
  return Array.from(event.dataTransfer.types).includes(WORKSPACE_DRAG_ENTRY_MIME);
}

function getWorkspaceDragPaths(dataTransfer: DataTransfer): string[] {
  const rawPayload = dataTransfer.getData(WORKSPACE_DRAG_ENTRY_MIME);
  if (!rawPayload) return [];

  try {
    const payload = JSON.parse(rawPayload) as WorkspaceDragPayload;
    return Array.isArray(payload.paths)
      ? payload.paths.filter((path): path is string => typeof path === "string")
      : [];
  } catch {
    return [];
  }
}

export default function WorkspaceExplorer({
  userId,
  refreshToken,
  presentation = "compact",
  onBack,
  openFileRequest,
  onOpenFileRequestConsumed,
  testInitialPreview,
  testInitialListing,
}: WorkspaceExplorerProps) {
  const { locale, t } = useI18n();
  const initialPath =
    testInitialListing?.path || workspaceLastPathCache.get(userId) || DEFAULT_WORKSPACE_PATH;
  const [currentPath, setCurrentPath] = useState(initialPath);
  const [listing, setListing] = useState<WorkspaceListing | null>(
    () =>
      testInitialListing ||
      workspaceListingCache.get(workspaceCacheKey(userId, initialPath)) ||
      null
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
  const [isMobileSearchOpen, setIsMobileSearchOpen] = useState(false);
  const [isActionsMenuOpen, setIsActionsMenuOpen] = useState(false);
  const [searchScope, setSearchScope] =
    useState<NonNullable<WorkspaceSearchOptions["scope"]>>("name");
  const [searchKind, setSearchKind] = useState<NonNullable<WorkspaceSearchOptions["kind"]>>("all");
  const [fileType, setFileType] = useState<NonNullable<WorkspaceSearchOptions["fileType"]>>("all");
  const [searchLimit, setSearchLimit] = useState(50);
  const [error, setError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [renamingPath, setRenamingPath] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [renameSaving, setRenameSaving] = useState(false);
  const [splitPercent, setSplitPercent] = useState(initialSplitPercent);
  const [highlightedLine, setHighlightedLine] = useState<number | null>(null);
  const preContainerRef = useRef<HTMLDivElement | null>(null);
  const highlightedLineRef = useRef<HTMLDivElement | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [isDraggingUpload, setIsDraggingUpload] = useState(false);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [imagePreviewUrl, setImagePreviewUrl] = useState<string | null>(null);
  const [documentPreview, setDocumentPreview] = useState<{
    blob: Blob;
    filename: string;
  } | null>(null);
  const [isPreviewFullscreenOpen, setIsPreviewFullscreenOpen] = useState(false);
  const [clipboard, setClipboard] = useState<{
    items: WorkspaceEntry[];
    action: "copy" | "move";
  } | null>(null);
  const [selectedEntryPaths, setSelectedEntryPaths] = useState<Set<string>>(() => new Set());
  const [isSelectionMode, setIsSelectionMode] = useState(false);
  const [draggedEntries, setDraggedEntries] = useState<WorkspaceEntry[]>([]);
  const [dragTargetPath, setDragTargetPath] = useState<string | null>(null);
  const [mobileActionEntry, setMobileActionEntry] = useState<WorkspaceEntry | null>(null);
  const [confirmation, setConfirmation] = useState<WorkspaceConfirmation | null>(null);
  const [isCoarsePointer, setIsCoarsePointer] = useState(initialIsCoarsePointer);

  const [contextMenu, setContextMenu] = useState<{
    visible: boolean;
    x: number;
    y: number;
    entry: WorkspaceEntry | null;
    anchorRect: ViewportMenuAnchorRect | null;
    align: "left" | "right";
    measuredHeight: number | null;
  }>({
    visible: false,
    x: 0,
    y: 0,
    entry: null,
    anchorRect: null,
    align: "right",
    measuredHeight: null,
  });

  const [creationModal, setCreationModal] = useState<WorkspaceCreationModalState | null>(null);
  const [creationDraft, setCreationDraft] = useState("");
  const [creationSaving, setCreationSaving] = useState(false);
  const uploadInputRef = useRef<HTMLInputElement | null>(null);
  const contextMenuRef = useRef<HTMLDivElement | null>(null);
  const renameInputRef = useRef<HTMLInputElement | null>(null);
  const renameCommitKeyRef = useRef<string | null>(null);
  const currentPathRef = useRef(currentPath);
  const lastLoadedUserIdRef = useRef(userId);
  const directoryRequestIdRef = useRef(0);
  const directoryLoadRef = useRef<{ key: string; promise: Promise<void> } | null>(null);
  const previewRequestIdRef = useRef(0);
  const workspaceGridRef = useRef<HTMLDivElement | null>(null);
  const splitPercentRef = useRef(splitPercent);
  const confirmationResolverRef = useRef<((confirmed: boolean) => void) | null>(null);
  const longPressTimerRef = useRef<number | null>(null);
  const isDirty = useMemo(() => Boolean(preview && draft !== preview.content), [draft, preview]);
  const normalizedQuery = query.trim();
  const isSearchMode = normalizedQuery.length > 0;
  const visibleEntries = useMemo(
    () => (isSearchMode ? searchResults : listing?.entries || []),
    [isSearchMode, listing?.entries, searchResults]
  );
  const selectedEntries = useMemo(
    () => visibleEntries.filter((entry) => selectedEntryPaths.has(entry.path)),
    [selectedEntryPaths, visibleEntries]
  );
  const visibleEntriesByPath = useMemo(
    () => new Map(visibleEntries.map((entry) => [entry.path, entry])),
    [visibleEntries]
  );
  const draggedEntryPaths = useMemo(
    () => new Set(draggedEntries.map((entry) => entry.path)),
    [draggedEntries]
  );
  const selectedEntryCount = selectedEntries.length;
  const isSelectionActive = isSelectionMode || selectedEntryCount > 0;
  const allVisibleEntriesSelected =
    visibleEntries.length > 0 &&
    visibleEntries.every((entry) => selectedEntryPaths.has(entry.path));
  useEffect(() => {
    splitPercentRef.current = splitPercent;
    setClientStorageItem(SPLIT_PERCENT_STORAGE_KEY, String(splitPercent));
  }, [splitPercent]);

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;

    const mediaQuery = window.matchMedia("(pointer: coarse)");
    const updatePointerMode = () => setIsCoarsePointer(mediaQuery.matches);
    updatePointerMode();
    mediaQuery.addEventListener("change", updatePointerMode);
    return () => {
      mediaQuery.removeEventListener("change", updatePointerMode);
    };
  }, []);

  useEffect(() => {
    if (!preview) setIsPreviewFullscreenOpen(false);
  }, [preview]);

  useEffect(() => {
    if (!isPreviewFullscreenOpen) return;
    if (typeof window === "undefined" || typeof document === "undefined") return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setIsPreviewFullscreenOpen(false);
    };
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", handleKeyDown);

    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [isPreviewFullscreenOpen]);

  useEffect(() => {
    if (!renamingPath) return;
    queueMicrotask(() => {
      renameInputRef.current?.focus();
      renameInputRef.current?.select();
    });
  }, [renamingPath]);

  useEffect(() => {
    return () => {
      confirmationResolverRef.current?.(false);
      confirmationResolverRef.current = null;
      if (longPressTimerRef.current !== null) {
        window.clearTimeout(longPressTimerRef.current);
      }
    };
  }, []);

  const updateSplitPercent = useCallback((value: number) => {
    setSplitPercent(getBoundedSplitPercent(value));
  }, []);

  const requestConfirmation = useCallback((nextConfirmation: WorkspaceConfirmation) => {
    confirmationResolverRef.current?.(false);
    setConfirmation(nextConfirmation);
    return new Promise<boolean>((resolve) => {
      confirmationResolverRef.current = resolve;
    });
  }, []);

  const resolveConfirmation = useCallback((confirmed: boolean) => {
    confirmationResolverRef.current?.(confirmed);
    confirmationResolverRef.current = null;
    setConfirmation(null);
  }, []);

  const clearLongPressTimer = useCallback(() => {
    if (longPressTimerRef.current !== null) {
      window.clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  }, []);

  const handlePreviewResizeStart = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      event.stopPropagation();

      const gridNode = workspaceGridRef.current;
      if (!gridNode) return;

      const handlePointerMove = (moveEvent: PointerEvent) => {
        const rect = gridNode.getBoundingClientRect();
        updateSplitPercent(
          getSplitPercentFromVerticalResize({
            containerTop: rect.top,
            containerHeight: rect.height,
            pointerY: moveEvent.clientY,
          })
        );
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

  const handlePreviewResizeKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      const step = event.shiftKey ? 10 : 4;
      if (event.key === "ArrowUp") {
        event.preventDefault();
        updateSplitPercent(splitPercentRef.current - step);
      }
      if (event.key === "ArrowDown") {
        event.preventDefault();
        updateSplitPercent(splitPercentRef.current + step);
      }
      if (event.key === "Home") {
        event.preventDefault();
        updateSplitPercent(MIN_SPLIT_PERCENT);
      }
      if (event.key === "End") {
        event.preventDefault();
        updateSplitPercent(MAX_SPLIT_PERCENT);
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
          setImagePreviewUrl(null);
          setDocumentPreview(null);
          setDraft("");
          setIsEditing(false);
          setSaveError(null);
          setSelectedEntryPaths(new Set());
          setIsSelectionMode(false);
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

  const openWorkspaceFilePath = useCallback(
    async (targetPath: string, lineNumber?: number) => {
      const requestId = previewRequestIdRef.current + 1;
      previewRequestIdRef.current = requestId;
      await loadDirectory(getWorkspaceParentPath(targetPath));
      if (previewRequestIdRef.current !== requestId) return;
      setSplitPercent((current) =>
        current >= MAX_SPLIT_PERCENT ? DEFAULT_SPLIT_PERCENT : current
      );
      setPreviewLoading(true);
      setError(null);
      try {
        const name = workspaceEntryNameFromPath(targetPath);
        const previewKind = getWorkspacePreviewKind({ name, mime_type: null });
        if (previewKind === "pdf" || previewKind === "document") {
          const documentPreview = await fetchWorkspaceDocumentPreview(targetPath);
          if (previewRequestIdRef.current !== requestId) return;
          setPreview({
            path: targetPath,
            name,
            size_bytes: documentPreview.blob.size,
            modified_at: "",
            mime_type: "application/pdf",
            encoding: "binary",
            content: "",
            truncated: false,
          });
          setImagePreviewUrl(null);
          setDocumentPreview({
            blob: documentPreview.blob,
            filename: documentPreview.filename,
          });
          setDraft("");
        } else {
          const filePreview = await fetchWorkspaceFilePreview(targetPath, 256 * 1024);
          if (previewRequestIdRef.current !== requestId) return;
          setPreview(filePreview);
          setImagePreviewUrl(null);
          setDocumentPreview(null);
          setDraft(filePreview.content);
        }
        setIsEditing(false);
        setSaveError(null);
        setHighlightedLine(previewKind === "text" ? (lineNumber ?? null) : null);
      } catch (err) {
        if (previewRequestIdRef.current !== requestId) return;
        setPreview(null);
        setImagePreviewUrl(null);
        setDocumentPreview(null);
        setDraft("");
        setIsEditing(false);
        setError(err instanceof Error ? err.message : String(err));
        setHighlightedLine(null);
      } finally {
        if (previewRequestIdRef.current === requestId) {
          setPreviewLoading(false);
        }
      }
    },
    [loadDirectory]
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
      setImagePreviewUrl(null);
      setDocumentPreview(null);
      setDraft("");
      setIsEditing(false);
      setHighlightedLine(null);

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
  }, [fileType, normalizedQuery, searchKind, searchLimit, searchScope]);

  const openEntry = async (entry: WorkspaceEntry) => {
    if (entry.kind === "directory") {
      previewRequestIdRef.current += 1;
      await loadDirectory(entry.path);
      return;
    }
    const requestId = previewRequestIdRef.current + 1;
    previewRequestIdRef.current = requestId;
    setSplitPercent((current) => getSplitPercentAfterFileDoubleClick(current));
    setPreviewLoading(true);
    setError(null);
    setHighlightedLine(null);
    setImagePreviewUrl(null);
    setDocumentPreview(null);

    try {
      const previewKind = getWorkspacePreviewKind(entry);
      if (previewKind === "image") {
        const imageUrl = await getWorkspaceImagePreviewUrl(
          {
            userId,
            path: entry.path,
            size: entry.size_bytes,
            mimeType: entry.mime_type,
            modifiedAt: entry.modified_at,
          },
          async () => {
            const downloaded = await downloadWorkspaceFile(entry.path);
            return downloaded.blob;
          }
        );
        if (previewRequestIdRef.current !== requestId) return;
        setPreview({
          path: entry.path,
          name: entry.name,
          size_bytes: entry.size_bytes,
          modified_at: entry.modified_at,
          mime_type: entry.mime_type || "image/png",
          encoding: "binary",
          content: "",
          truncated: false,
        });
        setImagePreviewUrl(imageUrl);
        setDocumentPreview(null);
        setDraft("");
        setIsEditing(false);
        setSaveError(null);
      } else if (previewKind === "pdf" || previewKind === "document") {
        const documentPreview = await fetchWorkspaceDocumentPreview(entry.path);
        if (previewRequestIdRef.current !== requestId) return;
        setPreview({
          path: entry.path,
          name: entry.name,
          size_bytes: entry.size_bytes,
          modified_at: entry.modified_at,
          mime_type: "application/pdf",
          encoding: "binary",
          content: "",
          truncated: false,
        });
        setImagePreviewUrl(null);
        setDocumentPreview({
          blob: documentPreview.blob,
          filename: documentPreview.filename,
        });
        setDraft("");
        setIsEditing(false);
        setSaveError(null);
      } else {
        const filePreview = await fetchWorkspaceFilePreview(entry.path, 256 * 1024);
        if (previewRequestIdRef.current !== requestId) return;
        setPreview(filePreview);
        setImagePreviewUrl(null);
        setDocumentPreview(null);
        setDraft(filePreview.content);
        setIsEditing(false);
        setSaveError(null);
      }
    } catch (err) {
      if (previewRequestIdRef.current !== requestId) return;
      setPreview(null);
      setImagePreviewUrl(null);
      setDocumentPreview(null);
      setDraft("");
      setIsEditing(false);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (previewRequestIdRef.current === requestId) {
        setPreviewLoading(false);
      }
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

  const refreshAfterUpload = useCallback(async (path: string) => {
    setQuery("");
    setSearchResults([]);
    await loadDirectory(path);
  }, [loadDirectory]);

  const uploadFilesToCurrentDirectory = useCallback(
    async (files: File[], overwrite: boolean = false) => {
      if (files.length === 0 || uploading) return;
      setUploading(true);
      setUploadError(null);
      setError(null);
      setActionMessage(null);
      try {
        await uploadWorkspaceFiles(files, currentPath, overwrite);
        setActionMessage(t("files.uploadedTo", { path: currentPath }));
        await refreshAfterUpload(currentPath);
      } catch (err) {
        if (err instanceof WorkspaceUploadConflictError && !overwrite) {
          const conflictNames = err.conflicts.map((conflict) => conflict.name).join(", ");
          const confirmed = await requestConfirmation({
            title: t("files.overwriteTitle"),
            message: t("files.overwriteFiles", {
              names: conflictNames,
              plural: err.conflicts.length === 1 ? "" : "s",
            }),
            confirmLabel: t("files.overwrite"),
            cancelLabel: t("files.cancel"),
            tone: "danger",
          });
          if (confirmed) {
            try {
              await uploadWorkspaceFiles(files, currentPath, true);
              setActionMessage(t("files.uploadedTo", { path: currentPath }));
              await refreshAfterUpload(currentPath);
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
    [currentPath, refreshAfterUpload, requestConfirmation, t, uploading]
  );

  const handleUploadInputChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files || []);
    event.target.value = "";
    void uploadFilesToCurrentDirectory(files);
  };

  const resolveDraggedEntries = useCallback(
    (event: React.DragEvent<Element>) => {
      const paths = getWorkspaceDragPaths(event.dataTransfer);
      if (paths.length === 0) return draggedEntries;

      return paths
        .map((path) => visibleEntriesByPath.get(path))
        .filter((entry): entry is WorkspaceEntry => Boolean(entry));
    },
    [draggedEntries, visibleEntriesByPath]
  );

  const hasDraggedFiles = (event: React.DragEvent<HTMLDivElement>) =>
    !hasDraggedWorkspaceEntries(event) && Array.from(event.dataTransfer.types).includes("Files");

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

  const handleEntryDragStart = (event: React.DragEvent<HTMLDivElement>, entry: WorkspaceEntry) => {
    if (isCoarsePointer) {
      event.preventDefault();
      return;
    }

    const entries = selectedEntryPaths.has(entry.path) ? selectedEntries : [entry];
    const dragEntries = entries.length > 0 ? entries : [entry];
    const paths = dragEntries.map((dragEntry) => dragEntry.path);

    setDraggedEntries(dragEntries);
    setContextMenu((prev) => ({ ...prev, visible: false }));
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData(WORKSPACE_DRAG_ENTRY_MIME, JSON.stringify({ paths }));
    event.dataTransfer.setData("text/plain", paths.join("\n"));
  };

  const handleEntryDragEnd = () => {
    setDraggedEntries([]);
    setDragTargetPath(null);
  };

  const handleDirectoryDragOver = (
    event: React.DragEvent<HTMLDivElement>,
    target: WorkspaceEntry
  ) => {
    if (!hasDraggedWorkspaceEntries(event)) return;

    event.preventDefault();
    event.stopPropagation();
    const entries = resolveDraggedEntries(event);
    if (!canMoveEntriesToDirectory(entries, target)) {
      event.dataTransfer.dropEffect = "none";
      setDragTargetPath((current) => (current === target.path ? null : current));
      return;
    }

    event.dataTransfer.dropEffect = "move";
    setDragTargetPath(target.path);
  };

  const handleDirectoryDragLeave = (
    event: React.DragEvent<HTMLDivElement>,
    target: WorkspaceEntry
  ) => {
    if (!hasDraggedWorkspaceEntries(event)) return;
    const nextTarget = event.relatedTarget;
    if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) return;
    setDragTargetPath((current) => (current === target.path ? null : current));
  };

  const handleDirectoryDrop = async (
    event: React.DragEvent<HTMLDivElement>,
    target: WorkspaceEntry
  ) => {
    if (!hasDraggedWorkspaceEntries(event)) return;

    event.preventDefault();
    event.stopPropagation();
    setDragTargetPath(null);
    setDraggedEntries([]);

    const entries = resolveDraggedEntries(event);
    if (!canMoveEntriesToDirectory(entries, target)) return;

    setError(null);
    const failed: WorkspaceEntry[] = [];
    const moved: WorkspaceEntry[] = [];
    for (const entry of entries) {
      try {
        await pasteWorkspaceEntry(entry.path, target.path, "move");
        moved.push(entry);
      } catch {
        failed.push(entry);
      }
    }

    const movedPaths = new Set(moved.map((entry) => entry.path));
    if (preview && movedPaths.has(preview.path)) {
      setPreview(null);
      setImagePreviewUrl(null);
      setDocumentPreview(null);
      setDraft("");
    }
    setSearchResults((current) => current.filter((entry) => !movedPaths.has(entry.path)));
    await loadDirectory(currentPath);

    if (failed.length > 0) {
      setSelectedEntryPaths(new Set(failed.map((entry) => entry.path)));
      setIsSelectionMode(true);
      setError(t("files.couldNotMove", { names: failed.map((entry) => entry.name).join(", ") }));
    }
  };

  const handleDownloadFile = async (path: string) => {
    setError(null);
    try {
      const downloaded = await downloadWorkspaceFile(path);
      saveBlobAsDownload(downloaded.blob, downloaded.filename);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
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

  const toggleEntrySelection = (entry: WorkspaceEntry, selected?: boolean) => {
    setSelectedEntryPaths((current) => {
      const next = new Set(current);
      const shouldSelect = selected ?? !next.has(entry.path);
      if (shouldSelect) {
        next.add(entry.path);
      } else {
        next.delete(entry.path);
      }
      return next;
    });
  };

  const clearSelection = () => {
    setSelectedEntryPaths(new Set());
  };

  const toggleSelectionMode = () => {
    setIsSelectionMode((active) => {
      if (active) {
        clearSelection();
        return false;
      }
      return true;
    });
  };

  const selectAllVisibleEntries = () => {
    setSelectedEntryPaths(new Set(visibleEntries.map((entry) => entry.path)));
  };

  const handleEntryClick = (event: React.MouseEvent, entry: WorkspaceEntry) => {
    if (shouldDismissWorkspaceContextMenuOnEntryClick(contextMenu.visible)) {
      event.preventDefault();
      event.stopPropagation();
      setContextMenu((prev) => ({ ...prev, visible: false }));
      return;
    }

    if (event.metaKey || event.ctrlKey) {
      event.preventDefault();
      setIsSelectionMode(true);
      toggleEntrySelection(entry);
      return;
    }
    void openEntry(entry);
  };

  const clearClipboard = () => {
    setClipboard(null);
    setContextMenu((prev) => ({ ...prev, visible: false }));
    setIsActionsMenuOpen(false);
  };

  const handleBatchClipboard = (action: "copy" | "move") => {
    if (selectedEntries.length === 0) return;
    setClipboard({ items: selectedEntries, action });
    setContextMenu((prev) => ({ ...prev, visible: false }));
  };

  const handleBatchDelete = async () => {
    if (selectedEntries.length === 0) return;
    const confirmed = await requestConfirmation({
      title: t("files.deleteSelectedTitle"),
      message: t("files.confirmBatchDelete", {
        count: selectedEntries.length,
        plural: selectedEntries.length === 1 ? "" : "s",
      }),
      confirmLabel: t("files.delete"),
      cancelLabel: t("files.cancel"),
      tone: "danger",
    });
    if (!confirmed) return;

    setError(null);
    setActionMessage(null);
    const failed: WorkspaceEntry[] = [];
    for (const entry of selectedEntries) {
      try {
        await deleteWorkspaceEntry(entry.path);
      } catch {
        failed.push(entry);
      }
    }

    const deletedPaths = new Set(
      selectedEntries
        .filter((entry) => !failed.some((failedEntry) => failedEntry.path === entry.path))
        .map((entry) => entry.path)
    );
    if (preview && deletedPaths.has(preview.path)) {
      setPreview(null);
      setImagePreviewUrl(null);
      setDocumentPreview(null);
      setDraft("");
    }
    setListing((current) => {
      if (!current) return current;
      return {
        ...current,
        entries: current.entries.filter((entry) => !deletedPaths.has(entry.path)),
      };
    });
    setSearchResults((current) => current.filter((entry) => !deletedPaths.has(entry.path)));
    setSelectedEntryPaths(new Set(failed.map((entry) => entry.path)));
    if (failed.length > 0) {
      setError(t("files.couldNotDelete", { names: failed.map((entry) => entry.name).join(", ") }));
    } else {
      setActionMessage(t("files.deletedItems", { count: deletedPaths.size }));
    }
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
      setActionMessage(t("files.createdEntry", { name: newEntry.name }));
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
    const confirmed = await requestConfirmation({
      title: t("files.deleteEntryTitle", { name: entry.name }),
      message: t("files.confirmDeleteEntry", { name: entry.name }),
      confirmLabel: t("files.delete"),
      cancelLabel: t("files.cancel"),
      tone: "danger",
    });
    if (!confirmed) return;
    setError(null);
    setActionMessage(null);
    try {
      await deleteWorkspaceEntry(entry.path);
      if (preview?.path === entry.path) {
        setPreview(null);
        setImagePreviewUrl(null);
        setDocumentPreview(null);
        setDraft("");
      }
      setListing((current) => {
        if (!current) return current;
        return {
          ...current,
          entries: current.entries.filter((item) => item.path !== entry.path),
        };
      });
      setSelectedEntryPaths((current) => {
        const next = new Set(current);
        next.delete(entry.path);
        return next;
      });
      setActionMessage(t("files.deletedEntry", { name: entry.name }));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleCut = (entry: WorkspaceEntry) => {
    setClipboard({
      items: [entry],
      action: "move",
    });
    setContextMenu((prev) => ({ ...prev, visible: false }));
  };

  const handleCopy = (entry: WorkspaceEntry) => {
    setClipboard({
      items: [entry],
      action: "copy",
    });
    setContextMenu((prev) => ({ ...prev, visible: false }));
  };

  const handlePaste = async () => {
    if (!clipboard) return;
    const destination = currentPath;
    setError(null);
    setActionMessage(null);
    try {
      for (const item of clipboard.items) {
        await pasteWorkspaceEntry(item.path, destination, clipboard.action);
      }
      if (clipboard.action === "move") {
        setClipboard(null);
        clearSelection();
      }
      setActionMessage(t("files.pastedItems", { count: clipboard.items.length }));
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

  const openWorkspaceContextMenuForEntry = (
    anchorRect: ViewportMenuAnchorRect,
    entry: WorkspaceEntry
  ) => {
    const { x, y } = getWorkspaceContextMenuPosition({
      anchorRect,
      entry,
      align: "right",
    });
    setContextMenu({
      visible: true,
      x,
      y,
      entry,
      anchorRect,
      align: "right",
      measuredHeight: null,
    });
  };

  const onMoreButtonClick = (event: React.MouseEvent, entry: WorkspaceEntry) => {
    event.preventDefault();
    event.stopPropagation();
    if (isCoarsePointer) {
      setMobileActionEntry(entry);
      return;
    }
    openWorkspaceContextMenuForEntry(event.currentTarget.getBoundingClientRect(), entry);
  };

  const handleEntryLongPressStart = (
    event: React.TouchEvent<HTMLDivElement>,
    entry: WorkspaceEntry
  ) => {
    if (!isCoarsePointer) return;
    clearLongPressTimer();
    longPressTimerRef.current = window.setTimeout(() => {
      setMobileActionEntry(entry);
      longPressTimerRef.current = null;
    }, 420);
    event.currentTarget.addEventListener(
      "touchmove",
      () => {
        clearLongPressTimer();
      },
      { once: true }
    );
  };

  const handleEntryLongPressEnd = () => {
    clearLongPressTimer();
  };

  const onEntryContextMenu = (event: React.MouseEvent, entry: WorkspaceEntry) => {
    event.preventDefault();
    event.stopPropagation();
    const { x, y } = getWorkspaceContextMenuPosition({
      anchorRect: {
        top: event.clientY,
        right: event.clientX,
        bottom: event.clientY,
        left: event.clientX,
      },
      entry,
      align: "left",
    });
    setContextMenu({
      visible: true,
      x,
      y,
      entry,
      anchorRect: {
        top: event.clientY,
        right: event.clientX,
        bottom: event.clientY,
        left: event.clientX,
      },
      align: "left",
      measuredHeight: null,
    });
  };

  const onContainerContextMenu = (event: React.MouseEvent) => {
    if (
      event.target === event.currentTarget ||
      (event.target as HTMLElement).classList.contains("context-trigger-area")
    ) {
      event.preventDefault();
      const { x, y } = getWorkspaceContextMenuPosition({
        anchorRect: {
          top: event.clientY,
          right: event.clientX,
          bottom: event.clientY,
          left: event.clientX,
        },
        entry: null,
        align: "left",
      });
      setContextMenu({
        visible: true,
        x,
        y,
        entry: null,
        anchorRect: {
          top: event.clientY,
          right: event.clientX,
          bottom: event.clientY,
          left: event.clientX,
        },
        align: "left",
        measuredHeight: null,
      });
    }
  };

  useEffect(() => {
    const handleGlobalClick = () => {
      setContextMenu((prev) => (prev.visible ? { ...prev, visible: false } : prev));
      setIsActionsMenuOpen(false);
    };
    window.addEventListener("click", handleGlobalClick);
    return () => {
      window.removeEventListener("click", handleGlobalClick);
    };
  }, []);

  useLayoutEffect(() => {
    if (!contextMenu.visible || !contextMenu.anchorRect) return;
    const menuNode = contextMenuRef.current;
    if (!menuNode) return;

    const measuredMenuHeight = Math.ceil(menuNode.getBoundingClientRect().height);
    if (!measuredMenuHeight || measuredMenuHeight === contextMenu.measuredHeight) return;

    const { x, y } = getWorkspaceContextMenuPosition({
      anchorRect: contextMenu.anchorRect,
      entry: contextMenu.entry,
      align: contextMenu.align,
      measuredMenuHeight,
    });

    setContextMenu((current) => {
      if (!current.visible || current.anchorRect !== contextMenu.anchorRect) return current;
      if (current.measuredHeight === measuredMenuHeight && current.x === x && current.y === y) {
        return current;
      }
      return {
        ...current,
        x,
        y,
        measuredHeight: measuredMenuHeight,
      };
    });
  }, [contextMenu]);

  useEffect(() => {
    if (!openFileRequest) return;

    if (openFileRequest.userId && openFileRequest.userId !== userId) {
      return;
    }

    let isCurrentRequest = true;
    void (async () => {
      await openWorkspaceFilePath(openFileRequest.path, openFileRequest.lineNumber);
      if (isCurrentRequest) {
        onOpenFileRequestConsumed?.(openFileRequest.id);
      }
    })();

    return () => {
      isCurrentRequest = false;
    };
  }, [openFileRequest, onOpenFileRequestConsumed, openWorkspaceFilePath, userId]);

  useEffect(() => {
    if (highlightedLine !== null && highlightedLineRef.current) {
      highlightedLineRef.current.scrollIntoView({
        behavior: "smooth",
        block: "center",
      });
    }
  }, [highlightedLine, preview?.path]);

  const isPreviewCollapsed = splitPercent >= MAX_SPLIT_PERCENT;
  const isPreviewPanelHidden = isPreviewCollapsed || !preview;
  const previewState = isPreviewCollapsed ? "collapsed" : preview ? "open" : "empty";
  const currentLocationPath = listing?.path || currentPath;
  const currentDisplayPath = isSearchMode ? searchModeLabel(searchScope, t) : currentLocationPath;
  const desktopPathLabel = isSearchMode
    ? t("files.searchQuery", { query: normalizedQuery })
    : currentLocationPath;
  const desktopPathDetail = isSearchMode ? searchModeLabel(searchScope, t) : null;
  const mobilePathLabel = isSearchMode
    ? t("files.searchQuery", { query: normalizedQuery })
    : currentLocationPath;
  const mobilePathDetail = isSearchMode ? searchModeLabel(searchScope, t) : null;
  const isPagePresentation = presentation === "page";
  const workspaceGridStyle:
    | (React.CSSProperties & { "--ripple-workspace-list-row"?: string })
    | undefined = !isPreviewPanelHidden
    ? {
        "--ripple-workspace-list-row": `minmax(96px, ${splitPercent}%) minmax(0, 1fr)`,
      }
    : undefined;


  return (
    <div
      data-ripple-workspace-explorer="finder-window"
      data-presentation={presentation}
      data-preview-state={previewState}
      className={
        isPagePresentation
          ? `relative flex h-full min-h-0 flex-col overflow-hidden text-[#1F2329] ${WORKBENCH_SECTION_CLASS}`
          : "relative flex h-full min-h-0 flex-col overflow-hidden bg-white text-[#1F2329]"
      }
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
        <div className="pointer-events-none absolute inset-0 z-50 flex items-center justify-center bg-white/86 p-4">
          <div
            className={`rounded-xl border border-dashed border-[#1456F0] bg-[#F0F5FF] px-4 py-3 text-[#0F4BD8] shadow-[0_1px_2px_rgba(31,35,41,0.04)] ${TYPOGRAPHY_BODY_MEDIUM_CLASS}`}
          >
            {t("files.dropFiles")}
          </div>
        </div>
      )}
      <WorkspaceToolbar
        presentation={presentation}
        onBack={onBack}
        query={query}
        onQueryChange={handleQueryChange}
        isSearchMode={isSearchMode}
        isFilterOpen={isFilterOpen}
        setIsFilterOpen={setIsFilterOpen}
        isMobileSearchOpen={isMobileSearchOpen}
        setIsMobileSearchOpen={setIsMobileSearchOpen}
        isActionsMenuOpen={isActionsMenuOpen}
        setIsActionsMenuOpen={setIsActionsMenuOpen}
        searchScope={searchScope}
        setSearchScope={setSearchScope}
        searchKind={searchKind}
        setSearchKind={setSearchKind}
        fileType={fileType}
        setFileType={setFileType}
        searchLimit={searchLimit}
        setSearchLimit={setSearchLimit}
        listing={listing}
        currentPath={currentPath}
        currentDisplayPath={currentDisplayPath}
        desktopPathLabel={desktopPathLabel}
        desktopPathDetail={desktopPathDetail}
        mobilePathLabel={mobilePathLabel}
        mobilePathDetail={mobilePathDetail}
        currentLocationPath={currentLocationPath}
        isSelectionActive={isSelectionActive}
        toggleSelectionMode={toggleSelectionMode}
        uploadInputRef={uploadInputRef}
        uploading={uploading}
        loading={loading}
        loadDirectory={(path) => void loadDirectory(path)}
      />

      {error && (
        <div
          className={`m-4 mb-0 flex items-start gap-2 rounded-md border border-[#B42318]/25 bg-[#FFF1F0] p-3 text-[#B42318] ${TYPOGRAPHY_META_MEDIUM_CLASS}`}
        >
          <AlertTriangle size={14} className="mt-0.5 shrink-0" />
          <span className="break-words">{displayError(error, t)}</span>
        </div>
      )}
      {searchError && (
        <div
          className={`m-4 mb-0 flex items-start gap-2 rounded-md border border-[#B42318]/25 bg-[#FFF1F0] p-3 text-[#B42318] ${TYPOGRAPHY_META_MEDIUM_CLASS}`}
        >
          <AlertTriangle size={14} className="mt-0.5 shrink-0" />
          <span className="break-words">{displayError(searchError, t)}</span>
        </div>
      )}
      {uploadError && (
        <div
          className={`m-4 mb-0 flex items-start gap-2 rounded-md border border-[#B42318]/25 bg-[#FFF1F0] p-3 text-[#B42318] ${TYPOGRAPHY_META_MEDIUM_CLASS}`}
        >
          <AlertTriangle size={14} className="mt-0.5 shrink-0" />
          <span className="break-words">{displayError(uploadError, t)}</span>
        </div>
      )}
      {actionMessage && (
        <div
          className={`m-4 mb-0 rounded-md border border-[#16845B]/20 bg-[#EFFAF5] p-3 text-[#16845B] ${TYPOGRAPHY_META_MEDIUM_CLASS}`}
        >
          {actionMessage}
        </div>
      )}

      <div
        ref={workspaceGridRef}
        style={workspaceGridStyle}
        className={`grid min-h-0 flex-1 overflow-hidden ${
          isPagePresentation
            ? isPreviewPanelHidden
              ? "grid-rows-[minmax(0,1fr)] lg:grid-cols-[minmax(0,1fr)] lg:grid-rows-none"
              : "grid-rows-[var(--ripple-workspace-list-row)] lg:grid-cols-[minmax(280px,360px)_minmax(0,1fr)] lg:grid-rows-none"
            : isPreviewPanelHidden
              ? "grid-rows-[minmax(0,1fr)]"
              : "grid-rows-[var(--ripple-workspace-list-row)]"
        }`}
      >
        <WorkspaceFileList
          isPagePresentation={isPagePresentation}
          isPreviewPanelHidden={isPreviewPanelHidden}
          loading={loading}
          listing={listing}
          searchLoading={searchLoading}
          visibleEntries={visibleEntries}
          isSearchMode={isSearchMode}
          currentPath={currentPath}
          selectedEntryCount={selectedEntryCount}
          isSelectionActive={isSelectionActive}
          allVisibleEntriesSelected={allVisibleEntriesSelected}
          selectedEntryPaths={selectedEntryPaths}
          selectedEntries={selectedEntries}
          preview={preview}
          locale={locale}
          renamingPath={renamingPath}
          renameDraft={renameDraft}
          renameSaving={renameSaving}
          renameInputRef={renameInputRef}
          dragTargetPath={dragTargetPath}
          draggedEntryPaths={draggedEntryPaths}
          clipboard={clipboard}
          isCoarsePointer={isCoarsePointer}
          loadDirectory={(path) => void loadDirectory(path)}
          selectAllVisibleEntries={selectAllVisibleEntries}
          clearSelection={clearSelection}
          handleBatchClipboard={handleBatchClipboard}
          handleBatchDelete={() => void handleBatchDelete()}
          setRenameDraft={setRenameDraft}
          commitRename={(entry) => void commitRename(entry)}
          handleRenameBlur={handleRenameBlur}
          handleRenameKeyDown={handleRenameKeyDown}
          handleEntryDragStart={handleEntryDragStart}
          handleEntryDragEnd={handleEntryDragEnd}
          handleDirectoryDragOver={handleDirectoryDragOver}
          handleDirectoryDragLeave={handleDirectoryDragLeave}
          handleDirectoryDrop={(event, entry) => void handleDirectoryDrop(event, entry)}
          onContainerContextMenu={onContainerContextMenu}
          onEntryContextMenu={onEntryContextMenu}
          handleEntryLongPressStart={handleEntryLongPressStart}
          handleEntryLongPressEnd={handleEntryLongPressEnd}
          handleEntryClick={handleEntryClick}
          handleFileDoubleClick={handleFileDoubleClick}
          startRename={startRename}
          toggleEntrySelection={toggleEntrySelection}
          onMoreButtonClick={onMoreButtonClick}
        />

        {!isPreviewPanelHidden && (
          <WorkspacePreviewPanel
            preview={preview}
            previewLoading={previewLoading}
            imagePreviewUrl={imagePreviewUrl}
            documentPreview={documentPreview}
            isPagePresentation={isPagePresentation}
            isEditing={isEditing}
            isDirty={isDirty}
            saving={saving}
            saveError={saveError}
            draft={draft}
            locale={locale}
            highlightedLine={highlightedLine}
            splitPercent={splitPercent}
            preContainerRef={preContainerRef}
            highlightedLineRef={highlightedLineRef}
            onToggleEditing={() => setIsEditing((current) => !current)}
            onOpenFullscreen={() => setIsPreviewFullscreenOpen(true)}
            onCollapse={() => updateSplitPercent(MAX_SPLIT_PERCENT)}
            onRevert={handleRevert}
            onSave={() => void handleSave()}
            onDraftChange={setDraft}
            onResizeStart={handlePreviewResizeStart}
            onResizeKeyDown={handlePreviewResizeKeyDown}
          />
        )}
      </div>

      <WorkspacePreviewFullscreen
        open={isPreviewFullscreenOpen}
        preview={preview}
        documentPreview={documentPreview}
        imagePreviewUrl={imagePreviewUrl}
        isEditing={isEditing}
        draft={draft}
        locale={locale}
        onClose={() => setIsPreviewFullscreenOpen(false)}
      />

      <WorkspaceActionMenus
        contextMenu={contextMenu}
        contextMenuRef={contextMenuRef}
        clipboard={clipboard}
        isPagePresentation={isPagePresentation}
        isActionsMenuOpen={isActionsMenuOpen}
        mobileActionEntry={mobileActionEntry}
        mobilePathLabel={mobilePathLabel}
        currentPath={currentPath}
        loading={loading}
        startRename={startRename}
        handleCut={handleCut}
        handleCopy={handleCopy}
        handleCopyAbsoluteSandboxPath={handleCopyAbsoluteSandboxPath}
        handleDownloadFile={(path) => void handleDownloadFile(path)}
        handleDelete={(entry) => void handleDelete(entry)}
        handlePaste={() => void handlePaste()}
        clearClipboard={clearClipboard}
        setCreationModal={setCreationModal}
        setContextMenu={setContextMenu}
        setIsActionsMenuOpen={setIsActionsMenuOpen}
        setMobileActionEntry={setMobileActionEntry}
        loadDirectory={(path) => void loadDirectory(path)}
        openEntry={(entry) => void openEntry(entry)}
      />

      <WorkspaceConfirmDialog confirmation={confirmation} onResolve={resolveConfirmation} />

      <WorkspaceCreateEntryDialog
        modal={creationModal}
        draft={creationDraft}
        saving={creationSaving}
        onDraftChange={setCreationDraft}
        onCancel={() => {
          setCreationModal(null);
          setCreationDraft("");
        }}
        onSubmit={handleCreate}
      />
    </div>
  );
}
