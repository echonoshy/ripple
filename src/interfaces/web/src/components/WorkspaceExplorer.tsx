"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  ArrowUp,
  Edit3,
  Eye,
  FileText,
  Folder,
  Loader2,
  RefreshCw,
  Save,
  Undo2,
} from "lucide-react";
import { fetchWorkspaceFilePreview, fetchWorkspaceListing, saveWorkspaceFile } from "@/lib/api";
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
  const [draft, setDraft] = useState("");
  const [isEditing, setIsEditing] = useState(false);
  const [loading, setLoading] = useState(false);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const isDirty = useMemo(() => Boolean(preview && draft !== preview.content), [draft, preview]);

  const loadDirectory = useCallback(async (path: string) => {
    setLoading(true);
    setError(null);
    try {
      const data = await fetchWorkspaceListing(path);
      setListing(data);
      setCurrentPath(data.path);
      setPreview(null);
      setDraft("");
      setIsEditing(false);
      setSaveError(null);
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
      const nextPreview = await fetchWorkspaceFilePreview(entry.path, 256 * 1024);
      setPreview(nextPreview);
      setDraft(nextPreview.content);
      setIsEditing(false);
      setSaveError(null);
    } catch (err) {
      setPreview(null);
      setDraft("");
      setIsEditing(false);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPreviewLoading(false);
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

      <div className="grid min-h-0 flex-1 grid-rows-[minmax(220px,40%)_minmax(0,1fr)] lg:grid-cols-[minmax(280px,360px)_minmax(0,1fr)] lg:grid-rows-none">
        <div className="min-h-0 overflow-hidden border-b border-[#d0d7de] bg-white lg:border-r lg:border-b-0">
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

        <div className="flex min-h-0 flex-col overflow-hidden bg-white">
          <div className="flex shrink-0 items-center gap-2 border-b border-[#d0d7de] bg-[#f6f8fa] px-3 py-2 text-[#57606a]">
            <FileText size={13} />
            <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-[#24292f]">
              {preview?.path || "Select a file"}
            </span>
            {previewLoading && <Loader2 size={12} className="animate-spin" />}
            {preview && (
              <div className="flex shrink-0 items-center gap-1">
                <button
                  type="button"
                  onClick={() => setIsEditing(false)}
                  className={`inline-flex h-7 items-center gap-1 rounded-md border px-2 text-xs font-medium ${
                    !isEditing
                      ? "border-[#0969da] bg-white text-[#0969da]"
                      : "border-[#d0d7de] bg-white text-[#57606a] hover:bg-[#f6f8fa]"
                  }`}
                  title="Preview"
                >
                  <Eye size={12} />
                  Preview
                </button>
                <button
                  type="button"
                  disabled={preview.truncated}
                  onClick={() => setIsEditing(true)}
                  className={`inline-flex h-7 items-center gap-1 rounded-md border px-2 text-xs font-medium ${
                    isEditing
                      ? "border-[#0969da] bg-white text-[#0969da]"
                      : "border-[#d0d7de] bg-white text-[#57606a] hover:bg-[#f6f8fa] disabled:cursor-not-allowed disabled:text-[#8c959f]"
                  }`}
                  title={preview.truncated ? "Truncated files cannot be edited safely" : "Edit"}
                >
                  <Edit3 size={12} />
                  Edit
                </button>
              </div>
            )}
          </div>
          <div className="min-h-0 flex-1 overflow-auto bg-white">
            {preview ? (
              <div className="flex min-h-full flex-col">
                <div className="flex flex-wrap items-center gap-2 border-b border-[#d8dee4] px-3 py-2 font-[family-name:var(--font-mono)] text-[11px] font-medium text-[#6e7781]">
                  <span>{formatBytes(preview.size_bytes)}</span>
                  <span>{preview.mime_type}</span>
                  <span>{formatModified(preview.modified_at)}</span>
                  {isDirty && (
                    <span className="rounded-full border border-[#0969da]/25 bg-[#ddf4ff] px-1.5 py-0.5 text-[10px] text-[#0969da] uppercase">
                      unsaved
                    </span>
                  )}
                  {preview.truncated && (
                    <span className="rounded-full border border-[#bf8700]/35 bg-[#fff8c5] px-1.5 py-0.5 text-[10px] text-[#7d4e00] uppercase">
                      truncated
                    </span>
                  )}
                  {isEditing && (
                    <div className="ml-auto flex items-center gap-1">
                      <button
                        type="button"
                        onClick={handleRevert}
                        disabled={!isDirty || saving}
                        className="inline-flex h-7 items-center gap-1 rounded-md border border-[#d0d7de] bg-white px-2 text-xs font-medium text-[#57606a] hover:bg-[#f6f8fa] disabled:cursor-not-allowed disabled:text-[#8c959f]"
                      >
                        <Undo2 size={12} />
                        Revert
                      </button>
                      <button
                        type="button"
                        onClick={() => void handleSave()}
                        disabled={!isDirty || saving || preview.truncated}
                        className="inline-flex h-7 items-center gap-1 rounded-md border border-[#0969da] bg-[#0969da] px-2 text-xs font-semibold text-white hover:bg-[#075dbd] disabled:cursor-not-allowed disabled:border-[#d0d7de] disabled:bg-[#f6f8fa] disabled:text-[#8c959f]"
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
                  <div className="m-3 mb-0 flex items-start gap-2 rounded-md border border-[#cf222e]/25 bg-[#ffebe9] p-3 text-xs font-medium text-[#cf222e]">
                    <AlertTriangle size={14} className="mt-0.5 shrink-0" />
                    <span>{saveError}</span>
                  </div>
                )}
                {isEditing ? (
                  <textarea
                    value={draft}
                    onChange={(event) => setDraft(event.target.value)}
                    spellCheck={false}
                    className="min-h-0 flex-1 resize-none overflow-auto border-0 bg-white p-3 font-[family-name:var(--font-mono)] text-[12px] leading-relaxed text-[#24292f] outline-none"
                  />
                ) : (
                  <pre className="min-h-0 flex-1 overflow-auto p-3 font-[family-name:var(--font-mono)] text-[12px] leading-relaxed break-words whitespace-pre-wrap text-[#24292f]">
                    {preview.content}
                  </pre>
                )}
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
