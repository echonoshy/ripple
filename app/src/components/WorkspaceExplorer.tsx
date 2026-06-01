"use client";

import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowUp,
  ChevronDown,
  Download,
  Edit3,
  FileText,
  Folder,
  FolderUp,
  Loader2,
  RefreshCw,
  Save,
  Search,
  SlidersHorizontal,
  SquareCheck,
  Undo2,
  Upload,
  Copy,
  Scissors,
  Clipboard,
  Trash2,
  FilePlus,
  FolderPlus,
  Maximize2,
  MoreHorizontal,
  MessageCircleReply,
  X,
} from "lucide-react";
import { IconTile } from "@/components/icons/IconTile";
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
import { saveBlobAsDownload } from "@/lib/platform";
import { readableApiErrorMessage } from "@/lib/apiErrors";
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

const SPLIT_PERCENT_STORAGE_KEY = "ripple.workspaceExplorer.splitPercent";
const DEFAULT_SPLIT_PERCENT = 48;
const MIN_SPLIT_PERCENT = 0;
const MAX_SPLIT_PERCENT = 100;
const DEFAULT_WORKSPACE_PATH = "/workspace";
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

export function getBoundedSplitPercent(value: number): number {
  return Math.min(MAX_SPLIT_PERCENT, Math.max(MIN_SPLIT_PERCENT, Math.round(value)));
}

export function getSplitPercentFromVerticalResize({
  containerTop,
  containerHeight,
  pointerY,
}: {
  containerTop: number;
  containerHeight: number;
  pointerY: number;
}): number {
  if (!Number.isFinite(containerHeight) || containerHeight <= 0) return DEFAULT_SPLIT_PERCENT;
  return getBoundedSplitPercent(((pointerY - containerTop) / containerHeight) * 100);
}

export function getSplitPercentAfterFileDoubleClick(currentSplitPercent: number): number {
  return currentSplitPercent >= MAX_SPLIT_PERCENT ? DEFAULT_SPLIT_PERCENT : currentSplitPercent;
}

function getDocumentPreviewFrameUrl(url: string): string {
  const separator = url.includes("#") ? "&" : "#";
  return `${url}${separator}toolbar=0&navpanes=0&scrollbar=0`;
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
  if (typeof window === "undefined") return DEFAULT_SPLIT_PERCENT;
  const rawValue = window.localStorage.getItem(SPLIT_PERCENT_STORAGE_KEY);
  if (rawValue === null) return DEFAULT_SPLIT_PERCENT;
  const stored = Number(rawValue);
  return Number.isFinite(stored) ? getBoundedSplitPercent(stored) : DEFAULT_SPLIT_PERCENT;
}

function initialIsCoarsePointer(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia("(pointer: coarse)").matches;
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

type WorkspacePreviewKind = "image" | "pdf" | "document" | "text";

const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "gif", "svg", "webp", "bmp", "ico"];
const OFFICE_EXTENSIONS = ["doc", "docx", "xls", "xlsx", "ppt", "pptx", "odt", "ods", "odp"];

function extensionFromName(name: string): string {
  return name.split(".").pop()?.toLowerCase() || "";
}

export function getWorkspacePreviewKind(
  entry: Pick<WorkspaceEntry, "name" | "mime_type">
): WorkspacePreviewKind {
  const mimeType = entry.mime_type || "";
  const ext = extensionFromName(entry.name);
  if (mimeType.startsWith("image/") || IMAGE_EXTENSIONS.includes(ext)) return "image";
  if (mimeType === "application/pdf" || ext === "pdf") return "pdf";
  if (
    OFFICE_EXTENSIONS.includes(ext) ||
    mimeType.includes("wordprocessingml") ||
    mimeType.includes("spreadsheetml") ||
    mimeType.includes("presentationml") ||
    mimeType === "application/msword" ||
    mimeType === "application/vnd.ms-excel" ||
    mimeType === "application/vnd.ms-powerpoint"
  ) {
    return "document";
  }
  return "text";
}

