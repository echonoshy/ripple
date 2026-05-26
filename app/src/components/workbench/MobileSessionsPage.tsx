"use client";

import React, { useMemo, useState } from "react";
import { AlertTriangle, Loader2, MessageCircle, Pin, Plus, Search, SquarePen } from "lucide-react";
import { formatSessionActivityTime } from "@/lib/workbench";
import type { WorkbenchSessionSummary } from "@/types";
import SessionAttentionDot from "./SessionAttentionDot";

interface MobileSessionsPageProps {
  sessions: WorkbenchSessionSummary[];
  isLoading: boolean;
  sessionLoadError?: string | null;
  selectedSessionId: string | null;
  onNewSession: () => void;
  onSelectSession: (sessionId: string) => void;
}

const avatarPalette = [
  "bg-[linear-gradient(135deg,#2f6bff,#8a5cff)] text-white shadow-[0_8px_18px_rgba(64,92,255,0.24)]",
  "bg-[linear-gradient(135deg,#11a66a,#5fd68a)] text-white shadow-[0_8px_18px_rgba(37,160,105,0.18)]",
  "bg-[linear-gradient(135deg,#f3aa22,#f7d56b)] text-white shadow-[0_8px_18px_rgba(205,137,20,0.18)]",
  "bg-[linear-gradient(135deg,#7b5cff,#c78cff)] text-white shadow-[0_8px_18px_rgba(123,92,255,0.20)]",
  "bg-[linear-gradient(135deg,#21a8ff,#7bdcff)] text-white shadow-[0_8px_18px_rgba(33,168,255,0.18)]",
];

function sessionInitial(title: string): string {
  const trimmed = title.trim();
  return trimmed ? trimmed.slice(0, 1).toUpperCase() : "R";
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
  parts.push(session.status || "idle");
  return parts.join(" · ");
}

export default function MobileSessionsPage({
  sessions,
  isLoading,
  sessionLoadError,
  selectedSessionId,
  onNewSession,
  onSelectSession,
}: MobileSessionsPageProps) {
  const [isSearching, setIsSearching] = useState(false);
  const [query, setQuery] = useState("");
  const normalizedQuery = query.trim().toLowerCase();
  const visibleSessions = useMemo(
    () =>
      normalizedQuery
        ? sessions.filter((session) => session.title.toLowerCase().includes(normalizedQuery))
        : sessions,
    [normalizedQuery, sessions]
  );

  return (
    <div className="flex h-full min-h-0 flex-col bg-[radial-gradient(circle_at_16%_0%,rgba(47,107,255,0.13),transparent_34%),radial-gradient(circle_at_88%_8%,rgba(139,92,246,0.12),transparent_32%),#fbfdff] text-[#111827] lg:hidden">
      <header className="shrink-0 border-b border-[#e8edf7] bg-white/72 px-4 pt-[max(env(safe-area-inset-top),10px)] pb-2 backdrop-blur-2xl">
        <div className="flex h-10 items-center justify-between">
          <button
            type="button"
            aria-label="Search sessions"
            title="Search sessions"
            onClick={() => setIsSearching((open) => !open)}
            className="inline-flex h-9 w-9 items-center justify-center rounded-full text-[#172033] active:bg-[#eef3ff]"
          >
            <Search size={21} strokeWidth={2.45} />
          </button>
          <h1 className="text-[18px] leading-none font-semibold tracking-normal">Sessions</h1>
          <button
            type="button"
            aria-label="New session"
            title="New session"
            onClick={onNewSession}
            className="inline-flex h-9 w-9 items-center justify-center rounded-full text-[#172033] active:bg-[#eef3ff]"
          >
            <SquarePen size={21} strokeWidth={2.45} />
          </button>
        </div>
        {isSearching ? (
          <div className="mt-2 flex h-9 items-center gap-2 rounded-full border border-[#dfe6f4] bg-white/86 px-3 shadow-[0_8px_22px_rgba(44,63,123,0.06)]">
            <Search size={15} className="shrink-0 text-[#7a8496]" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search sessions"
              className="min-w-0 flex-1 bg-transparent text-[16px] outline-none placeholder:text-[#9aa3af]"
              autoFocus
            />
          </div>
        ) : null}
      </header>

      <main className="min-h-0 flex-1 overflow-y-auto px-2.5 pt-1.5 pb-[calc(88px+env(safe-area-inset-bottom))]">
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
            <span className="mb-4 flex h-[60px] w-[60px] items-center justify-center rounded-full bg-[linear-gradient(135deg,#eaf1ff,#f5edff)] text-[#2f6bff] shadow-[0_12px_28px_rgba(64,92,255,0.16)]">
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
                className="mt-5 inline-flex h-9 items-center gap-2 rounded-full bg-[linear-gradient(135deg,#2f6bff,#7b5cff)] px-4 text-[13px] font-semibold text-white shadow-[0_12px_26px_rgba(64,92,255,0.24)]"
              >
                <Plus size={16} />
                New session
              </button>
            ) : null}
          </div>
        ) : (
          <div className="space-y-1">
            {visibleSessions.map((session, index) => {
              const selected = session.sessionId === selectedSessionId;
              const activityTime = formatSessionActivityTime(session.lastActivityAt);
              return (
                <button
                  key={session.sessionId}
                  type="button"
                  onClick={() => onSelectSession(session.sessionId)}
                  className={`flex w-full items-center gap-2.5 rounded-[18px] border px-2.5 py-2 text-left shadow-[0_10px_28px_rgba(44,63,123,0.05)] backdrop-blur-xl active:scale-[0.992] ${
                    selected
                      ? "border-[#7d8cff] bg-white/88 ring-1 ring-[#5976ff]/30"
                      : "border-white/70 bg-white/64 active:bg-white/88"
                  }`}
                >
                  <span
                    className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-[13px] font-semibold ${
                      avatarPalette[index % avatarPalette.length]
                    }`}
                  >
                    {sessionInitial(session.title)}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex min-w-0 items-center gap-2">
                      <span className="truncate text-[14px] leading-5 font-semibold text-[#111827]">
                        {session.title}
                      </span>
                      {session.pinned ? (
                        <Pin size={12} className="shrink-0 text-[#7a8496]" />
                      ) : null}
                      <SessionAttentionDot attention={session.attention} reserveSpace />
                    </span>
                    <span className="mt-0.5 block truncate text-[11px] leading-4 text-[#7a8496]">
                      {sessionPreview(session)}
                    </span>
                  </span>
                  {activityTime ? (
                    <span className="shrink-0 self-start pt-0.5 font-[family-name:var(--font-mono)] text-[9px] text-[#98a2b3]">
                      {activityTime}
                    </span>
                  ) : null}
                </button>
              );
            })}
          </div>
        )}
      </main>
    </div>
  );
}
