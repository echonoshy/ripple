"use client";

import React, { useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  AlertTriangle,
  Loader2,
  MessageCircle,
  MessageCircleMore,
  MessageSquarePlus,
  Pin,
  Search,
  Edit3,
  Trash2,
} from "lucide-react";
import { IconTile } from "@/components/icons/IconTile";
import { formatSessionActivityTime } from "@/lib/workbench";
import {
  getMeasuredViewportMenuPosition,
  getResponsiveMenuBottomInsetPx,
  VIEWPORT_MENU_MARGIN_PX,
  type ViewportMenuAnchorRect,
} from "@/lib/menuPosition";
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

const MOBILE_SESSION_MENU_WIDTH = 144;
const MOBILE_SESSION_MENU_HEIGHT = 132;
const mobileHeaderActionClass =
  "inline-flex h-9 w-9 items-center justify-center rounded-lg border border-white/70 bg-white/68 text-[#516070] shadow-[0_6px_18px_rgba(44,63,123,0.08)] backdrop-blur-xl transition-all hover:bg-white/86 active:scale-[0.98] active:bg-white/78";

interface ActiveSessionMenu {
  sessionId: string;
  top: number;
  left: number;
  anchorRect: ViewportMenuAnchorRect;
  measuredHeight: number | null;
}

