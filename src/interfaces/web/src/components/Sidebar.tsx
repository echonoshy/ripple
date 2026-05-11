"use client";

import React, { useState, useRef, useCallback } from "react";
import { motion } from "framer-motion";
import { MessageSquare, Loader2, Trash2, Clock, Settings, X, UserRound } from "lucide-react";
import RippleIcon from "@/components/icons/RippleIcon";
import { Session, UsageInfo } from "@/types";

const MAX_CONTEXT_TOKENS = 200_000;

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toLocaleString();
}

function formatSessionTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";

  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startOfDate = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const dayDiff = Math.round(
    (startOfToday.getTime() - startOfDate.getTime()) / (24 * 60 * 60 * 1000)
  );
  const time = date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

  if (dayDiff === 0) return time;
  if (dayDiff === 1) return `昨天 ${time}`;
  if (date.getFullYear() === now.getFullYear()) {
    return `${date.toLocaleDateString([], { month: "2-digit", day: "2-digit" })} ${time}`;
  }
  return `${date.toLocaleDateString([], {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  })} ${time}`;
}

interface SidebarProps {
  sessions: Session[];
  currentSessionId: string | null;
  isLoadingSessions: boolean;
  isGenerating: boolean;
  tokenUsage: UsageInfo;
  lastContextTokens: number;
  isMobileOpen: boolean;
  userId: string;
  onNewChat: () => void;
  onSwitchSession: (id: string) => void;
  onDeleteSession: (id: string, e: React.MouseEvent) => void;
  onOpenSettings: () => void;
  onCloseMobile: () => void;
}

