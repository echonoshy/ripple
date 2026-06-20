import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Folder,
  FolderOpen,
  Loader2,
} from "lucide-react";
import {
  TYPOGRAPHY_BODY_MEDIUM_CLASS,
  TYPOGRAPHY_META_CLASS,
  TYPOGRAPHY_META_MEDIUM_CLASS,
} from "@/components/workbench/stylePrimitives";
import { useI18n } from "@/i18n";
import { fetchWorkspaceListing } from "@/lib/api";
import type { WorkspaceEntry, WorkspaceListing } from "@/types";
import { DEFAULT_WORKSPACE_PATH } from "./workspaceExplorerUtils";

interface WorkspaceTreePanelProps {
  userId: string;
  currentPath: string;
  seedListings: Map<string, WorkspaceListing>;
  expandedPaths: Set<string>;
  onExpandedPathsChange: React.Dispatch<React.SetStateAction<Set<string>>>;
  onOpenDirectory: (path: string) => void;
  onListingLoaded: (listing: WorkspaceListing) => void;
}

export default function WorkspaceTreePanel({
  userId,
  currentPath,
  seedListings,
  expandedPaths,
  onExpandedPathsChange,
  onOpenDirectory,
  onListingLoaded,
}: WorkspaceTreePanelProps) {
  const { t } = useI18n();
  const [listings, setListings] = useState<Map<string, WorkspaceListing>>(
    () => new Map(seedListings)
  );
  const [loadingPaths, setLoadingPaths] = useState<Set<string>>(() => new Set());
  const [errorPaths, setErrorPaths] = useState<Map<string, string>>(() => new Map());

  useEffect(() => {
    setListings((current) => {
      const next = new Map(current);
      for (const [path, listing] of seedListings) {
        next.set(path, listing);
      }
      return next;
    });
  }, [seedListings]);

  const loadTreeDirectory = useCallback(
    async (path: string) => {
      if (listings.has(path) || loadingPaths.has(path)) return;
      setLoadingPaths((current) => new Set(current).add(path));
      setErrorPaths((current) => {
        const next = new Map(current);
        next.delete(path);
        return next;
      });
      try {
        const listing = await fetchWorkspaceListing(path);
        setListings((current) => {
          const next = new Map(current);
          next.set(listing.path, listing);
          return next;
        });
        onListingLoaded(listing);
      } catch (err) {
        setErrorPaths((current) => {
          const next = new Map(current);
          next.set(path, err instanceof Error ? err.message : String(err));
          return next;
        });
      } finally {
        setLoadingPaths((current) => {
          const next = new Set(current);
          next.delete(path);
          return next;
        });
      }
    },
    [listings, loadingPaths, onListingLoaded]
  );

  useEffect(() => {
    void loadTreeDirectory(DEFAULT_WORKSPACE_PATH);
  }, [loadTreeDirectory, userId]);

  useEffect(() => {
    for (const path of expandedPaths) {
      void loadTreeDirectory(path);
    }
  }, [expandedPaths, loadTreeDirectory]);

  const rootEntry = useMemo<WorkspaceEntry>(
    () => ({
      name: DEFAULT_WORKSPACE_PATH.replace(/^\//, ""),
      path: DEFAULT_WORKSPACE_PATH,
      kind: "directory",
      size_bytes: 0,
      modified_at: "",
      is_hidden: false,
      mime_type: null,
    }),
    []
  );

  const toggleExpanded = (path: string) => {
    onExpandedPathsChange((current) => {
      const next = new Set(current);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  };

  const openDirectory = (path: string) => {
    onExpandedPathsChange((current) => new Set(current).add(path));
    onOpenDirectory(path);
  };

  const renderDirectory = (entry: WorkspaceEntry, depth: number): React.ReactNode => {
    const listing = listings.get(entry.path);
    const childDirectories = (listing?.entries || []).filter((child) => child.kind === "directory");
    const expanded = expandedPaths.has(entry.path);
    const loading = loadingPaths.has(entry.path);
    const error = errorPaths.get(entry.path);
    const active = currentPath === entry.path;

    return (
      <div key={entry.path} data-ripple-workspace-tree-entry={entry.path}>
        <div
          className={`group flex min-w-0 items-center gap-1 rounded-lg px-1.5 py-1 text-[#2B2F36] transition-colors ${
            active ? "bg-[#F0F5FF] text-[#1456F0]" : "hover:bg-[#F8F9FA]"
          }`}
          style={{ paddingLeft: `${Math.max(6, depth * 14 + 6)}px` }}
        >
          <button
            type="button"
            onClick={() => toggleExpanded(entry.path)}
            className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-[#646A73] hover:bg-white hover:text-[#1456F0]"
            aria-label={
              expanded
                ? t("files.collapseFolder", { name: entry.name })
                : t("files.expandFolder", { name: entry.name })
            }
            title={
              expanded
                ? t("files.collapseFolder", { name: entry.name })
                : t("files.expandFolder", { name: entry.name })
            }
          >
            {loading ? (
              <Loader2 size={13} className="animate-spin" />
            ) : expanded ? (
              <ChevronDown size={14} />
            ) : (
              <ChevronRight size={14} />
            )}
          </button>
          <button
            type="button"
            onClick={() => openDirectory(entry.path)}
            aria-current={active ? "page" : undefined}
            aria-label={t("files.openFolder", { name: entry.name })}
            title={entry.path}
            className={`flex min-w-0 flex-1 items-center gap-2 rounded-md px-1.5 py-1 text-left ${TYPOGRAPHY_META_MEDIUM_CLASS}`}
          >
            {expanded ? <FolderOpen size={14} /> : <Folder size={14} />}
            <span className="truncate font-[family-name:var(--font-mono)]">{entry.name}</span>
          </button>
        </div>
        {error && (
          <div
            className={`ml-8 flex items-center gap-1 px-2 py-1 text-[#B42318] ${TYPOGRAPHY_META_CLASS}`}
          >
            <AlertTriangle size={12} className="shrink-0" />
            <span className="truncate">{error}</span>
          </div>
        )}
        {expanded && childDirectories.length > 0 && (
          <div>{childDirectories.map((child) => renderDirectory(child, depth + 1))}</div>
        )}
      </div>
    );
  };

  return (
    <aside
      data-ripple-workspace-tree="navigation"
      aria-label={t("files.workspaceFolders")}
      className="hidden min-h-0 flex-col border-r border-[#DEE0E3] bg-[#FBFCFD] lg:flex"
    >
      <div className="flex h-11 shrink-0 items-center justify-between border-b border-[#DEE0E3] px-3">
        <span className={`text-[#1F2329] ${TYPOGRAPHY_BODY_MEDIUM_CLASS}`}>
          {t("files.workspaceFolders")}
        </span>
        {loadingPaths.has(DEFAULT_WORKSPACE_PATH) && (
          <Loader2 size={13} className="animate-spin text-[#646A73]" />
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
        {renderDirectory(rootEntry, 0)}
      </div>
    </aside>
  );
}
