import type { WorkspaceEntry } from "@/types";

export type WorkspacePlace = "skills" | "uploads" | "outputs" | "workspace";

export interface WorkspaceOperationTarget {
  path: string;
  place: WorkspacePlace;
  writable: boolean;
}

export const WORKSPACE_ROOT_PATH = "/workspace";

export const WORKSPACE_FIXED_PLACES = [
  { id: "skills" as const, label: "Skills", path: "/workspace/skills" },
  { id: "uploads" as const, label: "Uploads", path: "/workspace/uploads" },
  { id: "outputs" as const, label: "Outputs", path: "/workspace/outputs" },
];

export function normalizeWorkspacePath(path: string): string {
  const cleanPath = path.split(/[?#]/, 1)[0] || WORKSPACE_ROOT_PATH;
  const prefixed = cleanPath.startsWith(WORKSPACE_ROOT_PATH)
    ? cleanPath
    : `${WORKSPACE_ROOT_PATH}/${cleanPath.replace(/^\/+/, "")}`;
  return prefixed.replace(/\/+$/, "") || WORKSPACE_ROOT_PATH;
}

export function getWorkspaceParentPath(path: string): string {
  const normalizedPath = normalizeWorkspacePath(path);
  const slashIndex = normalizedPath.lastIndexOf("/");
  if (slashIndex <= WORKSPACE_ROOT_PATH.length - 1) return WORKSPACE_ROOT_PATH;
  return normalizedPath.slice(0, slashIndex) || WORKSPACE_ROOT_PATH;
}

export function pathIsInsideWorkspaceRoot(path: string, root: string): boolean {
  const normalizedPath = normalizeWorkspacePath(path);
  const normalizedRoot = normalizeWorkspacePath(root);
  return normalizedPath === normalizedRoot || normalizedPath.startsWith(`${normalizedRoot}/`);
}

export function workspacePlaceForPath(path: string): WorkspacePlace {
  const place = WORKSPACE_FIXED_PLACES.find((candidate) =>
    pathIsInsideWorkspaceRoot(path, candidate.path)
  );
  return place?.id || "workspace";
}

export function isWritableWorkspacePath(path: string): boolean {
  return workspacePlaceForPath(path) !== "workspace";
}

export function workspaceOperationTarget(path: string): WorkspaceOperationTarget {
  const normalizedPath = normalizeWorkspacePath(path);
  const place = workspacePlaceForPath(normalizedPath);
  return {
    path: normalizedPath,
    place,
    writable: place !== "workspace",
  };
}

export function workspacePlacePath(place: WorkspacePlace): string {
  return (
    WORKSPACE_FIXED_PLACES.find((candidate) => candidate.id === place)?.path || WORKSPACE_ROOT_PATH
  );
}

export function getWorkspaceUploadTargetPath(date: Date = new Date()): string {
  const year = String(date.getFullYear()).padStart(4, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  return `${workspacePlacePath("uploads")}/${year}/${month}`;
}

export function canMoveEntriesToDirectory(entries: WorkspaceEntry[], target: WorkspaceEntry): boolean {
  if (target.kind !== "directory" || entries.length === 0 || !isWritableWorkspacePath(target.path)) {
    return false;
  }

  return entries.every((entry) => {
    if (entry.path === target.path) return false;
    if (target.path.startsWith(`${entry.path}/`)) return false;
    return getWorkspaceParentPath(entry.path) !== target.path;
  });
}
