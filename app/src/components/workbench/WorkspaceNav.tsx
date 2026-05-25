"use client";

import React from "react";
import { AlertTriangle, Loader2, Plus, Settings, Trash2 } from "lucide-react";
import RippleIcon from "@/components/icons/RippleIcon";
import { formatSessionActivityTime } from "@/lib/workbench";
import { mainNavItems, type WorkspaceView } from "@/lib/workspaceViews";
import type { WorkbenchSessionSummary } from "@/types";
import SessionAttentionDot from "./SessionAttentionDot";

interface WorkspaceNavProps {
  sessions: WorkbenchSessionSummary[];
  selectedSessionId: string | null;
  activeView: WorkspaceView;
  isLoading: boolean;
  sessionLoadError?: string | null;
  isGenerating: boolean;
  userId: string;
  onNewSession: () => void;
  onSelectView: (view: WorkspaceView) => void;
  onSelectSession: (sessionId: string) => void;
  onDeleteSession: (sessionId: string, event: React.MouseEvent) => void;
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
  onNewSession,
  onSelectView,
  onSelectSession,
  onDeleteSession,
  onOpenSettings,
}: WorkspaceNavProps) {
  return (
    <div className="flex h-full min-h-0 flex-col text-[#0d0d0d]" aria-busy={isGenerating}>
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
            className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-transparent text-[#6b7280] hover:border-[#e5e7eb] hover:bg-white hover:text-[#0d0d0d]"
          >
            <Settings size={15} />
          </button>
        </div>

        <button
          type="button"
          onClick={onNewSession}
          className="flex h-9 w-full items-center justify-between gap-2 rounded-lg bg-[#2463eb] px-3 text-sm font-semibold text-white shadow-[0_8px_24px_rgba(36,99,235,0.18)] hover:bg-[#1d56d8]"
        >
          <span className="inline-flex items-center gap-2">
            <Plus size={15} />
            New Session
          </span>
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
                className={`flex h-9 w-full items-center gap-3 rounded-lg px-3 text-left text-sm font-medium transition-colors ${
                  selected
                    ? "bg-[#eef4ff] text-[#0b57d0]"
                    : "text-[#374151] hover:bg-white hover:text-[#0d0d0d]"
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
                return (
                  <div
                    key={session.sessionId}
                    className={`group flex items-center gap-2 rounded-lg px-2.5 py-1.5 transition-colors ${
                      selected
                        ? "bg-[#eef4ff] text-[#0b57d0]"
                        : "text-[#374151] hover:bg-white hover:text-[#0d0d0d]"
                    }`}
                  >
                    <SessionAttentionDot attention={session.attention} reserveSpace />
                    <button
                      type="button"
                      onClick={() => onSelectSession(session.sessionId)}
                      className="grid min-w-0 flex-1 grid-cols-[minmax(0,1fr)_auto] items-center gap-2 py-0.5 text-left text-sm font-medium"
                    >
                      <span className="truncate">{session.title}</span>
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
                      onClick={(event) => onDeleteSession(session.sessionId, event)}
                      className="hidden h-6 w-6 shrink-0 items-center justify-center rounded border border-transparent text-[#8b8f94] group-hover:flex hover:border-[#e5e7eb] hover:bg-white hover:text-[#cf222e]"
                      title="Delete session"
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      <div className="border-t border-[#e5e7eb] px-4 py-3">
        <button
          type="button"
          onClick={onOpenSettings}
          className="flex w-full items-center gap-3 rounded-lg px-1 py-1.5 text-left hover:bg-white"
        >
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[#2463eb] text-xs font-semibold text-white">
            {userId.slice(0, 2).toUpperCase()}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium text-[#0d0d0d]">{userId}</span>
            <span className="block truncate text-xs text-[#6b7280]">workspace user</span>
          </span>
        </button>
      </div>
    </div>
  );
}