export function getMobileSessionMenuPosition(
  anchorRect: ViewportMenuAnchorRect,
  measuredMenuHeight?: number | null
): {
  top: number;
  left: number;
} {
  const position = getMeasuredViewportMenuPosition({
    anchorRect,
    menuWidth: MOBILE_SESSION_MENU_WIDTH,
    estimatedMenuHeight: MOBILE_SESSION_MENU_HEIGHT,
    measuredMenuHeight,
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight,
    bottomInset: getResponsiveMenuBottomInsetPx(),
    margin: VIEWPORT_MENU_MARGIN_PX,
    align: "right",
  });

  return { top: position.top, left: position.left };
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

  const [activeMenu, setActiveMenu] = useState<ActiveSessionMenu | null>(null);
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState<string>("");
  const isCancellingRef = React.useRef(false);
  const activeMenuRef = useRef<HTMLDivElement | null>(null);
  const activeMenuSessionId = activeMenu?.sessionId ?? null;

  const normalizedQuery = query.trim().toLowerCase();
  const visibleSessions = useMemo(
    () =>
      normalizedQuery
        ? sessions.filter((session) => session.title.toLowerCase().includes(normalizedQuery))
        : sessions,
    [normalizedQuery, sessions]
  );
  const activeMenuSession = useMemo(() => {
    if (!activeMenuSessionId) return null;
    return visibleSessions.find((session) => session.sessionId === activeMenuSessionId) ?? null;
  }, [activeMenuSessionId, visibleSessions]);

  useLayoutEffect(() => {
    if (!activeMenu) return;
    const menuNode = activeMenuRef.current;
    if (!menuNode) return;

    const measuredMenuHeight = Math.ceil(menuNode.getBoundingClientRect().height);
    if (!measuredMenuHeight || measuredMenuHeight === activeMenu.measuredHeight) return;

    const position = getMobileSessionMenuPosition(activeMenu.anchorRect, measuredMenuHeight);
    setActiveMenu((current) => {
      if (!current || current.sessionId !== activeMenu.sessionId) return current;
      if (
        current.measuredHeight === measuredMenuHeight &&
        current.top === position.top &&
        current.left === position.left
      ) {
        return current;
      }
      return {
        ...current,
        ...position,
        measuredHeight: measuredMenuHeight,
      };
    });
  }, [activeMenu]);

  return (
    <div className="flex h-full min-h-0 flex-col bg-[#f7f9fc] text-[#111827] lg:hidden">
      {activeMenu && activeMenuSession && typeof document !== "undefined"
        ? createPortal(
            <>
              <div
                className="fixed inset-0 z-40 bg-transparent"
                onClick={() => {
                  setActiveMenu(null);
                }}
              />
              <div
                ref={activeMenuRef}
                style={{ top: activeMenu.top, left: activeMenu.left, position: "fixed" }}
                className="animate-in fade-in-50 zoom-in-95 z-50 max-h-[calc(100dvh-104px)] w-36 overflow-y-auto rounded-lg border border-white/72 bg-white/84 p-1.5 shadow-[0_14px_34px_rgba(44,63,123,0.14)] backdrop-blur-2xl duration-100"
                onClick={(e) => e.stopPropagation()}
              >
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    void onUpdateSession(activeMenuSession.sessionId, {
                      pinned: !activeMenuSession.pinned,
                    });
                    setActiveMenu(null);
                  }}
                  className="flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-left text-xs font-semibold text-[#374151] transition-colors hover:bg-[#f3f4f6] active:bg-[#eef4ff]"
                >
                  <Pin size={13} className="shrink-0 text-[#6b7280]" />
                  {activeMenuSession.pinned ? "Unpin" : "Pin"}
                </button>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    setEditingSessionId(activeMenuSession.sessionId);
                    setEditingTitle(activeMenuSession.title);
                    setActiveMenu(null);
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
                    onDeleteSession(activeMenuSession.sessionId, e);
                    setActiveMenu(null);
                  }}
                  className="flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-left text-xs font-semibold text-[#cf222e] transition-colors hover:bg-[#ffebe9] active:bg-[#ffd5d6]"
                >
                  <Trash2 size={13} className="shrink-0 text-[#cf222e]" />
                  Delete
                </button>
              </div>
            </>,
            document.body
          )
        : null}
      <header className="shrink-0 border-b border-white/70 bg-white/72 px-4 pt-[max(env(safe-area-inset-top),10px)] pb-2 shadow-[0_8px_24px_rgba(44,63,123,0.06)] backdrop-blur-2xl">
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
              className={`inline-flex h-9 w-9 items-center justify-center rounded-lg border shadow-[0_6px_18px_rgba(44,63,123,0.08)] backdrop-blur-xl transition-all active:scale-[0.98] ${
                isSearching
                  ? "border-[#b8cdf8]/80 bg-[#eef4ff]/78 text-[#2463eb] shadow-[0_8px_22px_rgba(36,99,235,0.12)]"
                  : "border-white/70 bg-white/68 text-[#516070] hover:bg-white/86 active:bg-white/78"
              }`}
            >
              <Search size={18} strokeWidth={2.2} />
            </button>
            <button
              type="button"
              aria-label="New session"
              title="New session"
              onClick={onNewSession}
              className={mobileHeaderActionClass}
            >
              <MessageCircleMore size={18} strokeWidth={2.2} />
            </button>
          </div>
        </div>
        {isSearching ? (
          <div className="mt-2 flex h-9 items-center gap-2 rounded-lg border border-white/70 bg-white/70 px-3 shadow-[0_8px_24px_rgba(44,63,123,0.06)] backdrop-blur-xl">
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

      <main className="min-h-0 flex-1 overflow-y-auto px-3 pt-2.5 pb-[calc(88px+env(safe-area-inset-bottom))]">
        {sessionLoadError && !isLoading ? (
          <div className="mt-2 flex items-start gap-2 rounded-xl border border-[#cf222e]/25 bg-[#ffebe9] p-3 text-sm font-medium text-[#cf222e]">
            <IconTile tone="danger" size="sm" className="mt-0.5">
              <AlertTriangle size={14} />
            </IconTile>
            <span className="min-w-0 break-words">{sessionLoadError}</span>
          </div>
        ) : null}

        {isLoading ? (
          <div className="flex h-40 items-center justify-center text-[#6b7280]">
            <Loader2 size={20} className="animate-spin" />
          </div>
        ) : visibleSessions.length === 0 ? (
          <div className="flex h-72 flex-col items-center justify-center px-8 text-center">
            <IconTile
              tone="accent"
              size="xl"
              className="mb-4 h-[60px] w-[60px] rounded-2xl shadow-[0_8px_24px_rgba(44,63,123,0.06)]"
            >
              <MessageCircle size={28} />
            </IconTile>
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
                className="mt-5 inline-flex h-9 items-center gap-2 rounded-lg border border-[#b8cdf8]/80 bg-[#eef4ff]/78 px-4 text-[13px] font-semibold text-[#2463eb] shadow-[0_8px_22px_rgba(36,99,235,0.12)] backdrop-blur-xl hover:bg-[#e8f0ff]/86"
              >
                <MessageSquarePlus size={16} strokeWidth={2.1} />
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
                    className="flex w-full items-center rounded-lg border border-[#b8cdf8]/80 bg-white/76 px-3 py-2.5 text-[#0d0d0d] shadow-[0_8px_24px_rgba(44,63,123,0.06)] backdrop-blur-xl"
                    onClick={(e) => e.stopPropagation()}
                  >
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
                  className={`relative flex w-full items-center gap-2 rounded-lg border bg-white/70 px-3 py-2.5 text-left shadow-[0_8px_24px_rgba(44,63,123,0.06)] backdrop-blur-xl transition-all ${
                    selected
                      ? "border-[#b8cdf8]/80 bg-[#f1f6ff]/82"
                      : "border-white/72 active:bg-white/82"
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
                    className="flex min-w-0 flex-1 items-center gap-2 py-0.5 pr-1 text-left outline-none"
                  >
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
                      const anchorRect = e.currentTarget.getBoundingClientRect();
                      setActiveMenu((current) => {
                        if (current?.sessionId === session.sessionId) return null;
                        const position = getMobileSessionMenuPosition(anchorRect);
                        return {
                          sessionId: session.sessionId,
                          ...position,
                          anchorRect,
                          measuredHeight: null,
                        };
                      });
                    }}
                    className={`inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-white/50 bg-white/32 text-[#6b7280] shadow-[0_4px_12px_rgba(44,63,123,0.05)] backdrop-blur-xl active:bg-[#eef4ff]/78 ${
                      activeMenuSessionId === session.sessionId
                        ? "bg-[#eef4ff]/78 text-[#0d0d0d]"
                        : ""
                    }`}
                    title="Session options"
                  >
                    <MessageCircleMore size={18} strokeWidth={2.2} />
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </main>
    </div>
  );
}
