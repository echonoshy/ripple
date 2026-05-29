"use client";

import React, { useMemo, useState } from "react";
import {
  AlertTriangle,
  Loader2,
  MessageCircle,
  Pin,
  Plus,
  Search,
  MoreHorizontal,
  Edit3,
  Trash2,
} from "lucide-react";
import { formatSessionActivityTime } from "@/lib/workbench";
import type { WorkbenchSessionSummary } from "@/types";
import SessionAttentionDot from "./SessionAttentionDot";
import RippleIcon from "@/components/icons/RippleIcon";

interface MobileSessionsPageProps {
  sessions: WorkbenchSessionSummary[];
  isLoading: boolean;
  sessionLoadError?: string | null;
  selectedSessionId: string | null;
  onNewSession: () => void;
  onSelectSession: (sessionId: string) => void;
  onDeleteSession: (sessionId: string, event: React.MouseEvent) => void;
  onUpdateSession: (
    sessionId: string,
    updates: { title?: string; pinned?: boolean }
  ) => Promise<unknown>;
}

function sessionPreview(session: WorkbenchSessionSummary): string {
  const parts = [`${session.messageCount} ${session.messageCount === 1 ? "message" : "messages"}`];
  if (session.changedFileCount > 0) {
    parts.push(`${session.changedFileCount} ${session.changedFileCount === 1 ? "file" : "files"}`);
  }
  if (session.pendingApprovalCount > 0) {
    parts.push(
      `${session.pendingApprovalCount} ${
        session.pendingApprovalCount === 1 ? "approval" : "approvals"
      }`
    );
  }
  return parts.join(" · ");
}

