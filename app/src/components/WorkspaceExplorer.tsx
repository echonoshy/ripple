"use client";

import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  AlertTriangle,
  ArrowUp,
  ChevronDown,
  Download,
  Edit3,
  FileText,
  Folder,
  FolderRoot,
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
import MobileActionSheet from "@/components/workbench/MobileActionSheet";
import { PdfPreview } from "./PdfPreview";
import {
  LUCIDE_STANDARD_STROKE_WIDTH,
  MOBILE_GLASS_ICON_BUTTON_CLASS,
  TYPOGRAPHY_BODY_CLASS,
  TYPOGRAPHY_BODY_MEDIUM_CLASS,
  TYPOGRAPHY_META_CLASS,
  TYPOGRAPHY_META_MEDIUM_CLASS,
  TYPOGRAPHY_MICRO_MEDIUM_CLASS,
  TYPOGRAPHY_MOBILE_BODY_CLASS,
  TYPOGRAPHY_PAGE_TITLE_CLASS,
} from "@/components/workbench/stylePrimitives";
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
import { RIPPLE_API_CONNECTION_ERROR, readableApiErrorMessage } from "@/lib/apiErrors";
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

type Translator = ReturnType<typeof useI18n>["t"];

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

export function shouldDismissWorkspaceContextMenuOnEntryClick(
  contextMenuVisible: boolean
): boolean {
  return contextMenuVisible;
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

function formatModified(value: string, locale: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString(locale, {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function searchMatchLabel(match: WorkspaceEntry["match"], t: Translator): string | null {
  if (match === "name") return t("files.nameMatch");
  if (match === "path") return t("files.pathMatch");
  if (match === "content") return t("files.contentMatch");
  return null;
}

function SearchResultMeta({ entry }: { entry: WorkspaceEntry }) {
  const { t } = useI18n();
  const label = searchMatchLabel(entry.match, t);
  return (
    <span
      className={`mt-0.5 flex min-w-0 items-center gap-1 font-[family-name:var(--font-mono)] text-[#646A73] ${TYPOGRAPHY_META_CLASS}`}
    >
      <span className="truncate">{entry.path}</span>
      {label && (
        <span
          className={`shrink-0 rounded border border-[#d0d7de] bg-[#f6f8fa] px-1 py-0.5 text-[#646A73] uppercase ${TYPOGRAPHY_MICRO_MEDIUM_CLASS}`}
        >
          {label}
        </span>
      )}
    </span>
  );
}

function searchModeLabel(scope: WorkspaceSearchOptions["scope"], t: Translator): string {
  if (scope === "content") return t("files.searchModeContent");
  if (scope === "all") return t("files.searchModeAll");
  return t("files.searchModeName");
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

export function displayError(error: string, t?: Translator): string {
  if (
    error.includes("Failed to rename entry (404)") ||
    error.includes("File or folder no longer exists")
  ) {
    return t
      ? t("files.entryMissingRefresh")
      : "File or folder no longer exists. Refresh workspace.";
  }
  if (error.includes("(404)"))
    return t ? t("files.workspaceNotReady") : "Workspace is not ready for this user.";
  if (error.includes("(415)"))
    return t ? t("files.textPreviewUnsupported") : "This file cannot be previewed as text.";
  if (error.includes("(403)"))
    return t ? t("files.accessDeniedPath") : "Access denied for this path.";

  const readable = readableApiErrorMessage(error);
  if (t && readable === RIPPLE_API_CONNECTION_ERROR) return t("files.connectionError");
  return readable;
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
            t("files.overwriteFiles", {
              names: conflictNames,
              plural: err.conflicts.length === 1 ? "" : "s",
            })
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
    [currentPath, refreshAfterUpload, t, uploading]
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
    const confirmed = window.confirm(
      t("files.confirmBatchDelete", {
        count: selectedEntries.length,
        plural: selectedEntries.length === 1 ? "" : "s",
      })
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
    const confirmed = window.confirm(t("files.confirmDeleteEntry", { name: entry.name }));
    if (!confirmed) return;
    setError(null);
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
    openWorkspaceContextMenuForEntry(event.currentTarget.getBoundingClientRect(), entry);
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
  const filesToolbarIconButtonBaseClass =
    "inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full border transition-colors disabled:cursor-not-allowed disabled:opacity-50";
  const filesToolbarIconButtonClass = `${filesToolbarIconButtonBaseClass} border-[#EFF0F1] bg-white text-[#646A73] hover:bg-[#F8F9FA] hover:text-[#1F2329]`;
  const filesToolbarIconButtonActiveClass = `${filesToolbarIconButtonBaseClass} border-[#1456F0]/30 bg-[#F0F5FF] text-[#1456F0] hover:bg-[#F0F5FF]`;
  const filesMobileToolbarButtonClass = `${MOBILE_GLASS_ICON_BUTTON_CLASS} shrink-0`;
  const pageParentButtonClass =
    "inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-[#BACEFD] bg-[#F0F5FF] text-[#1456F0] shadow-[0_10px_24px_rgba(31,35,41,0.06)] transition-colors hover:bg-[#e5efff] lg:hidden";
  const directoryNavigationButtonClass = `group inline-flex h-8 shrink-0 whitespace-nowrap items-center gap-1.5 rounded-full border border-[#D0D3D6] bg-[linear-gradient(180deg,rgba(255,255,255,0.96),rgba(240,245,255,0.78))] px-2.5 text-[#46556f] shadow-[0_8px_20px_rgba(31,35,41,0.07),inset_0_1px_0_rgba(255,255,255,0.9)] backdrop-blur-xl transition-all hover:-translate-y-px hover:border-[#BACEFD] hover:bg-[#F0F5FF] hover:text-[#1456F0] hover:shadow-[0_12px_26px_rgba(31,35,41,0.1)] active:translate-y-0 ${TYPOGRAPHY_MICRO_MEDIUM_CLASS}`;
  const directoryNavigationIconClass =
    "flex h-5 w-5 items-center justify-center rounded-full bg-[#F0F5FF] text-[#1456F0] ring-1 ring-[#BACEFD] transition-colors group-hover:bg-[#E8F0FF] group-hover:text-[#1456F0]";
  const workspaceGridStyle:
    | (React.CSSProperties & { "--ripple-workspace-list-row"?: string })
    | undefined = !isPreviewPanelHidden
    ? {
        "--ripple-workspace-list-row": `minmax(96px, ${splitPercent}%) minmax(0, 1fr)`,
      }
    : undefined;
  const contextMenuPortal =
    contextMenu.visible && typeof document !== "undefined"
      ? createPortal(
          <div
            ref={contextMenuRef}
            style={{ top: contextMenu.y, left: contextMenu.x }}
            className={`animate-in fade-in-50 zoom-in-95 fixed z-50 max-h-[calc(100dvh-104px)] w-[220px] overflow-y-auto rounded-2xl border border-[#DEE0E3] bg-white p-1.5 text-[#2B2F36] shadow-[0_12px_36px_-4px_rgba(0,0,0,0.12),0_4px_16px_-2px_rgba(0,0,0,0.06)] duration-100 ${TYPOGRAPHY_META_CLASS}`}
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
                  className={`flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left text-[#2B2F36] transition-all hover:bg-[#F5F6F7] active:bg-[#F0F5FF] ${TYPOGRAPHY_META_MEDIUM_CLASS}`}
                >
                  <Edit3 size={13} className="shrink-0 text-[#646A73]" /> {t("files.rename")}
                </button>
                <button
                  type="button"
                  onClick={() => contextMenu.entry && handleCut(contextMenu.entry)}
                  className={`flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left text-[#2B2F36] transition-all hover:bg-[#F5F6F7] active:bg-[#F0F5FF] ${TYPOGRAPHY_META_MEDIUM_CLASS}`}
                >
                  <Scissors size={13} className="shrink-0 text-[#646A73]" /> {t("files.cutMove")}
                </button>
                <button
                  type="button"
                  onClick={() => contextMenu.entry && handleCopy(contextMenu.entry)}
                  className={`flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left text-[#2B2F36] transition-all hover:bg-[#F5F6F7] active:bg-[#F0F5FF] ${TYPOGRAPHY_META_MEDIUM_CLASS}`}
                >
                  <Copy size={13} className="shrink-0 text-[#646A73]" /> {t("files.copy")}
                </button>
                <button
                  type="button"
                  onClick={() =>
                    contextMenu.entry && handleCopyAbsoluteSandboxPath(contextMenu.entry)
                  }
                  className={`flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left font-[family-name:var(--font-mono)] text-[#2B2F36] transition-all hover:bg-[#F5F6F7] active:bg-[#F0F5FF] ${TYPOGRAPHY_META_MEDIUM_CLASS}`}
                >
                  <FileText size={13} className="shrink-0 text-[#646A73]" />{" "}
                  {t("files.copySandboxPath")}
                </button>
                {contextMenu.entry.kind === "file" && (
                  <button
                    type="button"
                    onClick={() => {
                      if (contextMenu.entry) void handleDownloadFile(contextMenu.entry.path);
                      setContextMenu((prev) => ({ ...prev, visible: false }));
                    }}
                    className={`flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left text-[#2B2F36] transition-all hover:bg-[#F5F6F7] active:bg-[#F0F5FF] ${TYPOGRAPHY_META_MEDIUM_CLASS}`}
                  >
                    <Download size={13} className="shrink-0 text-[#646A73]" /> {t("files.download")}
                  </button>
                )}
                <div className="my-1 border-t border-[#DEE0E3]" />
                <button
                  type="button"
                  onClick={() => contextMenu.entry && void handleDelete(contextMenu.entry)}
                  className={`flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left text-[#B42318] transition-colors hover:bg-[#FFF1F0] active:bg-[#FFE3E0] ${TYPOGRAPHY_META_MEDIUM_CLASS}`}
                >
                  <Trash2 size={13} className="shrink-0 text-[#B42318]" /> {t("files.delete")}
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  disabled={!clipboard}
                  onClick={handlePaste}
                  className={`flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left text-[#2B2F36] transition-all hover:bg-[#F5F6F7] active:bg-[#F0F5FF] disabled:cursor-not-allowed disabled:opacity-40 ${TYPOGRAPHY_META_MEDIUM_CLASS}`}
                >
                  <Clipboard size={13} className="shrink-0 text-[#646A73]" />
                  {clipboard ? (
                    <>
                      {clipboard.items.length === 1
                        ? t("files.pasteNamed", { name: clipboard.items[0]?.name || "" })
                        : t("files.pasteItems", { count: clipboard.items.length })}
                    </>
                  ) : (
                    t("files.paste")
                  )}
                </button>
                {clipboard ? (
                  <button
                    type="button"
                    onClick={clearClipboard}
                    className={`flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left text-[#646A73] transition-all hover:bg-[#F5F6F7] active:bg-[#F0F5FF] ${TYPOGRAPHY_META_MEDIUM_CLASS}`}
                  >
                    <X size={13} className="shrink-0 text-[#646A73]" />
                    {t("files.clearClipboard")}
                  </button>
                ) : null}
                <div className="my-1 border-t border-[#DEE0E3]" />
                <button
                  type="button"
                  onClick={() => {
                    setCreationModal({ visible: true, kind: "file" });
                    setContextMenu((prev) => ({ ...prev, visible: false }));
                  }}
                  className={`flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left text-[#2B2F36] transition-all hover:bg-[#F5F6F7] active:bg-[#F0F5FF] ${TYPOGRAPHY_META_MEDIUM_CLASS}`}
                >
                  <FilePlus size={13} className="shrink-0 text-[#646A73]" /> {t("files.newFile")}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setCreationModal({ visible: true, kind: "directory" });
                    setContextMenu((prev) => ({ ...prev, visible: false }));
                  }}
                  className={`flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left text-[#2B2F36] transition-all hover:bg-[#F5F6F7] active:bg-[#F0F5FF] ${TYPOGRAPHY_META_MEDIUM_CLASS}`}
                >
                  <FolderPlus size={13} className="shrink-0 text-[#646A73]" />{" "}
                  {t("files.newFolder")}
                </button>
              </>
            )}
          </div>,
          document.body
        )
      : null;

  return (
    <div
      data-ripple-workspace-explorer="finder-window"
      data-presentation={presentation}
      data-preview-state={previewState}
      className={
        isPagePresentation
          ? "relative flex h-full min-h-0 flex-col overflow-hidden rounded-2xl border border-[#DEE0E3] bg-white/86 text-[#1F2329] shadow-[0_12px_30px_rgba(31,35,41,0.06),inset_0_1px_0_rgba(255,255,255,0.92)] backdrop-blur-xl"
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
        <div className="pointer-events-none absolute inset-0 z-50 flex items-center justify-center bg-[#FFFFFF]/86 p-4 backdrop-blur-sm">
          <div
            className={`rounded-2xl border border-dashed border-[#1456F0] bg-[#F0F5FF] px-4 py-3 text-[#0F4BD8] shadow-[0_18px_42px_rgba(31,35,41,0.12)] ${TYPOGRAPHY_BODY_MEDIUM_CLASS}`}
          >
            {t("files.dropFiles")}
          </div>
        </div>
      )}
      <div
        className={
          isPagePresentation
            ? "shrink-0 border-b border-[#DEE0E3]/80 bg-[linear-gradient(180deg,rgba(255,255,255,0.78),rgba(255,255,255,0.62))] px-3 py-3 backdrop-blur-2xl sm:px-4"
            : "shrink-0 border-b border-[#EFF0F1] bg-white px-4 py-3"
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
                  aria-label={t("files.backToSession")}
                  title={t("files.backToSession")}
                  className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full border border-[#1456F0] bg-[#1456F0] text-white shadow-[0_12px_26px_rgba(20,86,240,0.26)] transition-colors hover:bg-[#0F4BD8] active:bg-[#0B3DB2] lg:hidden"
                >
                  <MessageCircleReply size={17} />
                </button>
              ) : null}
              <div className="min-w-0 flex-1">
                <h1 className={`text-[#1F2329] ${TYPOGRAPHY_PAGE_TITLE_CLASS}`}>
                  {t("files.title")}
                </h1>
              </div>
              <button
                type="button"
                data-ripple-files-mobile-search-trigger
                onClick={() => {
                  setIsActionsMenuOpen(false);
                  setIsMobileSearchOpen(true);
                }}
                className={`${filesMobileToolbarButtonClass} lg:hidden ${
                  isSearchMode ? "border-[#BACEFD] bg-[#F0F5FF] text-[#1456F0]" : ""
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
                className={`${filesMobileToolbarButtonClass} lg:hidden ${
                  isSelectionActive ? "border-[#BACEFD] bg-[#F0F5FF] text-[#1456F0]" : ""
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
                className={`${filesMobileToolbarButtonClass} lg:hidden`}
                title={t("files.uploadFiles")}
                aria-label={t("files.uploadFiles")}
                disabled={uploading}
                onClick={() => uploadInputRef.current?.click()}
              >
                {uploading ? (
                  <Loader2
                    size={18}
                    strokeWidth={LUCIDE_STANDARD_STROKE_WIDTH}
                    className="animate-spin"
                  />
                ) : (
                  <Upload size={18} strokeWidth={LUCIDE_STANDARD_STROKE_WIDTH} />
                )}
              </button>
              <button
                type="button"
                data-ripple-files-action="mobile-more"
                className={`${filesMobileToolbarButtonClass} lg:hidden`}
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
                className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-[#8F959E]"
              />
              <input
                value={query}
                onChange={(event) => handleQueryChange(event.target.value)}
                placeholder={t("files.findFilesByName")}
                aria-label={t("files.searchWorkspaceFiles")}
                className={
                  isPagePresentation
                    ? `h-9 w-full rounded-lg border border-[#DEE0E3] bg-white/84 pr-3 pl-9 text-[#1F2329] shadow-[inset_0_1px_0_rgba(255,255,255,0.8)] outline-none placeholder:text-[12px] placeholder:text-[#8F959E] focus:border-[#1456F0] ${TYPOGRAPHY_BODY_CLASS}`
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
                onClick={() => void loadDirectory(currentPath)}
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
            className="mt-3 flex min-w-0 items-center gap-2 rounded-xl border border-[#DEE0E3]/80 bg-white/62 px-2.5 py-2 text-[#646A73] lg:hidden"
          >
            {listing?.parent_path ? (
              <button
                type="button"
                data-ripple-files-action="parent-folder"
                className={pageParentButtonClass}
                title={t("files.goToParentFolder")}
                aria-label={t("files.goToParentFolder")}
                onClick={() => void loadDirectory(listing.parent_path || DEFAULT_WORKSPACE_PATH)}
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
            className="mt-3 hidden min-w-0 items-center gap-2 rounded-xl border border-[#DEE0E3]/80 bg-white/62 px-2.5 py-2 text-[#646A73] lg:flex"
          >
            <div className="flex shrink-0 items-center gap-1">
              {listing?.parent_path ? (
                <button
                  type="button"
                  data-ripple-files-action="parent-folder"
                  className={directoryNavigationButtonClass}
                  title={t("files.goToParentFolder")}
                  aria-label={t("files.goToParentFolder")}
                  onClick={() => void loadDirectory(listing.parent_path || DEFAULT_WORKSPACE_PATH)}
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
                  onClick={() => void loadDirectory(DEFAULT_WORKSPACE_PATH)}
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
              <div
                className={`max-w-full overflow-x-auto overscroll-x-contain font-[family-name:var(--font-mono)] text-[#2B2F36] [scrollbar-width:thin] ${TYPOGRAPHY_META_MEDIUM_CLASS}`}
              >
                <span className="whitespace-nowrap">{desktopPathLabel}</span>
              </div>
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
        <MobileActionSheet
          open={isPagePresentation && isActionsMenuOpen}
          data-ripple-files-mobile-actions-sheet
          title={t("files.moreFileActions")}
          subtitle={mobilePathLabel}
          closeLabel={t("files.cancel")}
          onClose={() => setIsActionsMenuOpen(false)}
          actions={[
            {
              key: "refresh",
              label: t("files.refreshWorkspace"),
              icon: <RefreshCw size={16} />,
              loading,
              disabled: loading,
              onClick: () => {
                setIsActionsMenuOpen(false);
                void loadDirectory(currentPath);
              },
            },
            {
              key: "paste",
              label: clipboard
                ? clipboard.items.length === 1
                  ? t("files.pasteNamed", { name: clipboard.items[0]?.name || "" })
                  : t("files.pasteItems", { count: clipboard.items.length })
                : t("files.paste"),
              icon: <Clipboard size={16} />,
              disabled: !clipboard,
              onClick: () => {
                setIsActionsMenuOpen(false);
                void handlePaste();
              },
            },
            ...(clipboard
              ? [
                  {
                    key: "clear-clipboard",
                    label: t("files.clearClipboard"),
                    icon: <X size={16} />,
                    onClick: () => {
                      clearClipboard();
                      setIsActionsMenuOpen(false);
                    },
                  },
                ]
              : []),
            {
              key: "new-file",
              label: t("files.newFile"),
              icon: <FilePlus size={16} />,
              onClick: () => {
                setCreationModal({ visible: true, kind: "file" });
                setIsActionsMenuOpen(false);
              },
            },
            {
              key: "new-folder",
              label: t("files.newFolder"),
              icon: <FolderPlus size={16} />,
              onClick: () => {
                setCreationModal({ visible: true, kind: "directory" });
                setIsActionsMenuOpen(false);
              },
            },
          ]}
        />
        {!isPagePresentation && isActionsMenuOpen && (
          <div
            data-ripple-files-compact-actions-menu
            className={`absolute top-[54px] right-3 z-40 w-[220px] rounded-2xl border border-[#DEE0E3] bg-white p-1.5 text-[#2B2F36] shadow-[0_18px_44px_rgba(31,35,41,0.16)] ${TYPOGRAPHY_META_CLASS}`}
            onClick={(event) => event.stopPropagation()}
          >
            <button
              type="button"
              onClick={() => {
                setIsActionsMenuOpen(false);
                void loadDirectory(currentPath);
              }}
              disabled={loading}
              className={`flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left transition-colors hover:bg-[#F5F6F7] disabled:cursor-not-allowed disabled:opacity-50 ${TYPOGRAPHY_META_MEDIUM_CLASS}`}
            >
              {loading ? (
                <Loader2 size={13} className="shrink-0 animate-spin text-[#646A73]" />
              ) : (
                <RefreshCw size={13} className="shrink-0 text-[#646A73]" />
              )}
              {t("files.refreshWorkspace")}
            </button>
            <button
              type="button"
              disabled={!clipboard}
              onClick={() => {
                setIsActionsMenuOpen(false);
                void handlePaste();
              }}
              className={`flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left transition-colors hover:bg-[#F5F6F7] disabled:cursor-not-allowed disabled:opacity-40 ${TYPOGRAPHY_META_MEDIUM_CLASS}`}
            >
              <Clipboard size={13} className="shrink-0 text-[#646A73]" />
              {clipboard ? (
                <>
                  {clipboard.items.length === 1
                    ? t("files.pasteNamed", { name: clipboard.items[0]?.name || "" })
                    : t("files.pasteItems", { count: clipboard.items.length })}
                </>
              ) : (
                t("files.paste")
              )}
            </button>
            {clipboard ? (
              <button
                type="button"
                onClick={clearClipboard}
                className={`flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left text-[#646A73] transition-colors hover:bg-[#F5F6F7] ${TYPOGRAPHY_META_MEDIUM_CLASS}`}
              >
                <X size={13} className="shrink-0 text-[#646A73]" />
                {t("files.clearClipboard")}
              </button>
            ) : null}
            <div className="my-1 border-t border-[#DEE0E3]" />
            <button
              type="button"
              onClick={() => {
                setCreationModal({ visible: true, kind: "file" });
                setIsActionsMenuOpen(false);
              }}
              className={`flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left transition-colors hover:bg-[#F5F6F7] ${TYPOGRAPHY_META_MEDIUM_CLASS}`}
            >
              <FilePlus size={13} className="shrink-0 text-[#646A73]" />
              {t("files.newFile")}
            </button>
            <button
              type="button"
              onClick={() => {
                setCreationModal({ visible: true, kind: "directory" });
                setIsActionsMenuOpen(false);
              }}
              className={`flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left transition-colors hover:bg-[#F5F6F7] ${TYPOGRAPHY_META_MEDIUM_CLASS}`}
            >
              <FolderPlus size={13} className="shrink-0 text-[#646A73]" />
              {t("files.newFolder")}
            </button>
          </div>
        )}
        {isFilterOpen && (
          <div
            className={
              isPagePresentation
                ? `mt-3 hidden gap-2 rounded-2xl border border-[#DEE0E3] bg-[#FFFFFF]/76 p-3 text-[#2B2F36] shadow-[0_14px_36px_rgba(31,35,41,0.06)] lg:grid lg:grid-cols-2 ${TYPOGRAPHY_META_CLASS}`
                : `mb-2 grid gap-2 rounded-2xl border border-[#EFF0F1] bg-[#fbfbfc] p-3 text-[#2B2F36] shadow-sm sm:grid-cols-2 ${TYPOGRAPHY_META_CLASS}`
            }
          >
            <label className="flex items-center gap-2">
              <span className="w-16 text-[#646A73]">{t("files.scope")}</span>
              <select
                value={searchScope}
                onChange={(event) =>
                  setSearchScope(event.target.value as NonNullable<WorkspaceSearchOptions["scope"]>)
                }
                className={`h-8 min-w-0 flex-1 rounded-lg border border-[#DEE0E3] bg-white/84 px-2 ${TYPOGRAPHY_META_CLASS}`}
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
                className={`h-8 min-w-0 flex-1 rounded-lg border border-[#DEE0E3] bg-white/84 px-2 ${TYPOGRAPHY_META_CLASS}`}
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
                className={`h-8 min-w-0 flex-1 rounded-lg border border-[#DEE0E3] bg-white/84 px-2 ${TYPOGRAPHY_META_CLASS}`}
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
                className={`h-8 min-w-0 flex-1 rounded-lg border border-[#DEE0E3] bg-white/84 px-2 ${TYPOGRAPHY_META_CLASS}`}
              >
                <option value={20}>20</option>
                <option value={50}>50</option>
              </select>
            </label>
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
              onClick={() => void loadDirectory(currentPath)}
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
            className="w-full rounded-2xl border border-[#DEE0E3] bg-white/92 text-[#1F2329] shadow-[0_-14px_34px_rgba(31,35,41,0.14)] backdrop-blur-xl"
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
                onClick={() => handleQueryChange("")}
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
                  onChange={(event) => handleQueryChange(event.target.value)}
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
                <label className="flex items-center gap-2">
                  <span className="w-16 text-[#646A73]">{t("files.scope")}</span>
                  <select
                    value={searchScope}
                    onChange={(event) =>
                      setSearchScope(
                        event.target.value as NonNullable<WorkspaceSearchOptions["scope"]>
                      )
                    }
                    className={`h-10 min-w-0 flex-1 rounded-xl border border-[#DEE0E3] bg-white px-2 ${TYPOGRAPHY_MOBILE_BODY_CLASS}`}
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
                      setSearchKind(
                        event.target.value as NonNullable<WorkspaceSearchOptions["kind"]>
                      )
                    }
                    className={`h-10 min-w-0 flex-1 rounded-xl border border-[#DEE0E3] bg-white px-2 ${TYPOGRAPHY_MOBILE_BODY_CLASS}`}
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
                      setFileType(
                        event.target.value as NonNullable<WorkspaceSearchOptions["fileType"]>
                      )
                    }
                    className={`h-10 min-w-0 flex-1 rounded-xl border border-[#DEE0E3] bg-white px-2 ${TYPOGRAPHY_MOBILE_BODY_CLASS}`}
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
                    className={`h-10 min-w-0 flex-1 rounded-xl border border-[#DEE0E3] bg-white px-2 ${TYPOGRAPHY_MOBILE_BODY_CLASS}`}
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
              <span
                className={`tracking-wider text-[#646A73] uppercase ${TYPOGRAPHY_META_MEDIUM_CLASS}`}
              >
                {isSearchMode ? t("files.searchResults") : t("files.workspace")}
              </span>
              <div className="flex items-center gap-1">
                {searchLoading && (
                  <Loader2 size={13} className="shrink-0 animate-spin text-[#646A73]" />
                )}
                {!isSearchMode &&
                  (listing?.parent_path || currentPath !== DEFAULT_WORKSPACE_PATH) && (
                    <>
                      {listing?.parent_path && (
                        <button
                          type="button"
                          data-ripple-files-action="parent-folder"
                          title={t("files.goToParentFolder")}
                          aria-label={t("files.goToParentFolder")}
                          onClick={() =>
                            void loadDirectory(listing.parent_path || DEFAULT_WORKSPACE_PATH)
                          }
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
                          onClick={() => void loadDirectory(DEFAULT_WORKSPACE_PATH)}
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
                  onClick={() => void handleBatchDelete()}
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
              <div
                className={`flex h-40 items-center justify-center gap-2 text-[#646A73] ${TYPOGRAPHY_BODY_MEDIUM_CLASS}`}
              >
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
                        void commitRename(entry);
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
                        {isSearchMode ? (
                          <SearchResultMeta entry={entry} />
                        ) : (
                          <span
                            className={`mt-0.5 block truncate font-[family-name:var(--font-mono)] text-[#646A73] ${TYPOGRAPHY_META_CLASS}`}
                          >
                            {`${entry.kind === "directory" ? t("files.folder") : formatBytes(entry.size_bytes)}${
                              formatModified(entry.modified_at, locale)
                                ? ` · ${formatModified(entry.modified_at, locale)}`
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
                            className={`block truncate font-[family-name:var(--font-mono)] text-[#1F2329] ${TYPOGRAPHY_BODY_MEDIUM_CLASS} ${
                              entry.is_hidden ? "opacity-55" : ""
                            }`}
                          >
                            {entry.name}
                          </span>
                          {isSearchMode ? (
                            <SearchResultMeta entry={entry} />
                          ) : (
                            <span
                              className={`mt-0.5 block truncate font-[family-name:var(--font-mono)] text-[#646A73] ${TYPOGRAPHY_META_CLASS}`}
                            >
                              {`${entry.kind === "directory" ? t("files.folder") : formatBytes(entry.size_bytes)}${
                                formatModified(entry.modified_at, locale)
                                  ? ` · ${formatModified(entry.modified_at, locale)}`
                                  : ""
                              }`}
                            </span>
                          )}
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

        {!isPreviewPanelHidden && (
          <section
            data-ripple-workspace-preview="preview"
            className={
              isPagePresentation
                ? "flex min-h-0 flex-col overflow-hidden bg-[linear-gradient(180deg,#FFFFFF,#F8F9FA)]"
                : "relative flex min-h-0 flex-col overflow-hidden bg-white"
            }
          >
            <div
              role="separator"
              aria-label={t("files.resizePreviewPanel")}
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
                  ? "group absolute top-0 right-0 left-0 z-20 flex h-3 -translate-y-1/2 cursor-row-resize items-center justify-center bg-transparent transition-colors outline-none hover:bg-[#E8F0FF]/70 focus:bg-[#E8F0FF]/70 lg:hidden"
                  : "group absolute top-0 right-0 left-0 z-20 flex h-3 -translate-y-1/2 cursor-row-resize items-center justify-center bg-transparent transition-colors outline-none hover:bg-[#E8F0FF]/70 focus:bg-[#E8F0FF]/70"
              }
            >
              <span className="h-0.5 w-12 rounded-full bg-[#1456F0] opacity-0 transition-opacity group-hover:opacity-100 group-focus:opacity-100" />
            </div>
            <div
              className={
                isPagePresentation
                  ? "flex min-h-[40px] shrink-0 items-center gap-2 border-b border-[#DEE0E3]/60 px-2 py-1 text-[#646A73] sm:min-h-[68px] sm:gap-3 sm:px-4 sm:py-3"
                  : "flex shrink-0 items-center gap-2 border-b border-[#EFF0F1] bg-white px-3 py-2 text-[#646A73]"
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
                      ? `block truncate text-[#1F2329] ${TYPOGRAPHY_BODY_MEDIUM_CLASS}`
                      : `block truncate text-[#1F2329] ${TYPOGRAPHY_BODY_MEDIUM_CLASS}`
                  }
                >
                  {isPagePresentation
                    ? preview?.name || t("files.selectFile")
                    : preview?.path || t("files.selectFile")}
                </span>
                {isPagePresentation && (
                  <span
                    data-ripple-workspace-preview-title-path
                    className={`hidden truncate font-[family-name:var(--font-mono)] text-[#646A73] sm:mt-1 sm:block ${TYPOGRAPHY_META_CLASS}`}
                  >
                    {preview?.path || t("files.selectFile")}
                  </span>
                )}
              </span>
              {previewLoading && <Loader2 size={12} className="animate-spin" />}
              {preview && (
                <div className="flex shrink-0 items-center gap-1">
                  {!imagePreviewUrl && !documentPreview && (
                    <button
                      type="button"
                      disabled={preview.truncated}
                      onClick={() => setIsEditing((current) => !current)}
                      className={`inline-flex h-8 items-center gap-1 rounded-full border px-2 ${TYPOGRAPHY_META_MEDIUM_CLASS} ${
                        isEditing
                          ? "border-[#1456F0] bg-[#F0F5FF] text-[#2B2F36]"
                          : isPagePresentation
                            ? "border-[#DEE0E3] bg-white/76 text-[#646A73] hover:bg-[#F8F9FA] disabled:cursor-not-allowed disabled:text-[#8F959E]"
                            : "border-[#DEE0E3] bg-white text-[#646A73] hover:bg-[#F8F9FA] disabled:cursor-not-allowed disabled:text-[#8F959E]"
                      }`}
                      title={preview.truncated ? t("files.truncatedCannotEdit") : t("files.edit")}
                    >
                      <Edit3 size={12} />
                      {t("files.edit")}
                    </button>
                  )}
                  <button
                    type="button"
                    aria-label={t("files.openFullscreenPreview")}
                    title={t("files.fullscreenPreview")}
                    onClick={() => setIsPreviewFullscreenOpen(true)}
                    className={
                      isPagePresentation
                        ? "inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-[#DEE0E3] bg-white/76 text-[#646A73] hover:bg-[#F8F9FA] hover:text-[#1F2329] sm:h-7 sm:w-7"
                        : "inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-[#DEE0E3] bg-white text-[#646A73] hover:bg-[#F8F9FA] hover:text-[#1F2329]"
                    }
                  >
                    <Maximize2 size={isPagePresentation ? 12 : 13} />
                  </button>
                </div>
              )}
              <button
                type="button"
                aria-label={t("files.collapsePreviewPanel")}
                title={t("files.collapsePanel")}
                onClick={() => updateSplitPercent(MAX_SPLIT_PERCENT)}
                className={
                  isPagePresentation
                    ? "inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-[#DEE0E3] bg-white/76 text-[#646A73] hover:bg-[#F8F9FA] hover:text-[#1F2329] sm:h-7 sm:w-7"
                    : "inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-[#DEE0E3] bg-white text-[#646A73] hover:bg-[#F8F9FA] hover:text-[#1F2329]"
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
                        ? `hidden flex-wrap items-center gap-2 border-b border-[#DEE0E3]/60 px-4 py-2 font-[family-name:var(--font-mono)] text-[#646A73] sm:flex ${TYPOGRAPHY_META_MEDIUM_CLASS}`
                        : `flex flex-wrap items-center gap-2 border-b border-[#DEE0E3] px-3 py-2 font-[family-name:var(--font-mono)] text-[#646A73] ${TYPOGRAPHY_MICRO_MEDIUM_CLASS}`
                    }
                  >
                    <span>{formatBytes(preview.size_bytes)}</span>
                    <span>{preview.mime_type}</span>
                    <span>{formatModified(preview.modified_at, locale)}</span>
                    {isDirty && (
                      <span
                        className={`rounded-full border border-[#1456F0]/25 bg-[#F0F5FF] px-1.5 py-0.5 text-[#0F4BD8] uppercase ${TYPOGRAPHY_MICRO_MEDIUM_CLASS}`}
                      >
                        {t("files.unsaved")}
                      </span>
                    )}
                    {preview.truncated && (
                      <span
                        className={`rounded-full border border-[#1456F0]/35 bg-[#F0F5FF] px-1.5 py-0.5 text-[#0F4BD8] uppercase ${TYPOGRAPHY_MICRO_MEDIUM_CLASS}`}
                      >
                        {t("files.truncated")}
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
                              ? `inline-flex h-8 items-center gap-1 rounded-full border border-[#DEE0E3] bg-white/76 px-2 text-[#646A73] hover:bg-[#F8F9FA] disabled:cursor-not-allowed disabled:text-[#8F959E] ${TYPOGRAPHY_META_MEDIUM_CLASS}`
                              : `inline-flex h-7 items-center gap-1 rounded-md border border-[#DEE0E3] bg-white px-2 text-[#646A73] hover:bg-[#F8F9FA] disabled:cursor-not-allowed disabled:text-[#8F959E] ${TYPOGRAPHY_META_MEDIUM_CLASS}`
                          }
                        >
                          <Undo2 size={12} />
                          {t("files.revert")}
                        </button>
                        <button
                          type="button"
                          onClick={() => void handleSave()}
                          disabled={!isDirty || saving || preview.truncated}
                          className={
                            isPagePresentation
                              ? `inline-flex h-8 items-center gap-1 rounded-full border border-[#2B2F36] bg-[#2B2F36] px-2 text-white hover:bg-[#1F2329] disabled:cursor-not-allowed disabled:border-[#DEE0E3] disabled:bg-[#F8F9FA] disabled:text-[#8F959E] ${TYPOGRAPHY_META_MEDIUM_CLASS}`
                              : `inline-flex h-7 items-center gap-1 rounded-md border border-[#1F2329] bg-[#1F2329] px-2 text-white hover:bg-[#2a2f37] disabled:cursor-not-allowed disabled:border-[#DEE0E3] disabled:bg-[#F8F9FA] disabled:text-[#8F959E] ${TYPOGRAPHY_META_MEDIUM_CLASS}`
                          }
                        >
                          {saving ? (
                            <Loader2 size={12} className="animate-spin" />
                          ) : (
                            <Save size={12} />
                          )}
                          {t("files.save")}
                        </button>
                      </div>
                    )}
                  </div>
                  {saveError && (
                    <div
                      className={`m-3 mb-0 flex items-start gap-2 rounded-xl border border-[#B42318]/25 bg-[#FFF1F0] p-3 text-[#B42318] ${TYPOGRAPHY_META_MEDIUM_CLASS}`}
                    >
                      <AlertTriangle size={14} className="mt-0.5 shrink-0" />
                      <span>{saveError}</span>
                    </div>
                  )}
                  {documentPreview ? (
                    <div
                      data-ripple-workspace-document-preview
                      className={
                        isPagePresentation
                          ? "min-h-0 flex-1 overflow-hidden bg-[#f4f7fb]"
                          : "min-h-0 flex-1 overflow-hidden bg-[#F8F9FA]"
                      }
                    >
                      <PdfPreview
                        blob={documentPreview.blob}
                        filename={documentPreview.filename}
                        className="h-full min-h-0"
                      />
                    </div>
                  ) : imagePreviewUrl ? (
                    <div
                      className={
                        isPagePresentation
                          ? "flex min-h-[300px] flex-1 items-center justify-center overflow-auto bg-[#F8F9FA] p-6"
                          : "flex min-h-[300px] flex-1 items-center justify-center overflow-auto bg-[#F8F9FA] p-6"
                      }
                    >
                      <img
                        src={imagePreviewUrl}
                        alt={preview.name}
                        className={
                          isPagePresentation
                            ? "max-h-[480px] max-w-full rounded-2xl border border-[#DEE0E3] bg-white object-contain p-1.5 shadow-[0_14px_34px_rgba(31,35,41,0.06)] transition-all hover:shadow-[0_18px_42px_rgba(31,35,41,0.10)]"
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
                          ? "min-h-0 flex-1 resize-none overflow-auto border-0 bg-[#FFFFFF] p-4 font-[family-name:var(--font-mono)] text-[13px] leading-relaxed text-[#1F2329] outline-none"
                          : "min-h-0 flex-1 resize-none overflow-auto border-0 bg-white p-3 font-[family-name:var(--font-mono)] text-[12px] leading-relaxed text-[#1F2329] outline-none"
                      }
                    />
                  ) : (
                    <div
                      ref={preContainerRef}
                      className={
                        isPagePresentation
                          ? "min-h-0 flex-1 overflow-auto bg-[#FFFFFF] p-4"
                          : "min-h-0 flex-1 overflow-auto bg-white"
                      }
                    >
                      {(() => {
                        const lines = preview.content.split("\n");
                        return (
                          <div
                            className={
                              isPagePresentation
                                ? "rounded-2xl border border-[#DEE0E3]/80 bg-white/70 py-3 shadow-[0_14px_34px_rgba(31,35,41,0.06),inset_0_1px_0_rgba(255,255,255,0.72)]"
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
                                  className={`flex min-w-0 items-start font-[family-name:var(--font-mono)] text-[13px] leading-relaxed transition-colors ${
                                    isLineHighlighted
                                      ? isPagePresentation
                                        ? "border-l-4 border-[#1456F0] bg-[#F0F5FF] pl-2"
                                        : "border-l-2 border-[#1456F0] bg-[#F0F5FF] pl-[10px]"
                                      : isPagePresentation
                                        ? "pl-3 hover:bg-[#F8F9FA]"
                                        : "pl-3 hover:bg-[#F8F9FA]"
                                  }`}
                                >
                                  <span className="w-9 shrink-0 pr-3 text-right text-[#8F959E] select-none">
                                    {lineNum}
                                  </span>
                                  <span className="flex-1 break-all whitespace-pre-wrap text-[#1F2329]">
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
                <div
                  className={`flex h-full items-center justify-center px-4 text-center text-[#646A73] ${TYPOGRAPHY_BODY_MEDIUM_CLASS}`}
                >
                  {t("files.selectFile")}
                </div>
              )}
            </div>
          </section>
        )}
      </div>

      {isPreviewFullscreenOpen && preview && (
        <div
          data-ripple-workspace-preview-fullscreen
          className="fixed inset-0 z-[70] flex min-h-0 flex-col bg-white text-[#1F2329]"
        >
          <div className="flex min-h-[48px] shrink-0 items-center gap-2 border-b border-[#DEE0E3] bg-white px-3 py-2 sm:min-h-[60px] sm:gap-3 sm:px-4">
            <IconTile tone="accent" size="sm">
              <FileText size={13} />
            </IconTile>
            <span className="min-w-0 flex-1">
              <span className={`block truncate text-[#1F2329] ${TYPOGRAPHY_BODY_MEDIUM_CLASS}`}>
                {preview.name}
              </span>
              <span
                className={`mt-0.5 hidden truncate font-[family-name:var(--font-mono)] text-[#646A73] sm:block ${TYPOGRAPHY_META_CLASS}`}
              >
                {preview.path}
              </span>
            </span>
            <div
              className={`hidden shrink-0 items-center gap-2 font-[family-name:var(--font-mono)] text-[#646A73] md:flex ${TYPOGRAPHY_META_MEDIUM_CLASS}`}
            >
              <span>{formatBytes(preview.size_bytes)}</span>
              <span>{preview.mime_type}</span>
              <span>{formatModified(preview.modified_at, locale)}</span>
            </div>
            <button
              type="button"
              aria-label={t("files.closeFullscreenPreview")}
              title={t("files.closeFullscreenPreview")}
              onClick={() => setIsPreviewFullscreenOpen(false)}
              className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-[#DEE0E3] bg-white text-[#646A73] hover:bg-[#F8F9FA] hover:text-[#1F2329]"
            >
              <X size={15} />
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-hidden bg-[#f4f7fb]">
            {documentPreview ? (
              <PdfPreview
                blob={documentPreview.blob}
                filename={documentPreview.filename}
                fullscreen
                className="h-full min-h-0"
              />
            ) : imagePreviewUrl ? (
              <div className="flex h-full min-h-0 items-center justify-center overflow-auto bg-[#F8F9FA] p-4 sm:p-8">
                <img
                  src={imagePreviewUrl}
                  alt={preview.name}
                  className="max-h-full max-w-full rounded-lg border border-[#DEE0E3] bg-white object-contain p-1.5 shadow-[0_18px_42px_rgba(31,35,41,0.10)]"
                />
              </div>
            ) : (
              <div className="h-full min-h-0 overflow-auto bg-white p-4 sm:p-6">
                <div className="mx-auto max-w-6xl rounded-lg border border-[#DEE0E3] bg-white py-3 shadow-[0_14px_34px_rgba(31,35,41,0.06)]">
                  {(isEditing ? draft : preview.content).split("\n").map((line, idx) => {
                    const lineNum = idx + 1;
                    return (
                      <div
                        key={lineNum}
                        className="flex min-w-0 items-start font-[family-name:var(--font-mono)] text-[13px] leading-relaxed hover:bg-[#F8F9FA]"
                      >
                        <span className="w-11 shrink-0 pr-3 text-right text-[#8F959E] select-none">
                          {lineNum}
                        </span>
                        <span className="flex-1 break-all whitespace-pre-wrap text-[#1F2329]">
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

      {contextMenuPortal}

      {/* 新建模态对话框 */}
      {creationModal?.visible && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-[1px]">
          <form
            onSubmit={handleCreate}
            className="w-80 rounded-2xl border border-[#DEE0E3] bg-white p-5 shadow-2xl"
          >
            <h3 className={`mb-3 text-[#1F2329] ${TYPOGRAPHY_BODY_MEDIUM_CLASS}`}>
              {creationModal.kind === "file"
                ? t("files.createNewFile")
                : t("files.createNewFolder")}
            </h3>
            <input
              autoFocus
              value={creationDraft}
              onChange={(e) => setCreationDraft(e.target.value)}
              placeholder={
                creationModal.kind === "file"
                  ? t("files.filePlaceholder")
                  : t("files.folderPlaceholder")
              }
              className={`mb-4 h-10 w-full rounded-full border border-[#DEE0E3] bg-white px-4 outline-none focus:border-[#8FB1FF] ${TYPOGRAPHY_MOBILE_BODY_CLASS}`}
              disabled={creationSaving}
            />
            <div className={`flex justify-end gap-2 ${TYPOGRAPHY_META_MEDIUM_CLASS}`}>
              <button
                type="button"
                onClick={() => {
                  setCreationModal(null);
                  setCreationDraft("");
                }}
                className="rounded-full border border-[#DEE0E3] bg-white px-4 py-1.5 text-[#2B2F36] transition-all duration-200 hover:bg-[#f9fafb]"
                disabled={creationSaving}
              >
                {t("files.cancel")}
              </button>
              <button
                type="submit"
                className="rounded-full bg-[#1456F0] px-4 py-1.5 text-white shadow-[0_8px_18px_rgba(20,86,240,0.20)] transition-all duration-200 hover:bg-[#0F4BD8] active:scale-[0.98]"
                disabled={creationSaving}
              >
                {creationSaving ? t("files.creating") : t("files.create")}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
