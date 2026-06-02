"use client";

import React, { useEffect, useMemo, useState } from "react";
import { ArrowBigLeft, Check, ChevronRight, Folder, Loader2, X } from "lucide-react";
import { useI18n } from "@/i18n";
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

function folderName(path: string, t: ReturnType<typeof useI18n>["t"]): string {
  if (path === WORKSPACE_ROOT) return t("files.workspaceName");
  return path.split("/").filter(Boolean).pop() || t("files.folderName");
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
  const { t } = useI18n();
  const [path, setPath] = useState(WORKSPACE_ROOT);
  const [listing, setListing] = useState<WorkspaceListing | null>(null);
  const [loading, setLoading] = useState(false);
  const [selectingPath, setSelectingPath] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const directories = useMemo(() => sortDirectories(listing?.entries || []), [listing?.entries]);
  const parent = parentPath(path);
  const selectedPath = contextFolderPath || null;
  const selectedLabel = contextFolderPath ? folderName(contextFolderPath, t) : null;

  useEffect(() => {
    setPath(contextFolderPath || WORKSPACE_ROOT);
    setListing(null);
  }, [contextFolderPath, userId]);

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
          aria-label={t("files.closeFolderPicker")}
          title={t("automations.close")}
          onClick={onClose}
          className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-[#667085] hover:bg-[#f3f4f6] hover:text-[#111827]"
        >
          <X size={15} />
        </button>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[12px] font-semibold text-[#111827]">
            {t("files.chooseFocusFolder")}
          </div>
          <div className="truncate font-[family-name:var(--font-mono)] text-[10px] text-[#667085]">
            {path}
          </div>
        </div>
        {parent && (
          <button
            type="button"
            aria-label={t("files.goToParentFolder")}
            title={t("files.goToParentFolder")}
            onClick={() => setPath(parent)}
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-[#667085] hover:bg-[#f3f4f6] hover:text-[#111827]"
          >
            <ArrowBigLeft size={15} />
          </button>
        )}
      </div>

      <div className="max-h-[54vh] overflow-y-auto p-2 sm:max-h-80">
        {selectedLabel && (
          <div className="mb-2 rounded-xl border border-[#dfe6f4] bg-[#f6f8ff] px-3 py-2">
            <div className="flex min-w-0 items-center gap-2">
              <div className="min-w-0 flex-1">
                <div className="text-[10px] font-semibold tracking-[0.08em] text-[#7a8496] uppercase">
                  {t("files.selected")}
                </div>
                <div className="mt-0.5 truncate text-[12px] font-semibold text-[#172033]">
                  {selectedLabel}
                </div>
              </div>
              <button
                type="button"
                onClick={() => void selectFolder(WORKSPACE_ROOT)}
                disabled={Boolean(selectingPath)}
                className="shrink-0 rounded-lg px-2 py-1 text-[11px] font-semibold text-[#3c3c43] hover:bg-[#f3f4f6] hover:text-[#111827] disabled:cursor-not-allowed disabled:opacity-50"
              >
                {selectingPath === WORKSPACE_ROOT
                  ? t("files.cancelling")
                  : t("files.cancelSelection")}
              </button>
            </div>
          </div>
        )}

        {loading && (
          <div className="flex items-center gap-2 px-3 py-4 text-[12px] text-[#667085]">
            <Loader2 size={14} className="animate-spin" />
            {t("files.loadingFolders")}
          </div>
        )}
        {error && <div className="px-3 py-3 text-[12px] text-[#cf222e]">{error}</div>}
        {!loading && !error && directories.length === 0 && (
          <div className="px-3 py-4 text-[12px] text-[#667085]">{t("files.noFoldersHere")}</div>
        )}
        {!loading &&
          !error &&
          directories.map((entry) => {
            const selected = entry.path === selectedPath;
            return (
              <div key={entry.path} className="flex min-w-0 items-center gap-1">
                <button
                  type="button"
                  aria-label={t("files.openFolder", { name: entry.name })}
                  onClick={() => setPath(entry.path)}
                  className={`flex h-10 min-w-0 flex-1 items-center gap-2 rounded-lg px-2 text-left text-[12px] text-[#172033] hover:bg-[#f7f8fa] ${
                    selected ? "bg-[#f3f7ff]" : ""
                  }`}
                >
                  <Folder size={14} className="shrink-0 text-[#667085]" />
                  <span className="min-w-0 flex-1 truncate">{entry.name}</span>
                  <ChevronRight size={14} className="shrink-0 text-[#98a2b3]" />
                </button>
                <button
                  type="button"
                  aria-label={t("files.selectFocusFolder", { name: entry.name })}
                  title={t("files.selectPath", { path: entry.path })}
                  onClick={() => void selectFolder(entry.path)}
                  disabled={Boolean(selectingPath) || selected}
                  className={`inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${
                    selected
                      ? "bg-[#eef4ff] text-[#007aff]"
                      : "text-[#667085] hover:bg-[#f3f4f6] hover:text-[#111827]"
                  } disabled:cursor-not-allowed disabled:opacity-60`}
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