function workspaceEntryNameFromPath(path: string): string {
  return path.split(/[?#]/, 1)[0].split("/").filter(Boolean).at(-1) || "file";
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

export function getWorkspaceParentPath(path: string): string {
  const cleanPath = path.split(/[?#]/, 1)[0] || DEFAULT_WORKSPACE_PATH;
  const normalizedPath = cleanPath.startsWith("/workspace")
    ? cleanPath
    : `${DEFAULT_WORKSPACE_PATH}/${cleanPath.replace(/^\/+/, "")}`;
  const withoutTrailingSlash = normalizedPath.replace(/\/+$/, "") || DEFAULT_WORKSPACE_PATH;
  const slashIndex = withoutTrailingSlash.lastIndexOf("/");
  if (slashIndex <= DEFAULT_WORKSPACE_PATH.length - 1) return DEFAULT_WORKSPACE_PATH;
  return withoutTrailingSlash.slice(0, slashIndex) || DEFAULT_WORKSPACE_PATH;
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

function canMoveEntriesToDirectory(entries: WorkspaceEntry[], target: WorkspaceEntry): boolean {
  if (target.kind !== "directory" || entries.length === 0) return false;

  return entries.every((entry) => {
    if (entry.path === target.path) return false;
    if (target.path.startsWith(`${entry.path}/`)) return false;
    return getWorkspaceParentPath(entry.path) !== target.path;
  });
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
  const [downloadingPath, setDownloadingPath] = useState<string | null>(null);
  const [imagePreviewUrl, setImagePreviewUrl] = useState<string | null>(null);
  const [documentPreviewUrl, setDocumentPreviewUrl] = useState<string | null>(null);
  const [isPreviewFullscreenOpen, setIsPreviewFullscreenOpen] = useState(false);
  const [clipboard, setClipboard] = useState<{
    items: WorkspaceEntry[];
    action: "copy" | "move";
  } | null>(null);
  const [selectedEntryPaths, setSelectedEntryPaths] = useState<Set<string>>(() => new Set());
  const [isSelectionMode, setIsSelectionMode] = useState(false);
  const [draggedEntries, setDraggedEntries] = useState<WorkspaceEntry[]>([]);
  const [dragTargetPath, setDragTargetPath] = useState<string | null>(null);
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

  const [creationModal, setCreationModal] = useState<{
    visible: boolean;
    kind: "file" | "directory";
  } | null>(null);
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
    window.localStorage.setItem(SPLIT_PERCENT_STORAGE_KEY, String(splitPercent));
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
    return () => {
      if (documentPreviewUrl) URL.revokeObjectURL(documentPreviewUrl);
    };
  }, [documentPreviewUrl]);

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

  const updateSplitPercent = useCallback((value: number) => {
    setSplitPercent(getBoundedSplitPercent(value));
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
          setDocumentPreviewUrl(null);
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
          const documentUrl = URL.createObjectURL(documentPreview.blob);
          if (previewRequestIdRef.current !== requestId) {
            URL.revokeObjectURL(documentUrl);
            return;
          }
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
          setDocumentPreviewUrl(documentUrl);
          setDraft("");
        } else {
          const filePreview = await fetchWorkspaceFilePreview(targetPath, 256 * 1024);
          if (previewRequestIdRef.current !== requestId) return;
          setPreview(filePreview);
          setImagePreviewUrl(null);
          setDocumentPreviewUrl(null);
          setDraft(filePreview.content);
        }
        setIsEditing(false);
        setSaveError(null);
        setHighlightedLine(previewKind === "text" ? (lineNumber ?? null) : null);
      } catch (err) {
        if (previewRequestIdRef.current !== requestId) return;
        setPreview(null);
        setImagePreviewUrl(null);
        setDocumentPreviewUrl(null);
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
      setDocumentPreviewUrl(null);
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
    setDocumentPreviewUrl(null);

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
        setDocumentPreviewUrl(null);
        setDraft("");
        setIsEditing(false);
        setSaveError(null);
      } else if (previewKind === "pdf" || previewKind === "document") {
        const documentPreview = await fetchWorkspaceDocumentPreview(entry.path);
        const documentUrl = URL.createObjectURL(documentPreview.blob);
        if (previewRequestIdRef.current !== requestId) {
          URL.revokeObjectURL(documentUrl);
          return;
        }
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
        setDocumentPreviewUrl(documentUrl);
        setDraft("");
        setIsEditing(false);
        setSaveError(null);
      } else {
        const filePreview = await fetchWorkspaceFilePreview(entry.path, 256 * 1024);
        if (previewRequestIdRef.current !== requestId) return;
        setPreview(filePreview);
        setImagePreviewUrl(null);
        setDocumentPreviewUrl(null);
        setDraft(filePreview.content);
        setIsEditing(false);
        setSaveError(null);
      }
    } catch (err) {
      if (previewRequestIdRef.current !== requestId) return;
      setPreview(null);
      setImagePreviewUrl(null);
      setDocumentPreviewUrl(null);
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
      setDocumentPreviewUrl(null);
      setDraft("");
    }
    setSearchResults((current) => current.filter((entry) => !movedPaths.has(entry.path)));
    await loadDirectory(currentPath);

    if (failed.length > 0) {
      setSelectedEntryPaths(new Set(failed.map((entry) => entry.path)));
      setIsSelectionMode(true);
      setError(`Could not move ${failed.map((entry) => entry.name).join(", ")}`);
    }
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
    const confirmed = window.confirm(
      `Are you sure you want to delete ${selectedEntries.length} selected item${
        selectedEntries.length === 1 ? "" : "s"
      }?`
    );
    if (!confirmed) return;

    setError(null);
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
      setDocumentPreviewUrl(null);
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
      setError(`Could not delete ${failed.map((entry) => entry.name).join(", ")}`);
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
        setImagePreviewUrl(null);
        setDocumentPreviewUrl(null);
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
    setError(null);
    try {
      const destination = currentPath;
      for (const item of clipboard.items) {
        await pasteWorkspaceEntry(item.path, destination, clipboard.action);
      }
      if (clipboard.action === "move") {
        setClipboard(null);
        clearSelection();
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
    const { x, y } = getWorkspaceContextMenuPosition({
      anchorRect: rect,
      entry,
      align: "right",
    });
    setContextMenu({
      visible: true,
      x,
      y,
      entry,
      anchorRect: rect,
      align: "right",
      measuredHeight: null,
    });
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
  const currentDisplayPath = isSearchMode
    ? searchModeLabel(searchScope)
    : listing?.path || currentPath;
  const mobilePathLabel = isSearchMode
    ? `Search: ${normalizedQuery}`
    : listing?.path || currentPath;
  const mobilePathDetail = isSearchMode ? searchModeLabel(searchScope) : null;
  const isPagePresentation = presentation === "page";
  const pageToolbarIconButtonClass =
    "inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-[#dfe6f4] bg-white/78 text-[#384152] shadow-[0_10px_24px_rgba(44,63,123,0.06)] transition-colors hover:bg-white disabled:cursor-not-allowed disabled:opacity-50";
  const pageToolbarPrimaryButtonClass = pageToolbarIconButtonClass;
  const pageParentButtonClass =
    "inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-[#d7e3f8] bg-[#eef4ff] text-[#2463eb] shadow-[0_10px_24px_rgba(44,63,123,0.06)] transition-colors hover:bg-[#e5efff] lg:hidden";
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
          ? "relative flex h-full min-h-0 flex-col overflow-hidden rounded-[22px] border border-[#dfe6f4] bg-[#ffffff] text-[#111827] shadow-[0_22px_70px_rgba(44,63,123,0.08),inset_0_1px_0_rgba(255,255,255,0.92)]"
          : "relative flex h-full min-h-0 flex-col overflow-hidden bg-white text-[#0d0d0d]"
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
        <div className="pointer-events-none absolute inset-0 z-50 flex items-center justify-center bg-[#ffffff]/86 p-4 backdrop-blur-sm">
          <div className="rounded-2xl border border-dashed border-[#2463eb] bg-[#eef4ff] px-4 py-3 text-sm font-semibold text-[#2457e6] shadow-[0_18px_42px_rgba(44,63,123,0.12)]">
            Drop files to upload
          </div>
        </div>
      )}
      <div
        className={
          isPagePresentation
            ? "shrink-0 border-b border-[#dfe6f4]/80 bg-[linear-gradient(180deg,rgba(255,255,255,0.78),rgba(255,255,255,0.62))] px-3 py-3 backdrop-blur-2xl sm:px-4"
            : "shrink-0 border-b border-[#e5e7eb] bg-white px-4 py-3"
        }
      >
        <div
          data-ripple-files-toolbar-layout={isPagePresentation ? "stacked" : "compact"}
          className={isPagePresentation ? "flex flex-col gap-3" : "mb-2 flex items-center gap-2"}
        >
          {isPagePresentation && (
            <div data-ripple-files-title-row="page" className="flex min-w-0 items-center gap-2">
              {onBack ? (
                <button
                  type="button"
                  onClick={onBack}
                  aria-label="Back to session"
                  title="Back to session"
                  className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-[#2f6bff] bg-[#2f6bff] text-white shadow-[0_12px_26px_rgba(47,107,255,0.28)] transition-colors hover:bg-[#245de8] active:bg-[#1f4ed0] lg:hidden"
                >
                  <MessageCircleReply size={17} />
                </button>
              ) : null}
              <div className="min-w-0 flex-1">
                <h1 className="text-[15px] leading-tight font-semibold tracking-normal text-[#111827]">
                  Files
                </h1>
                <p
                  data-ripple-workspace-current-path="toolbar"
                  className="mt-1 truncate font-[family-name:var(--font-mono)] text-[11px] text-[#667085] lg:hidden"
                >
                  {listing?.path || currentPath}
                </p>
              </div>
              <button
                type="button"
                data-ripple-files-mobile-search-trigger
                onClick={() => {
                  setIsActionsMenuOpen(false);
                  setIsMobileSearchOpen(true);
                }}
                className={`inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border shadow-[0_10px_24px_rgba(44,63,123,0.06)] transition-colors lg:hidden ${
                  isSearchMode
                    ? "border-[#d7e3f8] bg-[#eef4ff] text-[#2463eb]"
                    : "border-[#dfe6f4] bg-white/78 text-[#384152] hover:bg-white"
                }`}
                title="Search workspace files"
                aria-label="Search workspace files"
              >
                <Search size={14} />
              </button>
              <button
                type="button"
                data-ripple-files-action="toggle-selection"
                onClick={toggleSelectionMode}
                className={`inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border shadow-[0_10px_24px_rgba(44,63,123,0.06)] transition-colors lg:hidden ${
                  isSelectionActive
                    ? "border-[#d7e3f8] bg-[#eef4ff] text-[#2463eb]"
                    : "border-[#dfe6f4] bg-white/78 text-[#384152] hover:bg-white"
                }`}
                title={isSelectionActive ? "Done selecting" : "Select files"}
                aria-label={isSelectionActive ? "Done selecting" : "Select files"}
              >
                {isSelectionActive ? <X size={14} /> : <SquareCheck size={14} />}
              </button>
              <button
                type="button"
                data-ripple-files-action="upload"
                className={`${pageToolbarPrimaryButtonClass} lg:hidden`}
                title="Upload files"
                aria-label="Upload files"
                disabled={uploading}
                onClick={() => uploadInputRef.current?.click()}
              >
                {uploading ? <Loader2 size={14} className="animate-spin" /> : <Upload size={14} />}
              </button>
              <button
                type="button"
                data-ripple-files-action="mobile-more"
                className={`${pageToolbarIconButtonClass} lg:hidden`}
                title="More file actions"
                aria-label="More file actions"
                onClick={(event) => {
                  event.stopPropagation();
                  setIsMobileSearchOpen(false);
                  setIsActionsMenuOpen((open) => !open);
                }}
              >
                <MoreHorizontal size={15} />
              </button>
            </div>
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
                className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-[#8b8f94]"
              />
              <input
                value={query}
                onChange={(event) => handleQueryChange(event.target.value)}
                placeholder="Find files by name..."
                aria-label="Search workspace files"
                className={
                  isPagePresentation
                    ? "h-9 w-full rounded-lg border border-[#dfe6f4] bg-white/84 pr-3 pl-9 text-sm text-[#111827] shadow-[inset_0_1px_0_rgba(255,255,255,0.8)] outline-none placeholder:text-xs placeholder:text-[#8b8f94] focus:border-[#2463eb]"
                    : "h-8 w-full rounded-full border border-[#e5e7eb] bg-white pr-2 pl-9 text-sm text-[#0d0d0d] outline-none placeholder:text-xs placeholder:text-[#8b8f94] focus:border-[#8da0ff]"
                }
              />
            </div>
            <button
              type="button"
              data-ripple-files-action="search-filters"
              className={
                isPagePresentation
                  ? `inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border transition-colors ${
                      isFilterOpen
                        ? "border-[#d7e3f8] bg-[#eef4ff] text-[#2463eb]"
                        : "border-[#dfe6f4] bg-white/78 text-[#384152] shadow-[0_10px_24px_rgba(44,63,123,0.06)] hover:bg-white"
                    }`
                  : `inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full border ${
                      isFilterOpen
                        ? "border-[#2f6bff]/30 bg-[#eef4ff] text-[#2f6bff]"
                        : "border-[#e5e7eb] bg-white text-[#6b7280] hover:bg-[#f7f8fa] hover:text-[#0d0d0d]"
                    }`
              }
              title="Search filters"
              aria-label="Search filters"
              onClick={() => setIsFilterOpen((open) => !open)}
            >
              <SlidersHorizontal size={14} />
            </button>
            <button
              type="button"
              data-ripple-files-action="toggle-selection"
              className={
                isPagePresentation
                  ? `inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border transition-colors ${
                      isSelectionActive
                        ? "border-[#d7e3f8] bg-[#eef4ff] text-[#2463eb]"
                        : "border-[#dfe6f4] bg-white/78 text-[#384152] shadow-[0_10px_24px_rgba(44,63,123,0.06)] hover:bg-white"
                    }`
                  : `inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full border ${
                      isSelectionActive
                        ? "border-[#2f6bff]/30 bg-[#eef4ff] text-[#2f6bff]"
                        : "border-[#e5e7eb] bg-white text-[#6b7280] hover:bg-[#f7f8fa] hover:text-[#0d0d0d]"
                    }`
              }
              title={isSelectionActive ? "Done selecting" : "Select files"}
              aria-label={isSelectionActive ? "Done selecting" : "Select files"}
              onClick={toggleSelectionMode}
            >
              {isSelectionActive ? <X size={14} /> : <SquareCheck size={14} />}
            </button>
            <button
              type="button"
              data-ripple-files-action="upload"
              className={
                isPagePresentation
                  ? pageToolbarPrimaryButtonClass
                  : "inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-[#e5e7eb] bg-white text-[#6b7280] hover:bg-[#f7f8fa] hover:text-[#0d0d0d] disabled:cursor-not-allowed disabled:opacity-50"
              }
              title="Upload files"
              aria-label="Upload files"
              disabled={uploading}
              onClick={() => uploadInputRef.current?.click()}
            >
              {uploading ? <Loader2 size={14} className="animate-spin" /> : <Upload size={14} />}
            </button>
            {!isPagePresentation && (
              <button
                type="button"
                data-ripple-files-action="compact-more"
                className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-[#e5e7eb] bg-white text-[#6b7280] hover:bg-[#f7f8fa] hover:text-[#0d0d0d]"
                title="More file actions"
                aria-label="More file actions"
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
                onClick={() => void loadDirectory(currentPath)}
                className={pageToolbarIconButtonClass}
                title="Refresh workspace"
                aria-label="Refresh workspace"
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
            className="mt-3 flex min-w-0 items-center gap-2 rounded-xl border border-[#dfe6f4]/80 bg-white/62 px-2.5 py-2 text-[#667085] lg:hidden"
          >
            {listing?.parent_path ? (
              <button
                type="button"
                data-ripple-files-action="parent-folder"
                className={pageParentButtonClass}
                title="Go to parent folder"
                aria-label="Go to parent folder"
                onClick={() => void loadDirectory(listing.parent_path || DEFAULT_WORKSPACE_PATH)}
              >
                <FolderUp size={18} />
              </button>
            ) : (
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[#f6f8ff] text-[#2463eb]">
                <Folder size={14} />
              </span>
            )}
            <div className="min-w-0 flex-1">
              <div className="truncate font-[family-name:var(--font-mono)] text-[11px] font-semibold text-[#374151]">
                {mobilePathLabel}
              </div>
              {mobilePathDetail && (
                <div className="mt-0.5 truncate text-[10px] font-medium text-[#667085]">
                  {mobilePathDetail}
                </div>
              )}
            </div>
            {isSearchMode && (
              <button
                type="button"
                onClick={() => setIsMobileSearchOpen(true)}
                className="inline-flex h-8 shrink-0 items-center rounded-lg border border-[#d7e3f8] bg-[#eef4ff] px-2 text-[11px] font-semibold text-[#2463eb]"
              >
                Edit
              </button>
            )}
          </div>
        )}
        {isPagePresentation && isActionsMenuOpen && (
          <div
            data-ripple-files-mobile-actions-menu
            className="absolute top-[76px] right-3 z-40 w-[220px] rounded-2xl border border-[#dfe6f4] bg-white p-1.5 text-xs text-[#374151] shadow-[0_18px_44px_rgba(44,63,123,0.16)] lg:hidden"
            onClick={(event) => event.stopPropagation()}
          >
            <button
              type="button"
              onClick={() => {
                setIsActionsMenuOpen(false);
                void loadDirectory(currentPath);
              }}
              disabled={loading}
              className="flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left font-semibold transition-colors hover:bg-[#f3f4f6] disabled:cursor-not-allowed disabled:opacity-50"
            >
              {loading ? (
                <Loader2 size={13} className="shrink-0 animate-spin text-[#6b7280]" />
              ) : (
                <RefreshCw size={13} className="shrink-0 text-[#6b7280]" />
              )}
              Refresh workspace
            </button>
            <button
              type="button"
              disabled={!clipboard}
              onClick={() => {
                setIsActionsMenuOpen(false);
                void handlePaste();
              }}
              className="flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left font-semibold transition-colors hover:bg-[#f3f4f6] disabled:cursor-not-allowed disabled:opacity-40"
            >
              <Clipboard size={13} className="shrink-0 text-[#6b7280]" />
              {clipboard ? (
                <>
                  Paste{" "}
                  {clipboard.items.length === 1
                    ? `(${clipboard.items[0]?.name})`
                    : `(${clipboard.items.length} items)`}
                </>
              ) : (
                "Paste"
              )}
            </button>
            {clipboard ? (
              <button
                type="button"
                onClick={clearClipboard}
                className="flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left font-semibold text-[#667085] transition-colors hover:bg-[#f3f4f6]"
              >
                <X size={13} className="shrink-0 text-[#6b7280]" />
                Clear clipboard
              </button>
            ) : null}
            <div className="my-1 border-t border-[#dfe6f4]" />
            <button
              type="button"
              onClick={() => {
                setCreationModal({ visible: true, kind: "file" });
                setIsActionsMenuOpen(false);
              }}
              className="flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left font-semibold transition-colors hover:bg-[#f3f4f6]"
            >
              <FilePlus size={13} className="shrink-0 text-[#6b7280]" />
              New File
            </button>
            <button
              type="button"
              onClick={() => {
                setCreationModal({ visible: true, kind: "directory" });
                setIsActionsMenuOpen(false);
              }}
              className="flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left font-semibold transition-colors hover:bg-[#f3f4f6]"
            >
              <FolderPlus size={13} className="shrink-0 text-[#6b7280]" />
              New Folder
            </button>
          </div>
        )}
        {!isPagePresentation && isActionsMenuOpen && (
          <div
            data-ripple-files-compact-actions-menu
            className="absolute top-[54px] right-3 z-40 w-[220px] rounded-2xl border border-[#dfe6f4] bg-white p-1.5 text-xs text-[#374151] shadow-[0_18px_44px_rgba(44,63,123,0.16)]"
            onClick={(event) => event.stopPropagation()}
          >
            <button
              type="button"
              onClick={() => {
                setIsActionsMenuOpen(false);
                void loadDirectory(currentPath);
              }}
              disabled={loading}
              className="flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left font-semibold transition-colors hover:bg-[#f3f4f6] disabled:cursor-not-allowed disabled:opacity-50"
            >
              {loading ? (
                <Loader2 size={13} className="shrink-0 animate-spin text-[#6b7280]" />
              ) : (
                <RefreshCw size={13} className="shrink-0 text-[#6b7280]" />
              )}
              Refresh workspace
            </button>
            <button
              type="button"
              disabled={!clipboard}
              onClick={() => {
                setIsActionsMenuOpen(false);
                void handlePaste();
              }}
              className="flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left font-semibold transition-colors hover:bg-[#f3f4f6] disabled:cursor-not-allowed disabled:opacity-40"
            >
              <Clipboard size={13} className="shrink-0 text-[#6b7280]" />
              {clipboard ? (
                <>
                  Paste{" "}
                  {clipboard.items.length === 1
                    ? `(${clipboard.items[0]?.name})`
                    : `(${clipboard.items.length} items)`}
                </>
              ) : (
                "Paste"
              )}
            </button>
            {clipboard ? (
              <button
                type="button"
                onClick={clearClipboard}
                className="flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left font-semibold text-[#667085] transition-colors hover:bg-[#f3f4f6]"
              >
                <X size={13} className="shrink-0 text-[#6b7280]" />
                Clear clipboard
              </button>
            ) : null}
            <div className="my-1 border-t border-[#dfe6f4]" />
            <button
              type="button"
              onClick={() => {
                setCreationModal({ visible: true, kind: "file" });
                setIsActionsMenuOpen(false);
              }}
              className="flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left font-semibold transition-colors hover:bg-[#f3f4f6]"
            >
              <FilePlus size={13} className="shrink-0 text-[#6b7280]" />
              New File
            </button>
            <button
              type="button"
              onClick={() => {
                setCreationModal({ visible: true, kind: "directory" });
                setIsActionsMenuOpen(false);
              }}
              className="flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left font-semibold transition-colors hover:bg-[#f3f4f6]"
            >
              <FolderPlus size={13} className="shrink-0 text-[#6b7280]" />
              New Folder
            </button>
          </div>
        )}
        {isFilterOpen && (
          <div
            className={
              isPagePresentation
                ? "mt-3 hidden gap-2 rounded-2xl border border-[#dfe6f4] bg-[#ffffff]/76 p-3 text-xs text-[#374151] shadow-[0_14px_36px_rgba(44,63,123,0.06)] lg:grid lg:grid-cols-2"
                : "mb-2 grid gap-2 rounded-2xl border border-[#e5e7eb] bg-[#fbfbfc] p-3 text-xs text-[#374151] shadow-sm sm:grid-cols-2"
            }
          >
            <label className="flex items-center gap-2">
              <span className="w-16 text-[#667085]">Scope</span>
              <select
                value={searchScope}
                onChange={(event) =>
                  setSearchScope(event.target.value as NonNullable<WorkspaceSearchOptions["scope"]>)
                }
                className="h-7 min-w-0 flex-1 rounded-lg border border-[#dfe6f4] bg-white/84 px-2 text-xs"
              >
                <option value="name">Name/path (default)</option>
                <option value="all">Name and content</option>
                <option value="content">Content</option>
              </select>
            </label>
            <label className="flex items-center gap-2">
              <span className="w-16 text-[#667085]">Kind</span>
              <select
                value={searchKind}
                onChange={(event) =>
                  setSearchKind(event.target.value as NonNullable<WorkspaceSearchOptions["kind"]>)
                }
                className="h-7 min-w-0 flex-1 rounded-lg border border-[#dfe6f4] bg-white/84 px-2 text-xs"
              >
                <option value="all">Files and folders</option>
                <option value="file">Files</option>
                <option value="directory">Folders</option>
              </select>
            </label>
            <label className="flex items-center gap-2">
              <span className="w-16 text-[#667085]">Type</span>
              <select
                value={fileType}
                onChange={(event) =>
                  setFileType(event.target.value as NonNullable<WorkspaceSearchOptions["fileType"]>)
                }
                className="h-7 min-w-0 flex-1 rounded-lg border border-[#dfe6f4] bg-white/84 px-2 text-xs"
              >
                <option value="all">All types</option>
                <option value="code">Code</option>
                <option value="markdown">Markdown</option>
                <option value="text">Text</option>
                <option value="image">Images</option>
              </select>
            </label>
            <label className="flex items-center gap-2">
              <span className="w-16 text-[#667085]">Results</span>
              <select
                value={searchLimit}
                onChange={(event) => setSearchLimit(Number(event.target.value))}
                className="h-7 min-w-0 flex-1 rounded-lg border border-[#dfe6f4] bg-white/84 px-2 text-xs"
              >
                <option value={20}>20</option>
                <option value={50}>50</option>
              </select>
            </label>
          </div>
        )}
        {!isPagePresentation && (
          <div className="flex items-center justify-between gap-2">
            <p className="min-w-0 truncate font-[family-name:var(--font-mono)] text-xs text-[#6b7280]">
              {currentDisplayPath}
            </p>
            <button
              type="button"
              onClick={() => void loadDirectory(currentPath)}
              className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-[#e5e7eb] bg-white text-[#6b7280] hover:bg-[#f7f8fa] hover:text-[#0d0d0d] disabled:cursor-not-allowed disabled:opacity-50"
              title="Refresh workspace"
              aria-label="Refresh workspace"
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
          className="fixed inset-0 z-50 flex items-end bg-[#172033]/18 p-2 pb-[max(env(safe-area-inset-bottom),8px)] backdrop-blur-[1px] lg:hidden"
          onClick={() => setIsMobileSearchOpen(false)}
        >
          <div
            className="w-full rounded-[22px] border border-[#dfe6f4] bg-white text-[#111827] shadow-[0_-18px_48px_rgba(44,63,123,0.16)]"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex items-center gap-2 border-b border-[#edf2fb] px-3 py-3">
              <button
                type="button"
                onClick={() => setIsMobileSearchOpen(false)}
                className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-[#dfe6f4] bg-white text-[#667085] hover:bg-[#f7f8fa]"
                aria-label="Close search"
                title="Close search"
              >
                <X size={16} />
              </button>
              <div className="min-w-0 flex-1">
                <div className="text-[14px] font-semibold text-[#111827]">Search workspace</div>
                <div className="mt-0.5 truncate font-[family-name:var(--font-mono)] text-[10px] text-[#667085]">
                  {listing?.path || currentPath}
                </div>
              </div>
              <button
                type="button"
                onClick={() => handleQueryChange("")}
                disabled={!isSearchMode}
                className="inline-flex h-9 items-center rounded-xl border border-[#dfe6f4] bg-white px-3 text-[12px] font-semibold text-[#667085] hover:bg-[#f7f8fa] disabled:cursor-not-allowed disabled:opacity-45"
              >
                Clear
              </button>
            </div>
            <div className="grid gap-3 px-3 py-3">
              <div className="relative">
                <Search
                  size={14}
                  className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-[#8b8f94]"
                />
                <input
                  value={query}
                  onChange={(event) => handleQueryChange(event.target.value)}
                  placeholder="Find files by name..."
                  aria-label="Search workspace files"
                  autoFocus
                  className="h-11 w-full rounded-xl border border-[#dfe6f4] bg-[#fbfdff] pr-3 pl-9 text-sm text-[#111827] outline-none placeholder:text-xs placeholder:text-[#8b8f94] focus:border-[#2463eb]"
                />
              </div>
              <div className="flex min-w-0 gap-1.5 overflow-x-auto pb-0.5">
                <span className="shrink-0 rounded-full border border-[#b8cdf8] bg-[#eef4ff] px-2 py-1 text-[10px] font-semibold text-[#2457e6]">
                  {searchScope === "content"
                    ? "Content"
                    : searchScope === "all"
                      ? "Name + content"
                      : "Name/path"}
                </span>
                <span className="shrink-0 rounded-full border border-[#dfe6f4] bg-[#f8fbff] px-2 py-1 text-[10px] font-medium text-[#667085]">
                  {searchKind === "directory"
                    ? "Folders"
                    : searchKind === "file"
                      ? "Files"
                      : "Files + folders"}
                </span>
                <span className="shrink-0 rounded-full border border-[#dfe6f4] bg-[#f8fbff] px-2 py-1 text-[10px] font-medium text-[#667085]">
                  {fileType === "all" ? "All types" : fileType}
                </span>
                <span className="shrink-0 rounded-full border border-[#dfe6f4] bg-[#f8fbff] px-2 py-1 text-[10px] font-medium text-[#667085]">
                  {searchLimit} results
                </span>
              </div>
              <div className="grid gap-2 text-xs text-[#374151]">
                <label className="flex items-center gap-2">
                  <span className="w-16 text-[#667085]">Scope</span>
                  <select
                    value={searchScope}
                    onChange={(event) =>
                      setSearchScope(
                        event.target.value as NonNullable<WorkspaceSearchOptions["scope"]>
                      )
                    }
                    className="h-9 min-w-0 flex-1 rounded-xl border border-[#dfe6f4] bg-white px-2 text-xs"
                  >
                    <option value="name">Name/path (default)</option>
                    <option value="all">Name and content</option>
                    <option value="content">Content</option>
                  </select>
                </label>
                <label className="flex items-center gap-2">
                  <span className="w-16 text-[#667085]">Kind</span>
                  <select
                    value={searchKind}
                    onChange={(event) =>
                      setSearchKind(
                        event.target.value as NonNullable<WorkspaceSearchOptions["kind"]>
                      )
                    }
                    className="h-9 min-w-0 flex-1 rounded-xl border border-[#dfe6f4] bg-white px-2 text-xs"
                  >
                    <option value="all">Files and folders</option>
                    <option value="file">Files</option>
                    <option value="directory">Folders</option>
                  </select>
                </label>
                <label className="flex items-center gap-2">
                  <span className="w-16 text-[#667085]">Type</span>
                  <select
                    value={fileType}
                    onChange={(event) =>
                      setFileType(
                        event.target.value as NonNullable<WorkspaceSearchOptions["fileType"]>
                      )
                    }
                    className="h-9 min-w-0 flex-1 rounded-xl border border-[#dfe6f4] bg-white px-2 text-xs"
                  >
                    <option value="all">All types</option>
                    <option value="code">Code</option>
                    <option value="markdown">Markdown</option>
                    <option value="text">Text</option>
                    <option value="image">Images</option>
                  </select>
                </label>
                <label className="flex items-center gap-2">
                  <span className="w-16 text-[#667085]">Results</span>
                  <select
                    value={searchLimit}
                    onChange={(event) => setSearchLimit(Number(event.target.value))}
                    className="h-9 min-w-0 flex-1 rounded-xl border border-[#dfe6f4] bg-white px-2 text-xs"
                  >
                    <option value={20}>20</option>
                    <option value={50}>50</option>
                  </select>
                </label>
              </div>
            </div>
          </div>
        </div>
      )}

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
        ref={workspaceGridRef}
        style={workspaceGridStyle}
        className={`grid min-h-0 flex-1 overflow-hidden ${
          isPagePresentation
            ? isPreviewPanelHidden
              ? "grid-rows-[minmax(0,1fr)] lg:grid-cols-[210px_minmax(0,1fr)] lg:grid-rows-none"
              : "grid-rows-[var(--ripple-workspace-list-row)] lg:grid-cols-[210px_minmax(260px,330px)_minmax(0,1fr)] lg:grid-rows-none"
            : isPreviewPanelHidden
              ? "grid-rows-[minmax(0,1fr)]"
              : "grid-rows-[var(--ripple-workspace-list-row)]"
        }`}
      >
        {isPagePresentation && (
          <aside
            data-ripple-workspace-location="current-path"
            className="hidden min-h-0 border-b border-[#dfe6f4]/70 bg-[linear-gradient(180deg,rgba(246,248,255,0.86),rgba(255,255,255,0.74))] p-3 lg:block lg:border-r lg:border-b-0"
          >
            <div className="rounded-2xl border border-[#dfe6f4]/80 bg-[#ffffff]/66 p-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.72)]">
              <div className="flex items-start gap-2">
                <IconTile tone="accent" size="sm" className="mt-0.5">
                  <Folder size={14} />
                </IconTile>
                <div className="min-w-0 flex-1">
                  <div className="truncate font-[family-name:var(--font-mono)] text-[11px] font-semibold text-[#374151]">
                    {listing?.path || currentPath}
                  </div>
                  {isSearchMode && (
                    <div className="mt-1 truncate text-[11px] text-[#6b7280]">
                      {searchModeLabel(searchScope)}
                    </div>
                  )}
                </div>
              </div>
              {(currentPath !== DEFAULT_WORKSPACE_PATH || listing?.parent_path) && (
                <div className="mt-3 flex items-center gap-2">
                  {listing?.parent_path && (
                    <button
                      type="button"
                      onClick={() =>
                        void loadDirectory(listing.parent_path || DEFAULT_WORKSPACE_PATH)
                      }
                      className="inline-flex h-7 items-center gap-1.5 rounded-full border border-[#dfe6f4] bg-white/74 px-2.5 text-[11px] font-semibold text-[#667085] hover:bg-[#f7f8fa] hover:text-[#111827]"
                    >
                      <ArrowUp size={12} />
                      Up
                    </button>
                  )}
                  {currentPath !== DEFAULT_WORKSPACE_PATH && (
                    <button
                      type="button"
                      onClick={() => void loadDirectory(DEFAULT_WORKSPACE_PATH)}
                      className="inline-flex h-7 items-center gap-1.5 rounded-full border border-[#dfe6f4] bg-white/74 px-2.5 text-[11px] font-semibold text-[#667085] hover:bg-[#f7f8fa] hover:text-[#111827]"
                    >
                      <Folder size={12} />
                      Root
                    </button>
                  )}
                </div>
              )}
            </div>
          </aside>
        )}

        <section
          data-ripple-workspace-file-list="browser"
          className={
            isPagePresentation
              ? "flex min-h-0 flex-col overflow-hidden border-b border-[#dfe6f4]/70 bg-[#ffffff] lg:border-r lg:border-b-0"
              : "flex min-h-0 flex-col overflow-hidden border-b border-[#e5e7eb] bg-white"
          }
        >
          {!isPagePresentation && (
            <div className="flex items-center justify-between border-b border-[#e5e7eb] bg-white px-3 py-2">
              <span className="text-xs font-semibold tracking-wider text-[#6b7280] uppercase">
                {isSearchMode ? "Search results" : "Workspace"}
              </span>
              <div className="flex items-center gap-1">
                {searchLoading && (
                  <Loader2 size={13} className="shrink-0 animate-spin text-[#667085]" />
                )}
                {!isSearchMode && listing?.parent_path && (
                  <button
                    type="button"
                    onClick={() =>
                      void loadDirectory(listing.parent_path || DEFAULT_WORKSPACE_PATH)
                    }
                    className="flex items-center gap-1 rounded-md border border-[#e5e7eb] bg-white px-2 py-1 text-[11px] font-medium text-[#6b7280] hover:bg-[#f7f8fa] hover:text-[#0d0d0d]"
                  >
                    <ArrowUp size={12} />
                    Up
                  </button>
                )}
              </div>
            </div>
          )}
          {isPagePresentation && searchLoading && visibleEntries.length > 0 && (
            <div className="flex h-[34px] items-center justify-end border-b border-[#dfe6f4]/60 px-3 text-[#667085]">
              <Loader2 size={13} className="animate-spin" />
            </div>
          )}
          {isSelectionActive && (
            <div
              data-ripple-files-selection-bar
              className="flex min-h-11 flex-wrap items-center gap-2 border-b border-[#dfe6f4]/70 bg-[#f8faff] px-3 py-2 text-xs text-[#384152]"
            >
              <span className="mr-auto font-semibold">{selectedEntryCount} selected</span>
              <button
                type="button"
                onClick={selectAllVisibleEntries}
                disabled={allVisibleEntriesSelected}
                className="inline-flex h-7 items-center rounded-full border border-[#dfe6f4] bg-white px-2.5 text-[11px] font-semibold hover:bg-[#f7f8fa]"
              >
                Select all
              </button>
              <button
                type="button"
                onClick={clearSelection}
                className="inline-flex h-7 items-center rounded-full border border-[#dfe6f4] bg-white px-2.5 text-[11px] font-semibold hover:bg-[#f7f8fa]"
              >
                Clear selection
              </button>
              <button
                type="button"
                onClick={() => handleBatchClipboard("copy")}
                disabled={selectedEntryCount === 0}
                className="inline-flex h-7 items-center gap-1 rounded-full border border-[#dfe6f4] bg-white px-2.5 text-[11px] font-semibold hover:bg-[#f7f8fa]"
              >
                <Copy size={12} />
                Copy
              </button>
              <button
                type="button"
                onClick={() => handleBatchClipboard("move")}
                disabled={selectedEntryCount === 0}
                className="inline-flex h-7 items-center gap-1 rounded-full border border-[#dfe6f4] bg-white px-2.5 text-[11px] font-semibold hover:bg-[#f7f8fa]"
              >
                <Scissors size={12} />
                Move
              </button>
              <button
                type="button"
                onClick={() => void handleBatchDelete()}
                disabled={selectedEntryCount === 0}
                className="inline-flex h-7 items-center gap-1 rounded-full border border-[#cf222e]/25 bg-white px-2.5 text-[11px] font-semibold text-[#cf222e] hover:bg-[#ffebe9]"
              >
                <Trash2 size={12} />
                Delete
              </button>
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
              <div className="flex h-40 items-center justify-center gap-2 text-sm font-medium text-[#667085]">
                <Loader2 size={16} className="animate-spin" />
                Loading
              </div>
            ) : (listing || isSearchMode) && visibleEntries.length === 0 ? (
              <div className="flex h-40 items-center justify-center px-4 text-center text-sm font-medium text-[#667085]">
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
                      className={
                        isPagePresentation
                          ? `mb-1 grid min-h-10 w-full grid-cols-[20px_minmax(0,1fr)_auto] items-center gap-2 rounded-xl px-2 py-1.5 text-left ${
                              preview?.path === entry.path ? "bg-[#eef4ff]" : "bg-transparent"
                            }`
                          : `flex w-full items-center gap-2.5 px-3 py-1.5 text-left ${
                              preview?.path === entry.path ? "bg-[#eef4ff]" : "bg-white"
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
                          className="h-7 w-full rounded-lg border border-[#2463eb] bg-white px-2 font-[family-name:var(--font-mono)] text-[13px] font-medium text-[#111827] outline-none"
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
                      draggable={!isCoarsePointer}
                      data-ripple-files-drop-target={
                        entry.kind === "directory" ? "directory" : undefined
                      }
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
                          ? (event) => void handleDirectoryDrop(event, entry)
                          : undefined
                      }
                      onContextMenu={(event) => onEntryContextMenu(event, entry)}
                      className={
                        isPagePresentation
                          ? `group mb-1 grid min-h-10 w-full ${
                              isSelectionActive
                                ? "grid-cols-[28px_minmax(0,1fr)_auto]"
                                : "grid-cols-[minmax(0,1fr)_auto]"
                            } items-center rounded-xl transition-colors hover:bg-[#f7f8fa] ${
                              selectedEntryPaths.has(entry.path)
                                ? "bg-[#eaf2ff] shadow-[inset_0_0_0_1px_rgba(47,107,255,0.14)]"
                                : preview?.path === entry.path
                                  ? "bg-[#eef4ff] shadow-[inset_0_0_0_1px_rgba(47,107,255,0.08)]"
                                  : "bg-transparent"
                            } ${
                              dragTargetPath === entry.path
                                ? "bg-[#eef4ff] shadow-[inset_0_0_0_2px_rgba(47,107,255,0.24)]"
                                : ""
                            } ${draggedEntryPaths.has(entry.path) ? "opacity-45" : ""} ${
                              clipboard?.action === "move" &&
                              clipboard?.items.some((item) => item.path === entry.path)
                                ? "opacity-35 select-none"
                                : ""
                            }`
                          : `group flex w-full items-center transition-colors hover:bg-[#f7f8fa] ${
                              selectedEntryPaths.has(entry.path)
                                ? "bg-[#eaf2ff]"
                                : preview?.path === entry.path
                                  ? "bg-[#eef4ff]"
                                  : "bg-white"
                            } ${dragTargetPath === entry.path ? "bg-[#eef4ff]" : ""} ${
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
                            aria-label={`Select ${entry.name}`}
                            onChange={(event) => toggleEntrySelection(entry, event.target.checked)}
                            className="h-4 w-4 rounded border-[#c7d2e5] text-[#2463eb] accent-[#2463eb]"
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
                        <IconTile
                          tone={entry.kind === "directory" ? "accent" : "neutral"}
                          size="xs"
                        >
                          {entry.kind === "directory" ? (
                            <Folder size={14} />
                          ) : (
                            <FileText size={14} />
                          )}
                        </IconTile>
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
                        className={
                          isPagePresentation
                            ? "mr-2 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-transparent text-[#667085] opacity-100 transition-opacity hover:border-[#dfe6f4] hover:bg-white/78 hover:text-[#111827] focus:opacity-100 sm:h-7 sm:w-7 sm:opacity-0 sm:group-hover:opacity-100"
                            : "mr-2 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-transparent text-[#6b7280] opacity-100 transition-opacity hover:border-[#dde2ea] hover:bg-white hover:text-[#0d0d0d] focus:opacity-100 sm:h-7 sm:w-7 sm:opacity-0 sm:group-hover:opacity-100"
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

        {!isPreviewPanelHidden && (
          <section
            data-ripple-workspace-preview="preview"
            className={
              isPagePresentation
                ? "flex min-h-0 flex-col overflow-hidden bg-[linear-gradient(180deg,#ffffff,#fbfdff)]"
                : "relative flex min-h-0 flex-col overflow-hidden bg-white"
            }
          >
            <div
              role="separator"
              aria-label="Resize preview panel"
              aria-orientation="horizontal"
              aria-valuemin={MIN_SPLIT_PERCENT}
              aria-valuemax={MAX_SPLIT_PERCENT}
              aria-valuenow={splitPercent}
              data-ripple-workspace-preview-resize
              tabIndex={0}
              onPointerDown={handlePreviewResizeStart}
              onKeyDown={handlePreviewResizeKeyDown}
              className={
                isPagePresentation
                  ? "group absolute top-0 right-0 left-0 z-20 flex h-3 -translate-y-1/2 cursor-row-resize items-center justify-center bg-transparent transition-colors outline-none hover:bg-[#dbe6ff]/70 focus:bg-[#dbe6ff]/70 lg:hidden"
                  : "group absolute top-0 right-0 left-0 z-20 flex h-3 -translate-y-1/2 cursor-row-resize items-center justify-center bg-transparent transition-colors outline-none hover:bg-[#dbe6ff]/70 focus:bg-[#dbe6ff]/70"
              }
            >
              <span className="h-0.5 w-12 rounded-full bg-[#2463eb] opacity-0 transition-opacity group-hover:opacity-100 group-focus:opacity-100" />
            </div>
            <div
              className={
                isPagePresentation
                  ? "flex min-h-[40px] shrink-0 items-center gap-2 border-b border-[#dfe6f4]/60 px-2 py-1 text-[#667085] sm:min-h-[68px] sm:gap-3 sm:px-4 sm:py-3"
                  : "flex shrink-0 items-center gap-2 border-b border-[#e5e7eb] bg-white px-3 py-2 text-[#6b7280]"
              }
            >
              <IconTile
                tone={isPagePresentation ? "accent" : "neutral"}
                size={isPagePresentation ? "sm" : "md"}
              >
                <FileText size={isPagePresentation ? 13 : 15} />
              </IconTile>
              <span className="min-w-0 flex-1">
                <span
                  className={
                    isPagePresentation
                      ? "block truncate text-[12px] leading-tight font-semibold text-[#111827] sm:text-[14px]"
                      : "block truncate text-[13px] font-semibold text-[#0d0d0d]"
                  }
                >
                  {isPagePresentation
                    ? preview?.name || "Select a file"
                    : preview?.path || "Select a file"}
                </span>
                {isPagePresentation && (
                  <span
                    data-ripple-workspace-preview-title-path
                    className="hidden truncate font-[family-name:var(--font-mono)] text-[11px] text-[#667085] sm:mt-1 sm:block"
                  >
                    {preview?.path || "Select a file"}
                  </span>
                )}
              </span>
              {previewLoading && <Loader2 size={12} className="animate-spin" />}
              {preview && (
                <div className="flex shrink-0 items-center gap-1">
                  <button
                    type="button"
                    data-ripple-workspace-preview-action="download"
                    onClick={() => void handleDownloadFile(preview.path)}
                    disabled={downloadingPath === preview.path}
                    className={
                      isPagePresentation
                        ? "hidden h-7 items-center gap-1 rounded-full border border-[#dfe6f4] bg-white/76 px-2 text-xs font-medium text-[#667085] hover:bg-[#f7f8fa] disabled:cursor-not-allowed disabled:text-[#8b8f94] sm:inline-flex"
                        : "inline-flex h-7 items-center gap-1 rounded-md border border-[#dde2ea] bg-white px-2 text-xs font-medium text-[#68707d] hover:bg-[#f7f8fa] disabled:cursor-not-allowed disabled:text-[#8b8f94]"
                    }
                    title="Download"
                  >
                    {downloadingPath === preview.path ? (
                      <Loader2 size={12} className="animate-spin" />
                    ) : (
                      <Download size={12} />
                    )}
                    Download
                  </button>
                  {!imagePreviewUrl && !documentPreviewUrl && (
                    <button
                      type="button"
                      disabled={preview.truncated}
                      onClick={() => setIsEditing((current) => !current)}
                      className={`inline-flex h-7 items-center gap-1 rounded-full border px-2 text-xs font-medium ${
                        isEditing
                          ? "border-[#2463eb] bg-[#eef4ff] text-[#384152]"
                          : isPagePresentation
                            ? "border-[#dfe6f4] bg-white/76 text-[#667085] hover:bg-[#f7f8fa] disabled:cursor-not-allowed disabled:text-[#8b8f94]"
                            : "border-[#dde2ea] bg-white text-[#68707d] hover:bg-[#f7f8fa] disabled:cursor-not-allowed disabled:text-[#8b8f94]"
                      }`}
                      title={preview.truncated ? "Truncated files cannot be edited safely" : "Edit"}
                    >
                      <Edit3 size={12} />
                      Edit
                    </button>
                  )}
                  <button
                    type="button"
                    aria-label="Open fullscreen preview"
                    title="Fullscreen preview"
                    onClick={() => setIsPreviewFullscreenOpen(true)}
                    className={
                      isPagePresentation
                        ? "inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-[#dfe6f4] bg-white/76 text-[#667085] hover:bg-[#f7f8fa] hover:text-[#111827] sm:h-7 sm:w-7"
                        : "inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-[#dde2ea] bg-white text-[#68707d] hover:bg-[#f7f8fa] hover:text-[#0d0d0d]"
                    }
                  >
                    <Maximize2 size={isPagePresentation ? 12 : 13} />
                  </button>
                </div>
              )}
              <button
                type="button"
                aria-label="Collapse preview panel"
                title="Collapse panel"
                onClick={() => updateSplitPercent(MAX_SPLIT_PERCENT)}
                className={
                  isPagePresentation
                    ? "inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-[#dfe6f4] bg-white/76 text-[#667085] hover:bg-[#f7f8fa] hover:text-[#111827] sm:h-7 sm:w-7"
                    : "inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-[#dde2ea] bg-white text-[#68707d] hover:bg-[#f7f8fa] hover:text-[#0d0d0d]"
                }
              >
                <ChevronDown size={isPagePresentation ? 12 : 13} />
              </button>
            </div>
            <div
              className={
                isPagePresentation
                  ? "min-h-0 flex-1 overflow-hidden"
                  : "min-h-0 flex-1 overflow-hidden bg-white"
              }
            >
              {preview ? (
                <div className="flex h-full min-h-0 flex-col">
                  <div
                    data-ripple-workspace-preview-metadata
                    className={
                      isPagePresentation
                        ? "hidden flex-wrap items-center gap-2 border-b border-[#dfe6f4]/60 px-4 py-2 font-[family-name:var(--font-mono)] text-[11px] font-medium text-[#667085] sm:flex"
                        : "flex flex-wrap items-center gap-2 border-b border-[#dde2ea] px-3 py-2 font-[family-name:var(--font-mono)] text-[11px] font-medium text-[#68707d]"
                    }
                  >
                    <span>{formatBytes(preview.size_bytes)}</span>
                    <span>{preview.mime_type}</span>
                    <span>{formatModified(preview.modified_at)}</span>
                    {isDirty && (
                      <span className="rounded-full border border-[#2463eb]/25 bg-[#eef4ff] px-1.5 py-0.5 text-[10px] text-[#2457e6] uppercase">
                        unsaved
                      </span>
                    )}
                    {preview.truncated && (
                      <span className="rounded-full border border-[#2463eb]/35 bg-[#eef4ff] px-1.5 py-0.5 text-[10px] text-[#1d56d8] uppercase">
                        truncated
                      </span>
                    )}
                    {isEditing && (
                      <div className="ml-auto flex items-center gap-1">
                        <button
                          type="button"
                          onClick={handleRevert}
                          disabled={!isDirty || saving}
                          className={
                            isPagePresentation
                              ? "inline-flex h-7 items-center gap-1 rounded-full border border-[#dfe6f4] bg-white/76 px-2 text-xs font-medium text-[#667085] hover:bg-[#f7f8fa] disabled:cursor-not-allowed disabled:text-[#8b8f94]"
                              : "inline-flex h-7 items-center gap-1 rounded-md border border-[#dde2ea] bg-white px-2 text-xs font-medium text-[#68707d] hover:bg-[#f7f8fa] disabled:cursor-not-allowed disabled:text-[#8b8f94]"
                          }
                        >
                          <Undo2 size={12} />
                          Revert
                        </button>
                        <button
                          type="button"
                          onClick={() => void handleSave()}
                          disabled={!isDirty || saving || preview.truncated}
                          className={
                            isPagePresentation
                              ? "inline-flex h-7 items-center gap-1 rounded-full border border-[#384152] bg-[#384152] px-2 text-xs font-semibold text-white hover:bg-[#111827] disabled:cursor-not-allowed disabled:border-[#dfe6f4] disabled:bg-[#f7f8fa] disabled:text-[#8b8f94]"
                              : "inline-flex h-7 items-center gap-1 rounded-md border border-[#171a1f] bg-[#171a1f] px-2 text-xs font-semibold text-white hover:bg-[#2a2f37] disabled:cursor-not-allowed disabled:border-[#dde2ea] disabled:bg-[#f7f8fa] disabled:text-[#8b8f94]"
                          }
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
                    <div className="m-3 mb-0 flex items-start gap-2 rounded-xl border border-[#cf222e]/25 bg-[#ffebe9] p-3 text-xs font-medium text-[#cf222e]">
                      <AlertTriangle size={14} className="mt-0.5 shrink-0" />
                      <span>{saveError}</span>
                    </div>
                  )}
                  {documentPreviewUrl ? (
                    <div
                      data-ripple-workspace-document-preview
                      className={
                        isPagePresentation
                          ? "min-h-0 flex-1 overflow-hidden bg-[#f4f7fb]"
                          : "min-h-0 flex-1 overflow-hidden bg-[#f8fafc]"
                      }
                    >
                      <iframe
                        src={getDocumentPreviewFrameUrl(documentPreviewUrl)}
                        title={`${preview.name} preview`}
                        className="h-full min-h-0 w-full border-0 bg-white"
                      />
                    </div>
                  ) : imagePreviewUrl ? (
                    <div
                      className={
                        isPagePresentation
                          ? "flex min-h-[300px] flex-1 items-center justify-center overflow-auto bg-[#fbfdff] p-6"
                          : "flex min-h-[300px] flex-1 items-center justify-center overflow-auto bg-[#f8fafc] p-6"
                      }
                    >
                      <img
                        src={imagePreviewUrl}
                        alt={preview.name}
                        className={
                          isPagePresentation
                            ? "max-h-[480px] max-w-full rounded-2xl border border-[#dfe6f4] bg-white object-contain p-1.5 shadow-[0_14px_34px_rgba(44,63,123,0.06)] transition-all hover:shadow-[0_18px_42px_rgba(44,63,123,0.10)]"
                            : "max-h-[480px] max-w-full rounded-md border border-[#e2e8f0] bg-white object-contain p-1.5 shadow-sm transition-all hover:shadow"
                        }
                      />
                    </div>
                  ) : isEditing ? (
                    <textarea
                      value={draft}
                      onChange={(event) => setDraft(event.target.value)}
                      spellCheck={false}
                      className={
                        isPagePresentation
                          ? "min-h-0 flex-1 resize-none overflow-auto border-0 bg-[#ffffff] p-4 font-[family-name:var(--font-mono)] text-[12px] leading-relaxed text-[#111827] outline-none"
                          : "min-h-0 flex-1 resize-none overflow-auto border-0 bg-white p-3 font-[family-name:var(--font-mono)] text-[12px] leading-relaxed text-[#171a1f] outline-none"
                      }
                    />
                  ) : (
                    <div
                      ref={preContainerRef}
                      className={
                        isPagePresentation
                          ? "min-h-0 flex-1 overflow-auto bg-[#ffffff] p-4"
                          : "min-h-0 flex-1 overflow-auto bg-white"
                      }
                    >
                      {(() => {
                        const lines = preview.content.split("\n");
                        return (
                          <div
                            className={
                              isPagePresentation
                                ? "rounded-2xl border border-[#dfe6f4]/80 bg-white/70 py-3 shadow-[0_14px_34px_rgba(44,63,123,0.06),inset_0_1px_0_rgba(255,255,255,0.72)]"
                                : "py-2"
                            }
                          >
                            {lines.map((line, idx) => {
                              const lineNum = idx + 1;
                              const isLineHighlighted = highlightedLine === lineNum;
                              return (
                                <div
                                  key={lineNum}
                                  ref={isLineHighlighted ? highlightedLineRef : undefined}
                                  className={`flex min-w-0 items-start font-[family-name:var(--font-mono)] text-[12px] leading-relaxed transition-colors ${
                                    isLineHighlighted
                                      ? isPagePresentation
                                        ? "border-l-4 border-[#2463eb] bg-[#eef4ff] pl-2"
                                        : "border-l-2 border-[#2463eb] bg-[#eef4ff] pl-[10px]"
                                      : isPagePresentation
                                        ? "pl-3 hover:bg-[#f7f8fa]"
                                        : "pl-3 hover:bg-[#f8fafc]"
                                  }`}
                                >
                                  <span className="w-9 shrink-0 pr-3 text-right text-[#afb1b7] select-none">
                                    {lineNum}
                                  </span>
                                  <span className="flex-1 break-all whitespace-pre-wrap text-[#111827]">
                                    {line || " "}
                                  </span>
                                </div>
                              );
                            })}
                          </div>
                        );
                      })()}
                    </div>
                  )}
                </div>
              ) : (
                <div className="flex h-full items-center justify-center px-4 text-center text-sm font-medium text-[#667085]">
                  Select a file
                </div>
              )}
            </div>
          </section>
        )}
      </div>

      {isPreviewFullscreenOpen && preview && (
        <div
          data-ripple-workspace-preview-fullscreen
          className="fixed inset-0 z-[70] flex min-h-0 flex-col bg-white text-[#111827]"
        >
          <div className="flex min-h-[48px] shrink-0 items-center gap-2 border-b border-[#dfe6f4] bg-white px-3 py-2 sm:min-h-[60px] sm:gap-3 sm:px-4">
            <IconTile tone="accent" size="sm">
              <FileText size={13} />
            </IconTile>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13px] leading-tight font-semibold text-[#111827] sm:text-[15px]">
                {preview.name}
              </span>
              <span className="mt-0.5 hidden truncate font-[family-name:var(--font-mono)] text-[11px] text-[#667085] sm:block">
                {preview.path}
              </span>
            </span>
            <div className="hidden shrink-0 items-center gap-2 font-[family-name:var(--font-mono)] text-[11px] font-medium text-[#667085] md:flex">
              <span>{formatBytes(preview.size_bytes)}</span>
              <span>{preview.mime_type}</span>
              <span>{formatModified(preview.modified_at)}</span>
            </div>
            <button
              type="button"
              aria-label="Close fullscreen preview"
              title="Close fullscreen preview"
              onClick={() => setIsPreviewFullscreenOpen(false)}
              className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-[#dfe6f4] bg-white text-[#667085] hover:bg-[#f7f8fa] hover:text-[#111827]"
            >
              <X size={15} />
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-hidden bg-[#f4f7fb]">
            {documentPreviewUrl ? (
              <iframe
                src={getDocumentPreviewFrameUrl(documentPreviewUrl)}
                title={`${preview.name} fullscreen preview`}
                className="h-full min-h-0 w-full border-0 bg-white"
              />
            ) : imagePreviewUrl ? (
              <div className="flex h-full min-h-0 items-center justify-center overflow-auto bg-[#f8fafc] p-4 sm:p-8">
                <img
                  src={imagePreviewUrl}
                  alt={preview.name}
                  className="max-h-full max-w-full rounded-lg border border-[#dfe6f4] bg-white object-contain p-1.5 shadow-[0_18px_42px_rgba(44,63,123,0.10)]"
                />
              </div>
            ) : (
              <div className="h-full min-h-0 overflow-auto bg-white p-4 sm:p-6">
                <div className="mx-auto max-w-6xl rounded-lg border border-[#dfe6f4] bg-white py-3 shadow-[0_14px_34px_rgba(44,63,123,0.06)]">
                  {(isEditing ? draft : preview.content).split("\n").map((line, idx) => {
                    const lineNum = idx + 1;
                    return (
                      <div
                        key={lineNum}
                        className="flex min-w-0 items-start font-[family-name:var(--font-mono)] text-[12px] leading-relaxed hover:bg-[#f7f8fa]"
                      >
                        <span className="w-11 shrink-0 pr-3 text-right text-[#afb1b7] select-none">
                          {lineNum}
                        </span>
                        <span className="flex-1 break-all whitespace-pre-wrap text-[#111827]">
                          {line || " "}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* 右键菜单 */}
      {contextMenu.visible && (
        <div
          ref={contextMenuRef}
          style={{ top: contextMenu.y, left: contextMenu.x }}
          className="animate-in fade-in-50 zoom-in-95 fixed z-50 max-h-[calc(100dvh-104px)] w-[220px] overflow-y-auto rounded-2xl border border-[#dfe6f4] bg-white p-1.5 text-xs text-[#374151] shadow-[0_12px_36px_-4px_rgba(0,0,0,0.12),0_4px_16px_-2px_rgba(0,0,0,0.06)] duration-100"
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
                className="flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left font-[family-name:var(--font-mono)] text-xs font-semibold text-[#374151] transition-all hover:bg-[#f3f4f6] active:bg-[#eef3ff]"
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
                <Clipboard size={13} className="shrink-0 text-[#6b7280]" />
                {clipboard ? (
                  <>
                    Paste{" "}
                    {clipboard.items.length === 1
                      ? `(${clipboard.items[0]?.name})`
                      : `(${clipboard.items.length} items)`}
                  </>
                ) : (
                  "Paste"
                )}
              </button>
              {clipboard ? (
                <button
                  type="button"
                  onClick={clearClipboard}
                  className="flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left text-xs font-semibold text-[#667085] transition-all hover:bg-[#f3f4f6] active:bg-[#eef3ff]"
                >
                  <X size={13} className="shrink-0 text-[#6b7280]" />
                  Clear clipboard
                </button>
              ) : null}
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
