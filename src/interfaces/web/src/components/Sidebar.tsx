"use client";

import React, { useState, useRef, useCallback } from "react";
import { motion } from "framer-motion";
import { MessageSquare, Loader2, Trash2, Clock, Settings, X } from "lucide-react";
import RippleIcon from "@/components/icons/RippleIcon";
import { Session, UsageInfo } from "@/types";

const MAX_CONTEXT_TOKENS = 200_000;

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toLocaleString();
}

interface SidebarProps {
  sessions: Session[];
  currentSessionId: string | null;
  isLoadingSessions: boolean;
  isGenerating: boolean;
  tokenUsage: UsageInfo;
  lastContextTokens: number;
  isMobileOpen: boolean;
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
  onNewChat,
  onSwitchSession,
  onDeleteSession,
  onOpenSettings,
  onCloseMobile,
}: SidebarProps) {
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
      <div className="flex items-center justify-between border-b border-[#27272a] p-5">
        <a 
          href="https://github.com/echonoshy/ripple"
          target="_blank"
          rel="noopener noreferrer"
          className="group flex items-center gap-3 transition-opacity hover:opacity-80"
          title="View on GitHub"
        >
          <div className="flex items-center justify-center">
            <RippleIcon size={22} className="text-[#fafafa]" />
          </div>
          <div className="flex items-center gap-2.5">
            <h1 className="text-[17px] font-medium tracking-wide text-[#fafafa] font-[family-name:var(--font-sans)]">
              Ripple
            </h1>
            <span className="rounded-full bg-white/[0.06] px-2 py-0.5 text-[10px] font-medium tracking-widest text-[#a1a1aa] uppercase">
              Beta
            </span>
          </div>
        </a>
        <div className="flex items-center gap-1">
          <button
            onClick={onCloseMobile}
            className="flex h-8 w-8 items-center justify-center rounded-lg text-[#a1a1aa] hover:bg-white/[0.04] hover:text-[#fafafa] transition-colors md:hidden"
          >
            <X size={18} />
          </button>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto px-4 pt-4 pb-4">
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
          <h2 className="mb-2 px-2 text-xs font-medium tracking-wider text-[#71717a] uppercase">
            Sessions
          </h2>
          {isLoadingSessions && sessions.length === 0 ? (
            <div className="flex justify-center p-4">
              <Loader2 size={16} className="animate-spin text-[#10b981]" />
            </div>
          ) : sessions.length === 0 ? (
            <div className="px-3 py-4 text-center text-sm text-[#71717a]">No sessions yet</div>
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
                  className={`group flex cursor-pointer items-center justify-between rounded-lg p-2.5 transition-all duration-150 ${
                    session.session_id === currentSessionId
                      ? "border-l-2 border-[#10b981] bg-[#10b981]/[0.06]"
                      : "border-l-2 border-transparent hover:translate-x-0.5 hover:bg-white/[0.03]"
                  }`}
                >
                  <div className="flex min-w-0 items-center gap-2.5">
                    <div
                      className={`h-1.5 w-1.5 rounded-full ${
                        session.session_id === currentSessionId ? "bg-[#10b981]" : "bg-[#71717a]"
                      }`}
                    />
                    <div className="min-w-0">
                      <p
                        className={`truncate text-sm ${
                          session.session_id === currentSessionId
                            ? "font-medium text-[#10b981]"
                            : "text-[#a1a1aa]"
                        }`}
                      >
                        {session.title || session.session_id.substring(0, 12) + "..."}
                      </p>
                      <p className="mt-0.5 flex items-center gap-1 text-xs text-[#71717a]">
                        <Clock size={9} />
                        {new Date(session.last_active).toLocaleTimeString([], {
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                        <span className="mx-0.5">·</span>
                        {session.message_count} msgs
                      </p>
                    </div>
                  </div>
                  <button
                    onClick={(e) => onDeleteSession(session.session_id, e)}
                    className="shrink-0 rounded-md p-1.5 text-[#71717a] opacity-0 transition-all group-hover:opacity-100 hover:text-[#ef4444]"
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
            <h2 className="px-2 text-xs font-medium tracking-wider text-[#71717a] uppercase">
              Stats
            </h2>
            <div className="space-y-2 rounded-lg border border-[#27272a] bg-[#18181b] p-3">
              {lastContextTokens > 0 && (
                <div>
                  <div className="mb-1 flex justify-between font-[family-name:var(--font-mono)] text-xs">
                    <span className="text-[#71717a]">CTX</span>
                    <span
                      className={`font-medium ${isContextWarning ? "text-[#ef4444]" : "text-[#10b981]"}`}
                    >
                      {contextPercent.toFixed(0)}%
                    </span>
                  </div>
                  <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/[0.06]">
                    <div
                      className={`h-full rounded-full transition-all ${isContextWarning ? "bg-[#ef4444]" : "bg-[#10b981]"}`}
                      style={{ width: `${contextPercent}%` }}
                    />
                  </div>
                  <p className="mt-1 font-[family-name:var(--font-mono)] text-xs text-[#71717a]">
                    {formatTokens(lastContextTokens)} / {formatTokens(MAX_CONTEXT_TOKENS)}
                  </p>
                </div>
              )}
              <div className="flex justify-between font-[family-name:var(--font-mono)] text-xs">
                <span className="text-[#71717a]">Tokens</span>
                <span className="font-medium">
                  <span className="text-[#10b981]">↑{formatTokens(tokenUsage.prompt_tokens)}</span>
                  <span className="mx-1 text-[#71717a]">/</span>
                  <span className="text-[#3b82f6]">
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
        className="mx-3 mb-3 flex cursor-pointer items-center gap-3 rounded-lg p-3 text-[#a1a1aa] transition-colors hover:bg-white/[0.04] hover:text-[#fafafa]"
        onClick={onOpenSettings}
      >
        <div className="flex h-8 w-8 items-center justify-center rounded-lg border border-[#27272a] bg-[#18181b]">
          <Settings size={15} className="text-[#a1a1aa]" />
        </div>
        <span className="text-sm">Settings</span>
      </div>
    </>
  );

  return (
    <>
      {/* Desktop sidebar */}
      <div 
        className="hidden md:flex relative shrink-0" 
        style={{ width: width }}
      >
        <aside className="surface-panel flex h-full w-full flex-col rounded-none border-t-0 border-r border-b-0 border-l-0">
          {sidebarContent}
        </aside>
        {/* Resize handle */}
        <div
          className="absolute top-0 right-0 bottom-0 z-30 w-1.5 translate-x-1/2 cursor-col-resize items-center justify-center bg-transparent transition-colors hover:bg-[#10b981]/15 flex group"
          onMouseDown={handleResizeStart}
        >
          <div className="h-12 w-0.5 rounded-full bg-[#27272a] opacity-0 transition-opacity group-hover:opacity-100" />
        </div>
      </div>

      {/* Mobile overlay sidebar */}
      {isMobileOpen && (
        <>
          <div
            className="fixed inset-0 z-40 bg-black/30 backdrop-blur-sm md:hidden"
            onClick={onCloseMobile}
          />
          <aside className="fixed inset-y-0 left-0 z-50 flex w-72 flex-col border-r border-[#27272a] bg-[#18181b] md:hidden">
            {sidebarContent}
          </aside>
        </>
      )}
    </>
  );
}
