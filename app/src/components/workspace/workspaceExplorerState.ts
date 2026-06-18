import type { WorkspaceListing } from "@/types";

export const WORKSPACE_DRAG_ENTRY_MIME = "application/x-ripple-workspace-entry";

interface WorkspaceDragPayload {
  paths: string[];
}

const workspaceListingCache = new Map<string, WorkspaceListing>();
const workspaceLastPathCache = new Map<string, string>();

function workspaceCacheKey(userId: string, path: string): string {
  return `${userId}\n${path}`;
}

export function getCachedWorkspaceListing(userId: string, path: string): WorkspaceListing | null {
  return workspaceListingCache.get(workspaceCacheKey(userId, path)) || null;
}

export function setCachedWorkspaceListing(userId: string, listing: WorkspaceListing): void {
  workspaceListingCache.set(workspaceCacheKey(userId, listing.path), listing);
}

export function getCachedWorkspaceLastPath(userId: string): string | null {
  return workspaceLastPathCache.get(userId) || null;
}

export function setCachedWorkspaceLastPath(userId: string, path: string): void {
  workspaceLastPathCache.set(userId, path);
}

export function hasDraggedWorkspaceEntries(event: {
  dataTransfer: Pick<DataTransfer, "types">;
}): boolean {
  return Array.from(event.dataTransfer.types).includes(WORKSPACE_DRAG_ENTRY_MIME);
}

export function getWorkspaceDragPaths(dataTransfer: Pick<DataTransfer, "getData">): string[] {
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

export function setWorkspaceDragPaths(
  dataTransfer: Pick<DataTransfer, "setData">,
  paths: string[]
): void {
  dataTransfer.setData(WORKSPACE_DRAG_ENTRY_MIME, JSON.stringify({ paths }));
  dataTransfer.setData("text/plain", paths.join("\n"));
}
