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
    <div className="flex h-full flex-col overflow-hidden bg-[#f6f8fa] text-[#24292f]">
      <div className="flex shrink-0 items-center justify-between border-b border-[#d0d7de] bg-white px-4 py-3">
        <div className="min-w-0">
          <p className="text-[10px] font-semibold tracking-wider text-[#6e7781] uppercase">
            Workspace
          </p>
          <p className="truncate font-[family-name:var(--font-mono)] text-sm font-semibold text-[#24292f]">
            {listing?.path || currentPath}
          </p>
        </div>
        <button
          type="button"
          onClick={() => void loadDirectory(currentPath)}
          className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-[#d0d7de] bg-white text-[#57606a] hover:bg-[#f6f8fa] hover:text-[#24292f]"
          title="Refresh workspace"
          disabled={loading}
        >
          {loading ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
        </button>
      </div>

      {error && (
        <div className="m-4 mb-0 flex items-start gap-2 rounded-md border border-[#cf222e]/25 bg-[#ffebe9] p-3 text-xs font-medium text-[#cf222e]">
          <AlertTriangle size={14} className="mt-0.5 shrink-0" />
          <span className="break-words">{displayError(error)}</span>
        </div>
      )}

      <div className="grid min-h-0 flex-1 grid-rows-[minmax(0,1fr)_minmax(160px,42%)] gap-3 p-4">
        <div className="min-h-0 overflow-hidden rounded-md border border-[#d0d7de] bg-white">
          <div className="flex items-center justify-between border-b border-[#d0d7de] bg-[#f6f8fa] px-3 py-2">
            <span className="text-xs font-semibold tracking-wider text-[#6e7781] uppercase">
              Files
            </span>
            {listing?.parent_path && (
              <button
                type="button"
                onClick={() => void loadDirectory(listing.parent_path || "/workspace")}
                className="flex items-center gap-1 rounded-md border border-[#d0d7de] bg-white px-2 py-1 text-[11px] font-medium text-[#57606a] hover:bg-[#f6f8fa] hover:text-[#24292f]"
              >
                <ArrowUp size={12} />
                Up
              </button>
            )}
          </div>
          <div className="h-full overflow-y-auto pb-10">
            {loading && !listing ? (
              <div className="flex h-40 items-center justify-center gap-2 text-sm font-medium text-[#6e7781]">
                <Loader2 size={16} className="animate-spin" />
                Loading
              </div>
            ) : listing && listing.entries.length === 0 ? (
              <div className="flex h-40 items-center justify-center px-4 text-center text-sm font-medium text-[#6e7781]">
                Empty workspace
              </div>
            ) : (
              <div className="divide-y divide-[#d8dee4]">
                {listing?.entries.map((entry) => (
                  <button
                    key={entry.path}
                    type="button"
                    onClick={() => void openEntry(entry)}
                    className={`flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-[#f6f8fa] ${
                      preview?.path === entry.path ? "bg-[#ddf4ff]" : "bg-white"
                    }`}
                  >
                    <span
                      className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-[#d0d7de] ${
                        entry.kind === "directory" ? "bg-[#f6f8fa]" : "bg-white"
                      }`}
                    >
                      {entry.kind === "directory" ? <Folder size={15} /> : <FileText size={15} />}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span
                        className={`block truncate font-[family-name:var(--font-mono)] text-sm font-medium text-[#24292f] ${
                          entry.is_hidden ? "opacity-55" : ""
                        }`}
                      >
                        {entry.name}
                      </span>
                      <span className="mt-0.5 block truncate font-[family-name:var(--font-mono)] text-[11px] text-[#6e7781]">
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

        <div className="flex min-h-0 flex-col overflow-hidden rounded-md border border-[#d0d7de] bg-white">
          <div className="flex shrink-0 items-center gap-2 border-b border-[#d0d7de] bg-[#f6f8fa] px-3 py-2 text-[#57606a]">
            <FileText size={13} />
            <span className="truncate text-[13px] font-semibold">{preview?.name || "Preview"}</span>
            {previewLoading && <Loader2 size={12} className="ml-auto animate-spin" />}
          </div>
          <div className="min-h-0 flex-1 overflow-auto bg-white p-3">
            {preview ? (
              <div className="space-y-2">
                <div className="flex flex-wrap items-center gap-2 font-[family-name:var(--font-mono)] text-[11px] font-medium text-[#6e7781]">
                  <span>{formatBytes(preview.size_bytes)}</span>
                  <span>{preview.mime_type}</span>
                  {preview.truncated && (
                    <span className="rounded-full border border-[#bf8700]/35 bg-[#fff8c5] px-1.5 py-0.5 text-[10px] text-[#7d4e00] uppercase">
                      truncated
                    </span>
                  )}
                </div>
                <pre className="overflow-x-auto font-[family-name:var(--font-mono)] text-[12px] leading-relaxed break-words whitespace-pre-wrap text-[#24292f]">
                  {preview.content}
                </pre>
              </div>
            ) : (
              <div className="flex h-full items-center justify-center px-4 text-center text-sm font-medium text-[#6e7781]">
                Select a text file
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