export default function MobileSessionsPage({
  sessions,
  isLoading,
  sessionLoadError,
  selectedSessionId,
  onNewSession,
  onSelectSession,
  onDeleteSession,
  onUpdateSession,
}: MobileSessionsPageProps) {
  const [isSearching, setIsSearching] = useState(false);
  const [query, setQuery] = useState("");

  const [activeMenuSessionId, setActiveMenuSessionId] = useState<string | null>(null);
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState<string>("");
  const isCancellingRef = React.useRef(false);

  const normalizedQuery = query.trim().toLowerCase();
  const visibleSessions = useMemo(
    () =>
      normalizedQuery
        ? sessions.filter((session) => session.title.toLowerCase().includes(normalizedQuery))
        : sessions,
    [normalizedQuery, sessions]
  );

  return (
    <div className="flex h-full min-h-0 flex-col bg-[#fbfcfe] text-[#111827] lg:hidden">
      {activeMenuSessionId && (
        <div
          className="fixed inset-0 z-40 bg-transparent"
          onClick={() => {
            setActiveMenuSessionId(null);
          }}
        />
      )}
      <header className="shrink-0 border-b border-[#e5e7eb] bg-white px-4 pt-[max(env(safe-area-inset-top),10px)] pb-2">
        <div className="flex h-10 items-center justify-between">
          <div className="flex items-center gap-2">
            <RippleIcon size={24} className="h-6 w-6" />
            <span className="text-[18px] font-semibold tracking-normal text-[#111827]">Ripple</span>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              aria-label="Search sessions"
              title="Search sessions"
              onClick={() => setIsSearching((open) => !open)}
              className={`inline-flex h-9 w-9 items-center justify-center rounded-lg border transition-colors active:bg-[#eef4ff] ${
                isSearching
                  ? "border-[#d7e3f8] bg-[#eef4ff] text-[#2463eb]"
                  : "border-[#e5e7eb] bg-[#f7f8fa] text-[#5f6b7a] hover:bg-[#eef1f5]"
              }`}
            >
              <Search size={18} strokeWidth={2.2} />
            </button>
            <button
              type="button"
              aria-label="New session"
              title="New session"
              onClick={onNewSession}
              className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-[#2463eb] bg-[#2463eb] text-white transition-colors hover:bg-[#1d56d8] active:bg-[#174ea6]"
            >
              <Plus size={18} strokeWidth={2.2} />
            </button>
          </div>
        </div>
        {isSearching ? (
          <div className="mt-2 flex h-9 items-center gap-2 rounded-lg border border-[#dfe6f4] bg-white px-3">
            <Search size={15} className="shrink-0 text-[#7a8496]" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search sessions"
              className="search-sessions-input min-w-0 flex-1 bg-transparent text-[16px] outline-none placeholder:text-[#9aa3af] focus:ring-0 focus:outline-none focus-visible:ring-0 focus-visible:outline-none"
              autoFocus
            />
          </div>
        ) : null}
      </header>

      <main className="min-h-0 flex-1 overflow-y-auto px-3 pt-2 pb-[calc(88px+env(safe-area-inset-bottom))]">
        {sessionLoadError && !isLoading ? (
          <div className="mt-2 flex items-start gap-2 rounded-xl border border-[#cf222e]/25 bg-[#ffebe9] p-3 text-sm font-medium text-[#cf222e]">
            <AlertTriangle size={16} className="mt-0.5 shrink-0" />
            <span className="min-w-0 break-words">{sessionLoadError}</span>
          </div>
        ) : null}

        {isLoading ? (
          <div className="flex h-40 items-center justify-center text-[#6b7280]">
            <Loader2 size={20} className="animate-spin" />
          </div>
        ) : visibleSessions.length === 0 ? (
          <div className="flex h-72 flex-col items-center justify-center px-8 text-center">
            <span className="mb-4 flex h-[60px] w-[60px] items-center justify-center rounded-lg border border-[#d7e3f8] bg-[#eef4ff] text-[#2463eb]">
              <MessageCircle size={28} />
            </span>
            <div className="text-[17px] font-semibold">
              {normalizedQuery ? "No matching sessions" : "No sessions yet"}
            </div>
            <p className="mt-2 text-[13px] leading-5 text-[#687386]">
              {normalizedQuery
                ? "Try another keyword."
                : "Start a conversation and Ripple will keep the context here."}
            </p>
            {!normalizedQuery ? (
              <button
                type="button"
                onClick={onNewSession}
                className="mt-5 inline-flex h-9 items-center gap-2 rounded-lg bg-[#2463eb] px-4 text-[13px] font-semibold text-white hover:bg-[#1d56d8]"
              >
                <Plus size={16} />
                New session
              </button>
            ) : null}
          </div>
        ) : (
          <div className="space-y-1.5">
            {visibleSessions.map((session) => {
              const selected = session.sessionId === selectedSessionId;
              const activityTime = formatSessionActivityTime(session.lastActivityAt);
              const isEditing = editingSessionId === session.sessionId;
              const isMenuActive = activeMenuSessionId === session.sessionId;

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
                    className="flex w-full items-center gap-2 rounded-lg border border-[#2463eb] bg-white px-3 py-2.5 text-[#0d0d0d]"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-[#dfe6f4] bg-[#f6f8ff] text-[#667085]">
                      <MessageCircle size={16} strokeWidth={2.1} />
                    </span>
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
                      className="min-w-0 flex-1 bg-transparent py-0.5 text-[14px] font-medium text-[#0d0d0d] outline-none"
                      autoFocus
                      maxLength={120}
                    />
                  </div>
                );
              }

              return (
                <div
                  key={session.sessionId}
                  className={`relative flex w-full items-center gap-2.5 rounded-lg border px-3 py-2.5 text-left transition-colors ${
                    selected
                      ? "border-[#d7e3f8] bg-[#eef4ff]"
                      : "border-[#e5e7eb] bg-white active:bg-[#f7f8fa]"
                  } ${isMenuActive ? "z-50" : "z-10"}`}
                >
                  {selected ? (
                    <span
                      aria-hidden="true"
                      className="absolute top-2 bottom-2 left-0 w-[3px] rounded-r-full bg-[#2463eb]"
                    />
                  ) : null}
                  <button
                    type="button"
                    onClick={() => onSelectSession(session.sessionId)}
                    className="flex min-w-0 flex-1 items-center gap-2.5 py-0.5 text-left outline-none"
                  >
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-[#dfe6f4] bg-[#f6f8ff] text-[#667085]">
                      <MessageCircle size={16} strokeWidth={2.1} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex min-w-0 items-center gap-2">
                        <span className="truncate text-[14px] leading-5 font-medium text-[#111827]">
                          {session.title}
                        </span>
                        {session.pinned ? (
                          <Pin size={12} className="shrink-0 text-[#6b7280]" />
                        ) : null}
                        <SessionAttentionDot attention={session.attention} reserveSpace />
                      </span>
                      <span className="mt-0.5 block truncate text-[11px] leading-4 text-[#667085]">
                        {sessionPreview(session)}
                      </span>
                    </span>
                    {activityTime ? (
                      <span className="shrink-0 self-start pt-0.5 font-[family-name:var(--font-mono)] text-[9px] text-[#8b95a5]">
                        {activityTime}
                      </span>
                    ) : null}
                  </button>

                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      setActiveMenuSessionId(
                        activeMenuSessionId === session.sessionId ? null : session.sessionId
                      );
                    }}
                    className={`inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-transparent text-[#6b7280] active:bg-[#eef4ff] ${
                      activeMenuSessionId === session.sessionId ? "bg-[#eef4ff] text-[#0d0d0d]" : ""
                    }`}
                    title="Session options"
                  >
                    <MoreHorizontal size={18} strokeWidth={2.4} />
                  </button>

                  {activeMenuSessionId === session.sessionId && (
                    <div className="animate-in fade-in-50 zoom-in-95 absolute top-12 right-3 z-50 w-36 rounded-lg border border-[#dfe6f4] bg-white p-1.5 shadow-[0_12px_30px_rgba(0,0,0,0.10)] duration-100">
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          void onUpdateSession(session.sessionId, { pinned: !session.pinned });
                          setActiveMenuSessionId(null);
                        }}
                        className="flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-left text-xs font-semibold text-[#374151] transition-colors hover:bg-[#f3f4f6] active:bg-[#eef4ff]"
                      >
                        <Pin size={13} className="shrink-0 text-[#6b7280]" />
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
                        className="flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-left text-xs font-semibold text-[#374151] transition-colors hover:bg-[#f3f4f6] active:bg-[#eef4ff]"
                      >
                        <Edit3 size={13} className="shrink-0 text-[#6b7280]" />
                        Rename
                      </button>
                      <div className="my-1 border-t border-[#dfe6f4]" />
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          onDeleteSession(session.sessionId, e);
                          setActiveMenuSessionId(null);
                        }}
                        className="flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-left text-xs font-semibold text-[#cf222e] transition-colors hover:bg-[#ffebe9] active:bg-[#ffd5d6]"
                      >
                        <Trash2 size={13} className="shrink-0 text-[#cf222e]" />
                        Delete
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </main>
    </div>
  );
}
