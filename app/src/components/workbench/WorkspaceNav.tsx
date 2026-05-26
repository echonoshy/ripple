"use client";

import React from "react";
import {
  AlertTriangle,
  Check,
  Cpu,
  Edit3,
  HardDrive,
  Layers,
  Loader2,
  MoreHorizontal,
  Pin,
  Plus,
  Settings,
  Trash2,
  X,
} from "lucide-react";
import RippleIcon from "@/components/icons/RippleIcon";
import { formatSessionActivityTime } from "@/lib/workbench";
import { mainNavItems, type WorkspaceView } from "@/lib/workspaceViews";
import type { WorkbenchSessionSummary } from "@/types";
import SessionAttentionDot from "./SessionAttentionDot";
import { fetchUserProfile } from "@/lib/api";

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
}

interface WorkspaceNavProps {
  sessions: WorkbenchSessionSummary[];
  selectedSessionId: string | null;
  activeView: WorkspaceView;
  isLoading: boolean;
  sessionLoadError?: string | null;
  isGenerating: boolean;
  userId: string;
  onUserIdChange: (newUserId: string) => void;
  onNewSession: () => void;
  onSelectView: (view: WorkspaceView) => void;
  onSelectSession: (sessionId: string) => void;
  onDeleteSession: (sessionId: string, event: React.MouseEvent) => void;
  onUpdateSession: (
    sessionId: string,
    updates: { title?: string; pinned?: boolean }
  ) => Promise<unknown>;
  onOpenSettings: () => void;
}

