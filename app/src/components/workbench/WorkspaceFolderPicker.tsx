"use client";

import React, { useEffect, useMemo, useState } from "react";
import { ArrowBigLeft, Check, Folder, Loader2, X } from "lucide-react";
import { fetchWorkspaceListing } from "@/lib/api";
import type { WorkspaceEntry, WorkspaceListing } from "@/types";

const WORKSPACE_ROOT = "/workspace";

interface WorkspaceFolderPickerProps {
  userId?: string;
  contextFolderPath?: string | null;
  onSelectFolder: (path: string) => void | Promise<void>;
  onClose: () => void;
}

function parentPath(path: string): string | null {
  if (path === WORKSPACE_ROOT) return null;
  const parts = path.split("/").filter(Boolean);
  if (parts.length <= 1) return WORKSPACE_ROOT;
  return `/${parts.slice(0, -1).join("/")}`;
}

function folderName(path: string): string {
  if (path === WORKSPACE_ROOT) return "Workspace";
  return path.split("/").filter(Boolean).pop() || "Folder";
}

function sortDirectories(entries: WorkspaceEntry[]): WorkspaceEntry[] {
  return entries
    .filter((entry) => entry.kind === "directory")
    .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
}

export default function WorkspaceFolderPicker({
  userId,
  contextFolderPath = null,
  onSelectFolder,
  onClose,
}: WorkspaceFolderPickerProps) {
  const [path, setPath] = useState(WORKSPACE_ROOT);
  const [listing, setListing] = useState<WorkspaceListing | null>(null);
  const [loading, setLoading] = useState(false);
  const [selectingPath, setSelectingPath] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const directories = useMemo(() => sortDirectories(listing?.entries || []), [listing?.entries]);
  const parent = parentPath(path);
  const selectedPath = contextFolderPath || WORKSPACE_ROOT;

  useEffect(() => {
    setPath(WORKSPACE_ROOT);
    setListing(null);
  }, [userId]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchWorkspaceListing(path)
      .then((nextListing) => {
        if (!cancelled) setListing(nextListing);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [path, userId]);

  const selectFolder = async (nextPath: string) => {
    if (selectingPath) return;
    setSelectingPath(nextPath);
    try {
      await onSelectFolder(nextPath);
      onClose();
    } finally {
      setSelectingPath(null);
    }
  };

  return (
    <div
      data-ripple-chat-folder-picker
      className="fixed inset-x-3 bottom-[calc(82px+env(safe-area-inset-bottom))] z-50 overflow-hidden rounded-2xl border border-[#dfe6f4] bg-white shadow-[0_24px_64px_rgba(15,23,42,0.18)] sm:absolute sm:bottom-full sm:left-0 sm:mb-2 sm:w-80"
    >
      <div className="flex items-center gap-2 border-b border-[#e8edf7] px-3 py-2">
        <button
          type="button"
          aria-label="Close folder picker"
          title="Close"
          onClick={onClose}
          className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-[#667085] hover:bg-[#f3f4f6] hover:text-[#111827]"
        >
          <X size={15} />
        </button>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[12px] font-semibold text-[#111827]">
            Choose context folder
          </div>
          <div className="truncate font-[family-name:var(--font-mono)] text-[10px] text-[#667085]">
            {path}
          </div>
        </div>
        {parent && (
          <button
            type="button"
            aria-label="Go to parent folder"
            title="Parent folder"
            onClick={() => setPath(parent)}
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-[#667085] hover:bg-[#f3f4f6] hover:text-[#111827]"
          >
            <ArrowBigLeft size={15} />
          </button>
        )}
      </div>

      <div className="max-h-[54vh] overflow-y-auto p-2 sm:max-h-80">
        <button
          type="button"
          onClick={() => void selectFolder(path)}
          disabled={Boolean(selectingPath)}
          className="mb-2 flex w-full min-w-0 items-center gap-2 rounded-xl border border-[#dfe6f4] bg-[#f6f8ff] px-3 py-2 text-left text-[12px] font-semibold text-[#172033] hover:bg-[#eef4ff] disabled:cursor-not-allowed disabled:opacity-50"
        >
          {selectingPath === path ? (
            <Loader2 size={14} className="shrink-0 animate-spin text-[#2463eb]" />
          ) : (
            <Check size={14} className="shrink-0 text-[#2463eb]" />
          )}
          <span className="min-w-0 flex-1 truncate">
            {path === WORKSPACE_ROOT ? "Use full workspace" : "Use this folder"}
          </span>
          <span className="shrink-0 text-[10px] text-[#667085]">{folderName(path)}</span>
        </button>

        {loading && (
          <div className="flex items-center gap-2 px-3 py-4 text-[12px] text-[#667085]">
            <Loader2 size={14} className="animate-spin" />
            Loading folders
          </div>
        )}
        {error && <div className="px-3 py-3 text-[12px] text-[#cf222e]">{error}</div>}
        {!loading && !error && directories.length === 0 && (
          <div className="px-3 py-4 text-[12px] text-[#667085]">No folders here</div>
        )}
        {!loading &&
          !error &&
          directories.map((entry) => {
            const selected = entry.path === selectedPath;
            return (
              <div key={entry.path} className="flex min-w-0 items-center gap-1">
                <button
                  type="button"
                  onClick={() => setPath(entry.path)}
                  className="flex h-10 min-w-0 flex-1 items-center gap-2 rounded-lg px-2 text-left text-[12px] text-[#172033] hover:bg-[#f7f8fa]"
                >
                  <Folder size={14} className="shrink-0 text-[#667085]" />
                  <span className="min-w-0 flex-1 truncate">{entry.name}</span>
                </button>
                <button
                  type="button"
                  aria-label={`Use ${entry.name}`}
                  title={`Use ${entry.path}`}
                  onClick={() => void selectFolder(entry.path)}
                  disabled={Boolean(selectingPath)}
                  className={`inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${
                    selected
                      ? "bg-[#eef4ff] text-[#2463eb]"
                      : "text-[#667085] hover:bg-[#f3f4f6] hover:text-[#111827]"
                  } disabled:cursor-not-allowed disabled:opacity-50`}
                >
                  {selectingPath === entry.path ? (
                    <Loader2 size={14} className="animate-spin" />
                  ) : (
                    <Check size={14} />
                  )}
                </button>
              </div>
            );
          })}
      </div>
    </div>
  );
}