export default function Sidebar({
  sessions,
  currentSessionId,
  isLoadingSessions,
  isGenerating,
  tokenUsage,
  lastContextTokens,
  isMobileOpen,
  userId,
  onNewChat,
  onSwitchSession,
  onDeleteSession,
  onOpenSettings,
  onCloseMobile,
}: SidebarProps) {
  const isDefaultUser = userId === "default";
  const contextPercent =
    lastContextTokens > 0 ? Math.min((lastContextTokens / MAX_CONTEXT_TOKENS) * 100, 100) : 0;
  const isContextWarning = contextPercent > 75;

  const [width, setWidth] = useState(256);
  const isResizingRef = useRef(false);

  const handleResizeStart = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      isResizingRef.current = true;
      const startX = e.clientX;
      const startWidth = width;
      const onMove = (ev: MouseEvent) => {
        if (!isResizingRef.current) return;
        setWidth(Math.min(600, Math.max(200, startWidth + ev.clientX - startX)));
      };
      const onUp = () => {
        isResizingRef.current = false;
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
      };
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    },
    [width]
  );

  const sidebarContent = (
    <>
      {/* Logo */}
      <div className="border-ripple-ink bg-ripple-yellow flex items-center justify-between border-b-2 px-5 py-4">
        <a
          href="https://github.com/echonoshy/ripple"
          target="_blank"
          rel="noopener noreferrer"
          className="group flex items-center gap-3 transition-all"
          title="View on GitHub"
        >
          <div className="border-ripple-ink relative flex h-9 w-9 items-center justify-center border-2 bg-white shadow-[3px_3px_0_#111111] transition-transform group-hover:-translate-y-0.5">
            <RippleIcon
              size={28}
              className="text-ripple-ink relative z-10 transition-transform duration-500 group-hover:scale-110"
            />
          </div>
          <div className="flex items-center gap-2.5">
            <h1 className="text-ripple-ink font-[family-name:var(--font-mono)] text-[18px] font-bold">
              Ripple
            </h1>
          </div>
        </a>
        <div className="flex items-center gap-1">
          <button onClick={onCloseMobile} className="btn-icon h-8 w-8 md:!hidden">
            <X size={18} />
          </button>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto px-4 pt-4 pb-4">
        {/* Current user — prominent, clickable to open settings */}
        <button
          type="button"
          onClick={onOpenSettings}
          title="Click to change user in Settings"
          className={`group border-ripple-ink relative mb-4 flex w-full items-center gap-3 overflow-hidden border-2 p-3 text-left shadow-[3px_3px_0_#111111] transition-all duration-100 hover:-translate-y-0.5 hover:shadow-[5px_5px_0_#111111] ${
            isDefaultUser ? "bg-ripple-yellow/75" : "bg-ripple-pink/15"
          }`}
        >
          <div
            className={`border-ripple-ink text-ripple-ink relative flex h-9 w-9 shrink-0 items-center justify-center border-2 transition-transform duration-300 group-hover:scale-105 ${
              isDefaultUser ? "bg-white" : "bg-ripple-pink"
            }`}
          >
            <UserRound size={16} />
          </div>
          <div className="relative min-w-0 flex-1">
            <p className="text-ripple-ink/60 text-[10px] font-bold tracking-wider uppercase">
              {isDefaultUser ? "Default user" : "Signed in as"}
            </p>
            <p className="text-ripple-ink truncate font-[family-name:var(--font-mono)] text-sm font-bold">
              {userId}
            </p>
          </div>
          <Settings
            size={14}
            className="text-ripple-ink relative transition-all duration-300 group-hover:rotate-90"
          />
        </button>

        <motion.button
          whileHover={{ scale: 1.01 }}
          whileTap={{ scale: 0.99 }}
          className="btn-primary mb-5 flex w-full items-center justify-center gap-2 text-sm"
          onClick={onNewChat}
          disabled={isGenerating}
        >
          <MessageSquare size={14} />
          <span>New Session</span>
        </motion.button>

        {/* Session List */}
        <div className="mb-6 space-y-1">
          <h2 className="text-ripple-ink/60 mb-2 px-2 text-xs font-bold tracking-wider uppercase">
            Sessions
          </h2>
          {isLoadingSessions && sessions.length === 0 ? (
            <div className="flex justify-center p-4">
              <Loader2 size={16} className="text-ripple-ink animate-spin" />
            </div>
          ) : sessions.length === 0 ? (
            <div className="border-ripple-ink/50 text-ripple-ink/55 border-2 border-dashed bg-white px-3 py-4 text-center text-sm font-bold">
              No sessions yet
            </div>
          ) : (
            sessions.map((session, index) => (
              <motion.div
                key={session.session_id}
                initial={{ opacity: 0, x: -12 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ delay: index * 0.03, duration: 0.2 }}
              >
                <div
                  onClick={() => onSwitchSession(session.session_id)}
                  className={`group flex cursor-pointer items-center justify-between border-2 p-2.5 transition-all duration-100 ${
                    session.session_id === currentSessionId
                      ? "border-ripple-ink bg-ripple-yellow shadow-[3px_3px_0_#111111]"
                      : "hover:border-ripple-ink border-transparent hover:bg-white hover:shadow-[2px_2px_0_#111111]"
                  }`}
                >
                  <div className="flex min-w-0 items-center gap-2.5">
                    <div
                      className={`border-ripple-ink h-2 w-2 border ${
                        session.session_id === currentSessionId ? "bg-ripple-ink" : "bg-white"
                      }`}
                    />
                    <div className="min-w-0">
                      <p
                        className={`truncate text-sm ${
                          session.session_id === currentSessionId
                            ? "text-ripple-ink font-bold"
                            : "text-ripple-ink/65 font-bold"
                        }`}
                      >
                        {session.title || session.session_id.substring(0, 12) + "..."}
                      </p>
                      <p className="text-ripple-ink/50 mt-0.5 flex items-center gap-1 font-[family-name:var(--font-mono)] text-xs">
                        <Clock size={9} />
                        {formatSessionTime(session.last_active)}
                        <span className="mx-0.5">·</span>
                        {session.message_count} msgs
                      </p>
                    </div>
                  </div>
                  <button
                    onClick={(e) => onDeleteSession(session.session_id, e)}
                    className="text-ripple-ink/45 hover:border-ripple-ink hover:bg-ripple-red/30 hover:text-ripple-ink shrink-0 border-2 border-transparent p-1.5 opacity-0 transition-all group-hover:opacity-100"
                    title="Delete"
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              </motion.div>
            ))
          )}
        </div>

        {/* Token Usage */}
        {tokenUsage.total_tokens > 0 && (
          <div className="space-y-2">
            <h2 className="text-ripple-ink/60 px-2 text-xs font-bold tracking-wider uppercase">
              Stats
            </h2>
            <div className="border-ripple-ink space-y-2 border-2 bg-white p-3 shadow-[3px_3px_0_#111111]">
              {lastContextTokens > 0 && (
                <div>
                  <div className="mb-1 flex justify-between font-[family-name:var(--font-mono)] text-xs">
                    <span className="text-ripple-ink/60 font-bold">CTX</span>
                    <span
                      className={`font-bold ${isContextWarning ? "text-ripple-red" : "text-ripple-ink"}`}
                    >
                      {contextPercent.toFixed(0)}%
                    </span>
                  </div>
                  <div className="border-ripple-ink flex h-3 w-full gap-0.5 border-2 bg-white p-0.5">
                    <div
                      className={`h-full transition-all ${isContextWarning ? "bg-ripple-red" : "bg-ripple-lime"}`}
                      style={{ width: `${contextPercent}%` }}
                    />
                  </div>
                  <p className="text-ripple-ink/55 mt-1 font-[family-name:var(--font-mono)] text-xs">
                    {formatTokens(lastContextTokens)} / {formatTokens(MAX_CONTEXT_TOKENS)}
                  </p>
                </div>
              )}
              <div className="flex justify-between font-[family-name:var(--font-mono)] text-xs">
                <span className="text-ripple-ink/60 font-bold">Tokens</span>
                <span className="font-medium">
                  <span className="text-ripple-ink font-bold">
                    ↑{formatTokens(tokenUsage.prompt_tokens)}
                  </span>
                  <span className="text-ripple-ink/45 mx-1">/</span>
                  <span className="text-ripple-ink font-bold">
                    ↓{formatTokens(tokenUsage.completion_tokens)}
                  </span>
                </span>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Settings */}
      <div
        className="border-ripple-ink text-ripple-ink hover:bg-ripple-lavender mx-3 mb-3 flex cursor-pointer items-center gap-3 border-2 bg-white p-3 font-bold shadow-[3px_3px_0_#111111] transition-all hover:-translate-y-0.5 hover:shadow-[5px_5px_0_#111111]"
        onClick={onOpenSettings}
      >
        <div className="border-ripple-ink bg-ripple-sidebar flex h-8 w-8 items-center justify-center border-2">
          <Settings size={15} className="text-ripple-ink" />
        </div>
        <span className="text-sm">Settings</span>
      </div>
    </>
  );

  return (
    <>
      {/* Desktop sidebar */}
      <div className="relative hidden shrink-0 md:flex" style={{ width: width }}>
        <aside className="border-ripple-ink bg-ripple-sidebar flex h-full w-full flex-col border-r-2">
          {sidebarContent}
        </aside>
        {/* Resize handle */}
        <div
          className="group hover:bg-ripple-pink absolute top-0 right-0 bottom-0 z-30 flex w-2 translate-x-1/2 cursor-col-resize items-center justify-center bg-transparent transition-colors"
          onMouseDown={handleResizeStart}
        >
          <div className="bg-ripple-ink h-12 w-0.5 opacity-0 transition-opacity group-hover:opacity-100" />
        </div>
      </div>

      {/* Mobile overlay sidebar */}
      {isMobileOpen && (
        <>
          <div
            className="bg-ripple-ink/35 fixed inset-0 z-40 backdrop-blur-sm md:hidden"
            onClick={onCloseMobile}
          />
          <aside className="border-ripple-ink bg-ripple-sidebar fixed inset-y-0 left-0 z-50 flex w-72 flex-col border-r-2 md:hidden">
            {sidebarContent}
          </aside>
        </>
      )}
    </>
  );
}
