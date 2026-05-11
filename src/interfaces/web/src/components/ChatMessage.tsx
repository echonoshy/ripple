"use client";

import React, { useState, useEffect } from "react";
import { motion } from "framer-motion";
import { Loader2, UserRound } from "lucide-react";
import { Message } from "@/types";
import MarkdownRenderer from "./MarkdownRenderer";
import { shouldRenderAssistantMessage } from "@/lib/chatState";
import RippleIcon from "./icons/RippleIcon";

function ThinkingIndicator({ hasContent }: { hasContent: boolean }) {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    const start = Date.now();
    const timer = setInterval(() => {
      setElapsed(Math.floor((Date.now() - start) / 1000));
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  const formatTime = (s: number) => {
    if (s < 60) return `${s}s`;
    return `${Math.floor(s / 60)}m${s % 60}s`;
  };

  if (hasContent) {
    return (
      <div className="text-ripple-ink/65 flex items-center gap-2 px-1 py-1.5 text-sm font-bold">
        <div className="flex gap-1">
          {[0, 1, 2].map((i) => (
            <span
              key={i}
              className="border-ripple-ink bg-ripple-yellow inline-block h-1.5 w-1.5 border"
              style={{
                animation: "bounce-dot 1.4s ease-in-out infinite",
                animationDelay: `${i * 160}ms`,
              }}
            />
          ))}
        </div>
        <span>Thinking{elapsed > 3 ? ` — ${formatTime(elapsed)}` : ""}</span>
      </div>
    );
  }

  return (
    <div className="border-ripple-ink inline-flex items-center gap-3 border-2 bg-white px-5 py-4 shadow-[3px_3px_0_#111111]">
      <div className="relative flex h-5 w-5 items-center justify-center">
        <Loader2 size={16} className="text-ripple-ink relative animate-spin" />
      </div>
      <div className="flex flex-col">
        <span className="text-ripple-ink text-sm font-bold">
          {elapsed < 5
            ? "Thinking..."
            : elapsed < 30
              ? "Generating response..."
              : "Still processing..."}
        </span>
        {elapsed >= 3 && (
          <span className="text-ripple-ink/55 font-[family-name:var(--font-mono)] text-xs font-bold">
            {formatTime(elapsed)}
          </span>
        )}
      </div>
    </div>
  );
}

function formatMessageTime(value: string | undefined): string {
  if (!value) return "";
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

interface ChatMessageProps {
  msg: Message;
  isGenerating: boolean;
  isLast: boolean;
  onQuickReply?: (option: string) => void;
  onPermissionResolve?: (action: "allow" | "always" | "deny") => void;
}

export default function ChatMessage({
  msg,
  isGenerating,
  isLast,
  onQuickReply,
  onPermissionResolve,
}: ChatMessageProps) {
  const isUser = msg.role === "user";
  const showThinking = isGenerating && isLast && msg.role === "assistant";
  const isEmptyAssistant = !msg.content && (!msg.toolCalls || msg.toolCalls.length === 0);
  const messageTime = isUser ? formatMessageTime(msg.created_at) : "";
  const avatarBg = isUser ? "bg-blue-200" : "bg-ripple-lavender";
  const messageBg = isUser ? "bg-blue-200/30" : "bg-white";

  if (!shouldRenderAssistantMessage(msg, isGenerating, isLast)) {
    return null;
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ type: "spring", stiffness: 400, damping: 30 }}
      className="mb-0 flex gap-3"
    >
      <div
        className={`border-ripple-ink text-ripple-ink mt-1 flex h-10 w-10 shrink-0 items-center justify-center border-2 ${avatarBg} shadow-[3px_3px_0_#111111]`}
      >
        {isUser ? <UserRound size={24} /> : <RippleIcon size={40} />}
      </div>
      <div className="min-w-0 flex-1">
        {/* Label */}
        <div className="text-ripple-ink/65 mb-1 flex items-center gap-2 px-1 text-xs font-bold">
          {isUser ? "User" : "Ripple"}
          {messageTime && (
            <span className="text-ripple-ink/50 font-[family-name:var(--font-mono)] font-normal">
              {messageTime}
            </span>
          )}
        </div>

        <div
          className={`border-ripple-ink max-w-full min-w-0 space-y-2 border-2 ${messageBg} text-ripple-ink p-4 text-[14px] leading-relaxed shadow-[3px_3px_0_#111111]`}
        >
          {showThinking && isEmptyAssistant && <ThinkingIndicator hasContent={false} />}

          {msg.content && (
            <div className="text-ripple-ink min-w-0 overflow-hidden text-[14px] leading-relaxed">
              <MarkdownRenderer content={msg.content} />
            </div>
          )}

          {msg.askUser && !isGenerating && isLast && onQuickReply && (
            <div className="border-ripple-ink bg-ripple-yellow/35 mt-4 border-2 px-4 py-3 shadow-[2px_2px_0_#111111]">
              <div className="text-ripple-ink mb-2 flex items-center gap-2 text-xs font-bold">
                <span>{">"}</span>
                <span>Select an option</span>
              </div>
              <p className="text-ripple-ink mb-3 text-sm font-medium">{msg.askUser.question}</p>
              {msg.askUser.options && msg.askUser.options.length > 0 && (
                <div className="flex flex-wrap gap-2">
                  {msg.askUser.options.map((option, i) => (
                    <motion.button
                      key={i}
                      whileHover={{ scale: 1.02 }}
                      whileTap={{ scale: 0.98 }}
                      onClick={() => onQuickReply(option)}
                      className="btn-ghost px-4 py-2 text-sm"
                    >
                      {String.fromCharCode(65 + i)}. {option}
                    </motion.button>
                  ))}
                </div>
              )}
            </div>
          )}

          {msg.permissionRequest && !isGenerating && isLast && onPermissionResolve && (
            <div className="border-ripple-ink bg-ripple-orange/30 mt-4 border-2 px-4 py-3 shadow-[2px_2px_0_#111111]">
              <div className="text-ripple-ink mb-2 flex items-center gap-2 text-xs font-bold">
                <span>!</span>
                <span>Permission Required</span>
              </div>
              <p className="text-ripple-ink mb-2 text-sm font-medium">
                Tool:{" "}
                <span className="font-[family-name:var(--font-mono)] font-bold">
                  {msg.permissionRequest.tool}
                </span>
              </p>
              <div className="border-ripple-ink bg-ripple-terminal mb-3 overflow-x-auto border-2 p-3 font-[family-name:var(--font-mono)] text-xs text-[#d7d7d7]">
                {typeof msg.permissionRequest.params === "string"
                  ? msg.permissionRequest.params
                  : JSON.stringify(msg.permissionRequest.params, null, 2)}
              </div>
              <div className="flex flex-col gap-2">
                <motion.button
                  whileHover={{ scale: 1.01 }}
                  whileTap={{ scale: 0.99 }}
                  onClick={() => onPermissionResolve("allow")}
                  className="btn-ghost bg-ripple-lime px-4 py-2 text-sm"
                >
                  Allow Once
                </motion.button>
                <motion.button
                  whileHover={{ scale: 1.01 }}
                  whileTap={{ scale: 0.99 }}
                  onClick={() => onPermissionResolve("always")}
                  className="btn-ghost px-4 py-2 text-sm"
                >
                  Always Allow
                </motion.button>
                <motion.button
                  whileHover={{ scale: 1.01 }}
                  whileTap={{ scale: 0.99 }}
                  onClick={() => onPermissionResolve("deny")}
                  className="btn-ghost bg-ripple-red/40 px-4 py-2 text-sm"
                >
                  Deny
                </motion.button>
              </div>
            </div>
          )}

          {showThinking && !isEmptyAssistant && <ThinkingIndicator hasContent={true} />}
        </div>

        {/* Separator (except for the very last message being generated) */}
        {!isLast && <div className="separator-glow mt-4 mb-1" />}
      </div>
    </motion.div>
  );
}