export default function WorkspaceNav({
  sessions,
  selectedSessionId,
  activeView,
  isLoading,
  sessionLoadError,
  isGenerating,
  userId,
  onUserIdChange,
  onNewSession,
  onSelectView,
  onSelectSession,
  onDeleteSession,
  onUpdateSession,
  onOpenSettings,
}: WorkspaceNavProps) {
  const [activeMenuSessionId, setActiveMenuSessionId] = React.useState<string | null>(null);
  const [editingSessionId, setEditingSessionId] = React.useState<string | null>(null);
  const [editingTitle, setEditingTitle] = React.useState<string>("");
  const isCancellingRef = React.useRef(false);

  const [isUserMenuOpen, setIsUserMenuOpen] = React.useState(false);
  const [isSwitchingUser, setIsSwitchingUser] = React.useState(false);
  const [newUserDraft, setNewUserDraft] = React.useState("");
  const [userUsageData, setUserUsageData] = React.useState<Awaited<
    ReturnType<typeof fetchUserProfile>
  > | null>(null);
  const [isLoadingUsage, setIsLoadingUsage] = React.useState(false);
  const isSwitchCancelRef = React.useRef(false);

  React.useEffect(() => {
    let isMounted = true;
    const fetchUsage = async () => {
      setIsLoadingUsage(true);
      try {
        const data = await fetchUserProfile();
        if (isMounted) {
          setUserUsageData(data);
        }
      } catch (err) {
        console.error("Failed to fetch user profile/usage:", err);
      } finally {
        if (isMounted) {
          setIsLoadingUsage(false);
        }
      }
    };

    fetchUsage();

    return () => {
      isMounted = false;
    };
  }, [isUserMenuOpen, userId]);

  const handleSave = () => {
    if (!isSwitchingUser) return;
    if (isSwitchCancelRef.current) {
      isSwitchCancelRef.current = false;
      return;
    }
    const trimmed = newUserDraft.trim();
    if (/^[a-zA-Z0-9_-]{1,64}$/.test(trimmed)) {
      onUserIdChange(trimmed);
      setIsSwitchingUser(false);
    } else {
      alert(
        "User ID can only contain alphanumeric characters, dashes, and underscores (1-64 characters)."
      );
    }
  };

  const isBackdropVisible = Boolean(activeMenuSessionId || isUserMenuOpen);

  return (
    <div className="flex h-full min-h-0 flex-col text-[#0d0d0d]" aria-busy={isGenerating}>
      {isBackdropVisible && (
        <div
          className="fixed inset-0 z-40 bg-transparent"
          onClick={() => {
            setActiveMenuSessionId(null);
            setIsUserMenuOpen(false);
          }}
        />
      )}
      <div className="border-b border-[#e5e7eb] px-4 pt-4 pb-4">
        <div className="mb-5 flex h-8 items-center gap-3">
          <RippleIcon size={30} className="h-[30px] w-[30px] shrink-0 rounded-lg" />
          <div className="min-w-0 flex-1">
            <div className="truncate text-[17px] leading-none font-semibold">Ripple</div>
          </div>
          <button
            type="button"
            onClick={onOpenSettings}
            aria-label={`Settings for ${userId}`}
            title="Settings"
            className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-transparent text-[#6b7280] hover:border-[#e5e7eb] hover:bg-white hover:text-[#0d0d0d]"
          >
            <Settings size={15} />
          </button>
        </div>

        <button
          type="button"
          onClick={onNewSession}
          className="flex h-9 w-full items-center justify-center gap-2 rounded-full bg-[linear-gradient(135deg,#2f6bff,#7b5cff)] px-3 text-[13px] font-semibold text-white shadow-[0_12px_26px_rgba(64,92,255,0.24)] transition-all duration-200 hover:brightness-110 active:scale-[0.98]"
        >
          <Plus size={15} />
          New session
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-4">
        <nav className="space-y-1">
          {mainNavItems.map((item) => {
            const Icon = item.icon;
            const selected = item.id === activeView;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => onSelectView(item.id)}
                className={`flex h-9 w-full items-center gap-3 rounded-lg border px-3 text-left text-sm font-medium transition-all ${
                  selected
                    ? "border-[#2463eb]/10 bg-white text-[#0b57d0] shadow-[0_2px_8px_rgba(36,99,235,0.06),0_1px_2px_rgba(36,99,235,0.02)]"
                    : "border-transparent text-[#374151] hover:bg-white/80 hover:text-[#0d0d0d] hover:shadow-[0_2px_6px_rgba(0,0,0,0.02)]"
                }`}
              >
                <Icon size={16} className={selected ? "text-[#2463eb]" : "text-[#6b7280]"} />
                {item.label}
              </button>
            );
          })}
        </nav>

        <div className="mt-10">
          <div className="mb-2 flex items-center justify-between px-2">
            <span className="text-[11px] font-medium tracking-wide text-[#6b7280] uppercase">
              Sessions
            </span>
            {isLoading ? <Loader2 size={13} className="animate-spin text-[#6b7280]" /> : null}
          </div>

          {sessionLoadError && !isLoading ? (
            <div className="flex items-start gap-2 rounded-lg border border-[#cf222e]/25 bg-[#ffebe9] px-3 py-3 text-sm font-medium text-[#cf222e]">
              <AlertTriangle size={14} className="mt-0.5 shrink-0" />
              <span className="min-w-0 break-words">{sessionLoadError}</span>
            </div>
          ) : sessions.length === 0 && !isLoading ? (
            <div className="rounded-lg border border-dashed border-[#e5e7eb] bg-white px-3 py-5 text-center text-sm text-[#6b7280]">
              No sessions yet
            </div>
          ) : (
            <div className="space-y-1">
              {sessions.map((session) => {
                const selected = session.sessionId === selectedSessionId;
                const activityTime = formatSessionActivityTime(session.lastActivityAt);
                const isEditing = editingSessionId === session.sessionId;

                if (isEditing) {
                  const handleSave = () => {
                    if (isCancellingRef.current) {
                      isCancellingRef.current = false;
                      return;
                    }
                    const trimmed = editingTitle.trim();
                    if (trimmed && trimmed !== session.title) {
                      void onUpdateSession(session.sessionId, { title: trimmed });
                    }
                    setEditingSessionId(null);
                  };

                  return (
                    <div
                      key={session.sessionId}
                      className="flex items-center gap-2 rounded-lg border border-[#2463eb] bg-white px-2.5 py-1.5 text-[#0d0d0d]"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <SessionAttentionDot attention={session.attention} reserveSpace />
                      <input
                        type="text"
                        value={editingTitle}
                        onChange={(e) => setEditingTitle(e.target.value)}
                        onBlur={handleSave}
                        onFocus={(e) => e.target.select()}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            handleSave();
                          } else if (e.key === "Escape") {
                            isCancellingRef.current = true;
                            setEditingSessionId(null);
                          }
                        }}
                        className="min-w-0 flex-1 bg-transparent py-0.5 text-[13px] font-medium text-[#0d0d0d] outline-none"
                        autoFocus
                        maxLength={120}
                      />
                    </div>
                  );
                }

                return (
                  <div
                    key={session.sessionId}
                    className={`group relative flex items-center gap-2 rounded-lg border px-2.5 py-1.5 transition-all ${
                      selected
                        ? "border-[#2463eb]/10 bg-white text-[#0b57d0] shadow-[0_2px_8px_rgba(36,99,235,0.06),0_1px_2px_rgba(36,99,235,0.02)]"
                        : "border-transparent text-[#374151] hover:bg-white/80 hover:text-[#0d0d0d] hover:shadow-[0_2px_6px_rgba(0,0,0,0.02)]"
                    }`}
                  >
                    <SessionAttentionDot attention={session.attention} reserveSpace />
                    <button
                      type="button"
                      onClick={() => onSelectSession(session.sessionId)}
                      className="grid min-w-0 flex-1 grid-cols-[minmax(0,1fr)_auto] items-center gap-2 py-0.5 text-left text-[13px] font-medium"
                    >
                      <span className="inline-flex min-w-0 items-center gap-1.5">
                        {session.pinned ? (
                          <Pin size={11} className="shrink-0 text-[#8b8f94]" />
                        ) : null}
                        <span className="truncate">{session.title}</span>
                      </span>
                      {activityTime && (
                        <span
                          className={`font-[family-name:var(--font-mono)] text-[11px] font-normal ${
                            selected ? "text-[#4d6fb8]" : "text-[#8b8f94]"
                          }`}
                        >
                          {activityTime}
                        </span>
                      )}
                    </button>

                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        setActiveMenuSessionId(
                          activeMenuSessionId === session.sessionId ? null : session.sessionId
                        );
                      }}
                      className={`h-6 w-6 shrink-0 items-center justify-center rounded border transition-colors ${
                        activeMenuSessionId === session.sessionId
                          ? "z-50 flex border-[#e5e7eb] bg-white text-[#0d0d0d]"
                          : "hidden border-transparent text-[#8b8f94] group-hover:flex hover:border-[#e5e7eb] hover:bg-white hover:text-[#0d0d0d]"
                      }`}
                      title="Session options"
                    >
                      <MoreHorizontal size={13} />
                    </button>

                    {activeMenuSessionId === session.sessionId && (
                      <div className="absolute top-9 right-2 z-50 w-36 rounded-lg border border-[#e5e7eb]/80 bg-white/95 py-1 shadow-[0_10px_30px_-6px_rgba(0,0,0,0.06),0_4px_12px_-2px_rgba(0,0,0,0.03)] ring-1 ring-black/5 backdrop-blur-md">
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            void onUpdateSession(session.sessionId, { pinned: !session.pinned });
                            setActiveMenuSessionId(null);
                          }}
                          className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs font-medium text-[#374151] hover:bg-[#f3f4f6] hover:text-[#0d0d0d]"
                        >
                          <Pin size={12} className="shrink-0 text-[#6b7280]" />
                          {session.pinned ? "Unpin" : "Pin"}
                        </button>
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            setEditingSessionId(session.sessionId);
                            setEditingTitle(session.title);
                            setActiveMenuSessionId(null);
                          }}
                          className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs font-medium text-[#374151] hover:bg-[#f3f4f6] hover:text-[#0d0d0d]"
                        >
                          <Edit3 size={12} className="shrink-0 text-[#6b7280]" />
                          Rename
                        </button>
                        <div className="my-1 border-t border-[#e5e7eb]" />
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            onDeleteSession(session.sessionId, e);
                            setActiveMenuSessionId(null);
                          }}
                          className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs font-medium text-[#cf222e] hover:bg-[#ffebe9]"
                        >
                          <Trash2 size={12} className="shrink-0 text-[#cf222e]" />
                          Delete
                        </button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      <div className="relative border-t border-[#e5e7eb] px-4 py-3">
        {isUserMenuOpen && (
          <div
            className="absolute bottom-14 left-3 z-50 w-64 rounded-xl border border-[#e5e7eb]/80 bg-white/95 p-3.5 shadow-[0_12px_36px_-6px_rgba(0,0,0,0.1),0_4px_16px_rgba(0,0,0,0.04)] backdrop-blur-md"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-3 flex items-center gap-2 border-b border-[#e5e7eb]/60 pb-2">
              <span className="relative flex h-1.5 w-1.5">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75"></span>
                <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-emerald-500"></span>
              </span>
              <span className="text-xs font-semibold text-[#374151]">Sandbox Status</span>
            </div>

            {isLoadingUsage ? (
              <div className="flex h-20 items-center justify-center">
                <Loader2 className="h-5 w-5 animate-spin text-[#6b7280]" />
              </div>
            ) : (
              <div className="space-y-3">
                <div>
                  <div className="mb-1 flex items-center justify-between text-[11px] font-medium text-[#6b7280]">
                    <span className="flex items-center gap-1">
                      <HardDrive size={11} />
                      Disk Usage
                    </span>
                    <span>
                      {(() => {
                        const bytes = userUsageData?.usage?.workspace_size_bytes ?? 0;
                        const mb = bytes / (1024 * 1024);
                        const percent = Math.min(100, Math.max(0, (mb / 2048) * 100));
                        return `${percent.toFixed(1)}%`;
                      })()}
                    </span>
                  </div>
                  {(() => {
                    const bytes = userUsageData?.usage?.workspace_size_bytes ?? 0;
                    const mb = bytes / (1024 * 1024);
                    const percent = Math.min(100, Math.max(0, (mb / 2048) * 100));
                    return (
                      <>
                        <div className="h-1 w-full overflow-hidden rounded-full bg-[#e5e7eb]">
                          <div
                            className="h-full bg-[#2463eb] transition-all duration-300"
                            style={{ width: `${percent}%` }}
                          />
                        </div>
                        <div className="mt-1 text-[10px] text-[#8b8f94]">
                          {formatBytes(bytes)} of 2 GB
                        </div>
                      </>
                    );
                  })()}
                </div>

                <div>
                  <div className="mb-1 flex items-center justify-between text-[11px] font-medium text-[#6b7280]">
                    <span className="flex items-center gap-1">
                      <Layers size={11} />
                      Active Sessions
                    </span>
                    <span>
                      {(() => {
                        const count = userUsageData?.usage?.session_count ?? 0;
                        const percent = Math.min(100, Math.max(0, (count / 200) * 100));
                        return `${percent.toFixed(1)}%`;
                      })()}
                    </span>
                  </div>
                  {(() => {
                    const count = userUsageData?.usage?.session_count ?? 0;
                    const percent = Math.min(100, Math.max(0, (count / 200) * 100));
                    return (
                      <>
                        <div className="h-1 w-full overflow-hidden rounded-full bg-[#e5e7eb]">
                          <div
                            className="h-full bg-[#2463eb] transition-all duration-300"
                            style={{ width: `${percent}%` }}
                          />
                        </div>
                        <div className="mt-1 text-[10px] text-[#8b8f94]">
                          {count} of 200 sessions
                        </div>
                      </>
                    );
                  })()}
                </div>
              </div>
            )}

            <div className="mt-2 flex items-center gap-1.5 rounded-lg border border-slate-100 bg-slate-50 p-2 text-xs text-slate-500">
              <Cpu size={12} className="shrink-0 text-[#6b7280]" />
              <span>Token usage (placeholder): ~k tokens</span>
            </div>

            <div className="mt-2 border-t border-[#e5e7eb] pt-2">
              <button
                type="button"
                onClick={() => {
                  setIsSwitchingUser(true);
                  setNewUserDraft(userId);
                  setIsUserMenuOpen(false);
                }}
                className="flex w-full items-center justify-center gap-1 rounded bg-[#f3f4f6] px-2 py-1 text-xs font-semibold text-[#374151] transition-colors hover:bg-[#e5e7eb]"
              >
                Switch User
              </button>
            </div>
          </div>
        )}

        {isSwitchingUser ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              handleSave();
            }}
            className="flex w-full items-center gap-2 rounded-lg border border-[#2463eb] bg-white px-2 py-1.5 shadow-[0_2px_8px_rgba(36,99,235,0.06)]"
          >
            <input
              type="text"
              value={newUserDraft}
              onChange={(e) => setNewUserDraft(e.target.value)}
              onBlur={handleSave}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  isSwitchCancelRef.current = true;
                  setIsSwitchingUser(false);
                }
              }}
              className="min-w-0 flex-1 bg-transparent px-1 py-0.5 text-sm font-medium text-[#0d0d0d] outline-none"
              autoFocus
              maxLength={64}
              placeholder="User ID"
            />
            <div className="flex shrink-0 items-center gap-1">
              <button
                type="submit"
                title="Save User ID"
                className="inline-flex h-6 w-6 items-center justify-center rounded text-[#2463eb] hover:bg-[#2463eb]/10"
              >
                <Check size={14} />
              </button>
              <button
                type="button"
                title="Cancel"
                onMouseDown={() => {
                  isSwitchCancelRef.current = true;
                }}
                onClick={() => {
                  setIsSwitchingUser(false);
                }}
                className="inline-flex h-6 w-6 items-center justify-center rounded text-[#6b7280] hover:bg-[#e5e7eb]"
              >
                <X size={14} />
              </button>
            </div>
          </form>
        ) : (
          <button
            type="button"
            onClick={() => setIsUserMenuOpen(true)}
            className="flex w-full items-center gap-3 rounded-lg px-1 py-1.5 text-left hover:bg-white"
          >
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[#2463eb] text-xs font-semibold text-white">
              {userId.slice(0, 2).toUpperCase()}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium text-[#0d0d0d]">{userId}</span>
              <span className="block truncate text-xs text-[#6b7280]">Workspace user</span>
            </span>
          </button>
        )}
      </div>
    </div>
  );
}
