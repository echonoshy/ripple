import {
  TYPOGRAPHY_META_CLASS,
  TYPOGRAPHY_MICRO_MEDIUM_CLASS,
} from "@/components/workbench/stylePrimitives";
import { useI18n } from "@/i18n";
import { RIPPLE_API_CONNECTION_ERROR, readableApiErrorMessage } from "@/lib/apiErrors";
import type { WorkspaceEntry } from "@/types";
import type { WorkspaceSearchOptions } from "@/lib/api";

export const SPLIT_PERCENT_STORAGE_KEY = "ripple.workspaceExplorer.splitPercent";
export const DEFAULT_SPLIT_PERCENT = 48;
export const MIN_SPLIT_PERCENT = 0;
export const MAX_SPLIT_PERCENT = 100;
export const DEFAULT_WORKSPACE_PATH = "/workspace";

type Translator = ReturnType<typeof useI18n>["t"];

export type WorkspacePreviewKind = "image" | "pdf" | "document" | "text";

const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "gif", "svg", "webp", "bmp", "ico"];
const OFFICE_EXTENSIONS = ["doc", "docx", "xls", "xlsx", "ppt", "pptx", "odt", "ods", "odp"];

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

export function getSplitPercentFromHorizontalResize({
  containerLeft,
  containerWidth,
  leadingColumnWidth,
  pointerX,
}: {
  containerLeft: number;
  containerWidth: number;
  leadingColumnWidth: number;
  pointerX: number;
}): number {
  if (!Number.isFinite(containerWidth) || containerWidth <= 0) return DEFAULT_SPLIT_PERCENT;
  const splitWidth = pointerX - containerLeft - Math.max(0, leadingColumnWidth);
  return getBoundedSplitPercent((splitWidth / containerWidth) * 100);
}

export function getSplitPercentAfterFileDoubleClick(currentSplitPercent: number): number {
  return currentSplitPercent >= MAX_SPLIT_PERCENT ? DEFAULT_SPLIT_PERCENT : currentSplitPercent;
}

export function shouldDismissWorkspaceContextMenuOnEntryClick(
  contextMenuVisible: boolean
): boolean {
  return contextMenuVisible;
}

export function sortWorkspaceEntries(entries: WorkspaceEntry[]): WorkspaceEntry[] {
  return [...entries].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "directory" ? -1 : 1;
    return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
  });
}

export function normalizeWorkspacePath(path: string): string {
  const cleanPath = path.split(/[?#]/, 1)[0] || DEFAULT_WORKSPACE_PATH;
  const prefixed = cleanPath.startsWith(DEFAULT_WORKSPACE_PATH)
    ? cleanPath
    : `${DEFAULT_WORKSPACE_PATH}/${cleanPath.replace(/^\/+/, "")}`;
  return prefixed.replace(/\/+$/, "") || DEFAULT_WORKSPACE_PATH;
}

export function getWorkspaceParentPath(path: string): string {
  const normalizedPath = normalizeWorkspacePath(path);
  const slashIndex = normalizedPath.lastIndexOf("/");
  if (slashIndex <= DEFAULT_WORKSPACE_PATH.length - 1) return DEFAULT_WORKSPACE_PATH;
  return normalizedPath.slice(0, slashIndex) || DEFAULT_WORKSPACE_PATH;
}

export interface WorkspacePathBreadcrumb {
  label: string;
  path: string;
  isCurrent: boolean;
}

export function getWorkspacePathBreadcrumbs(path: string): WorkspacePathBreadcrumb[] {
  const normalizedPath = normalizeWorkspacePath(path);
  const relativePath =
    normalizedPath === DEFAULT_WORKSPACE_PATH
      ? ""
      : normalizedPath.slice(DEFAULT_WORKSPACE_PATH.length + 1);
  const parts = relativePath.split("/").filter(Boolean);
  const crumbs: WorkspacePathBreadcrumb[] = [
    {
      label: DEFAULT_WORKSPACE_PATH.replace(/^\//, ""),
      path: DEFAULT_WORKSPACE_PATH,
      isCurrent: parts.length === 0,
    },
  ];

  let nextPath = DEFAULT_WORKSPACE_PATH;
  parts.forEach((part, index) => {
    nextPath = `${nextPath}/${part}`;
    crumbs.push({
      label: part,
      path: nextPath,
      isCurrent: index === parts.length - 1,
    });
  });

  return crumbs;
}

export function getWorkspacePathAncestorPaths(path: string, includeSelf = false): string[] {
  const crumbs = getWorkspacePathBreadcrumbs(path);
  const selectedCrumbs = includeSelf ? crumbs : crumbs.slice(0, -1);
  return selectedCrumbs.map((crumb) => crumb.path);
}

export function canMoveEntriesToDirectory(
  entries: WorkspaceEntry[],
  target: WorkspaceEntry
): boolean {
  if (target.kind !== "directory" || entries.length === 0) return false;

  return entries.every((entry) => {
    if (entry.path === target.path) return false;
    if (target.path.startsWith(`${entry.path}/`)) return false;
    return getWorkspaceParentPath(entry.path) !== target.path;
  });
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function formatModified(value: string, locale: string): string {
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

export function SearchResultMeta({ entry }: { entry: WorkspaceEntry }) {
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

export function searchModeLabel(scope: WorkspaceSearchOptions["scope"], t: Translator): string {
  if (scope === "content") return t("files.searchModeContent");
  if (scope === "all") return t("files.searchModeAll");
  return t("files.searchModeName");
}

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

export function workspaceEntryNameFromPath(path: string): string {
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
