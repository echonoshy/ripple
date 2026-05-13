"use client";

import React, { useCallback, useEffect, useState } from "react";
import { AlertTriangle, ArrowUp, FileText, Folder, Loader2, RefreshCw } from "lucide-react";
import { fetchWorkspaceFilePreview, fetchWorkspaceListing } from "@/lib/api";
import { WorkspaceEntry, WorkspaceFilePreview, WorkspaceListing } from "@/types";

interface WorkspaceExplorerProps {
  userId: string;
  refreshToken: number;
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

function displayError(error: string): string {
  if (error.includes("(404)")) return "Workspace is not ready for this user.";
  if (error.includes("(415)")) return "This file cannot be previewed as text.";
  if (error.includes("(403)")) return "Access denied for this path.";
  return error;
}

export default function WorkspaceExplorer({ userId, refreshToken }: WorkspaceExplorerProps) {
  const [currentPath, setCurrentPath] = useState("/workspace");
  const [listing, setListing] = useState<WorkspaceListing | null>(null);
  const [preview, setPreview] = useState<WorkspaceFilePreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadDirectory = useCallback(async (path: string) => {
    setLoading(true);
    setError(null);
    try {
      const data = await fetchWorkspaceListing(path);
      setListing(data);
      setCurrentPath(data.path);
      setPreview(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    setCurrentPath("/workspace");
    void loadDirectory("/workspace");
  }, [loadDirectory, userId]);

  useEffect(() => {
    void loadDirectory(currentPath);
  }, [currentPath, loadDirectory, refreshToken]);

  const openEntry = async (entry: WorkspaceEntry) => {
    if (entry.kind === "directory") {
      await loadDirectory(entry.path);
      return;
    }
    setPreviewLoading(true);
    setError(null);
    try {
      setPreview(await fetchWorkspaceFilePreview(entry.path));
    } catch (err) {
      setPreview(null);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPreviewLoading(false);
    }
  };

  return (
    <div className="bg-ripple-sidebar flex h-full flex-col overflow-hidden">
      <div className="border-ripple-ink flex shrink-0 items-center justify-between border-b-2 bg-white px-4 py-3">
        <div className="min-w-0">
          <p className="text-ripple-ink/55 text-[10px] font-bold tracking-wider uppercase">
            Workspace
          </p>
          <p className="text-ripple-ink truncate font-[family-name:var(--font-mono)] text-sm font-bold">
            {listing?.path || currentPath}
          </p>
        </div>
        <button
          type="button"
          onClick={() => void loadDirectory(currentPath)}
          className="btn-icon h-8 w-8 shrink-0"
          title="Refresh workspace"
          disabled={loading}
        >
          {loading ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
        </button>
      </div>

      {error && (
        <div className="border-ripple-ink bg-ripple-red/20 text-ripple-ink m-4 mb-0 flex items-start gap-2 border-2 p-3 text-xs font-bold shadow-[2px_2px_0_#111111]">
          <AlertTriangle size={14} className="mt-0.5 shrink-0" />
          <span className="break-words">{displayError(error)}</span>
        </div>
      )}

      <div className="grid min-h-0 flex-1 grid-rows-[minmax(0,1fr)_minmax(160px,42%)] gap-3 p-4">
        <div className="border-ripple-ink min-h-0 overflow-hidden border-2 bg-white shadow-[4px_4px_0_#111111]">
          <div className="border-ripple-ink bg-ripple-lime/35 flex items-center justify-between border-b-2 px-3 py-2">
            <span className="text-ripple-ink text-xs font-bold tracking-wider uppercase">
              Files
            </span>
            {listing?.parent_path && (
              <button
                type="button"
                onClick={() => void loadDirectory(listing.parent_path || "/workspace")}
                className="border-ripple-ink hover:bg-ripple-yellow flex items-center gap-1 border-2 bg-white px-2 py-1 text-[11px] font-bold"
              >
                <ArrowUp size={12} />
                Up
              </button>
            )}
          </div>
          <div className="h-full overflow-y-auto pb-10">
            {loading && !listing ? (
              <div className="text-ripple-ink/50 flex h-40 items-center justify-center gap-2 text-sm font-bold">
                <Loader2 size={16} className="animate-spin" />
                Loading
              </div>
            ) : listing && listing.entries.length === 0 ? (
              <div className="text-ripple-ink/50 flex h-40 items-center justify-center px-4 text-center text-sm font-bold">
                Empty workspace
              </div>
            ) : (
              <div className="divide-ripple-ink/10 divide-y">
                {listing?.entries.map((entry) => (
                  <button
                    key={entry.path}
                    type="button"
                    onClick={() => void openEntry(entry)}
                    className={`hover:bg-ripple-yellow/30 flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors ${
                      preview?.path === entry.path ? "bg-ripple-yellow/45" : "bg-white"
                    }`}
                  >
                    <span
                      className={`border-ripple-ink flex h-8 w-8 shrink-0 items-center justify-center border-2 ${
                        entry.kind === "directory" ? "bg-ripple-lavender/65" : "bg-ripple-cyan/20"
                      }`}
                    >
                      {entry.kind === "directory" ? <Folder size={15} /> : <FileText size={15} />}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span
                        className={`text-ripple-ink block truncate font-[family-name:var(--font-mono)] text-sm font-bold ${
                          entry.is_hidden ? "opacity-55" : ""
                        }`}
                      >
                        {entry.name}
                      </span>
                      <span className="text-ripple-ink/45 mt-0.5 block truncate font-[family-name:var(--font-mono)] text-[11px]">
                        {entry.kind === "directory" ? "folder" : formatBytes(entry.size_bytes)}
                        {formatModified(entry.modified_at)
                          ? ` · ${formatModified(entry.modified_at)}`
                          : ""}
                      </span>
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="border-ripple-ink flex min-h-0 flex-col overflow-hidden border-2 bg-white shadow-[4px_4px_0_#111111]">
          <div className="terminal-titlebar shrink-0">
            <FileText size={13} />
            <span className="text-[13px] font-bold tracking-wider uppercase">
              {preview?.name || "Preview"}
            </span>
            {previewLoading && <Loader2 size={12} className="ml-auto animate-spin" />}
          </div>
          <div className="bg-ripple-paper min-h-0 flex-1 overflow-auto p-3">
            {preview ? (
              <div className="space-y-2">
                <div className="text-ripple-ink/55 flex flex-wrap items-center gap-2 font-[family-name:var(--font-mono)] text-[11px] font-bold">
                  <span>{formatBytes(preview.size_bytes)}</span>
                  <span>{preview.mime_type}</span>
                  {preview.truncated && (
                    <span className="border-ripple-pink text-ripple-pink border-2 bg-white px-1.5 py-0.5 text-[10px] uppercase">
                      truncated
                    </span>
                  )}
                </div>
                <pre className="text-ripple-ink overflow-x-auto font-[family-name:var(--font-mono)] text-[12px] leading-relaxed break-words whitespace-pre-wrap">
                  {preview.content}
                </pre>
              </div>
            ) : (
              <div className="text-ripple-ink/45 flex h-full items-center justify-center px-4 text-center text-sm font-bold">
                Select a text file
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
