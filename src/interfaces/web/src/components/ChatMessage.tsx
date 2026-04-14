"use client";

import React, { useState, useEffect } from "react";
import { motion } from "framer-motion";
import { User, Loader2 } from "lucide-react";
import { Message } from "@/types";
import RippleIcon from "@/components/icons/RippleIcon";
import MarkdownRenderer from "./MarkdownRenderer";
import { shouldRenderAssistantMessage } from "@/lib/chatState";

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
      <div className="flex items-center gap-2 px-1 py-1.5 text-sm text-[#a1a1aa]">
        <div className="flex gap-1">
          {[0, 1, 2].map((i) => (
            <span
              key={i}
              className="inline-block h-1.5 w-1.5 rounded-full bg-[#10b981]"
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
    <div className="inline-flex items-center gap-3 rounded-xl border border-[#27272a] bg-[#18181b] px-5 py-4">
      <div className="relative flex h-5 w-5 items-center justify-center">
        <Loader2 size={16} className="relative animate-spin text-[#10b981]" />
      </div>
      <div className="flex flex-col">
        <span className="text-sm text-[#fafafa]">
          {elapsed < 5
            ? "Thinking..."
            : elapsed < 30
              ? "Generating response..."
              : "Still processing..."}
        </span>
        {elapsed >= 3 && (
          <span className="font-[family-name:var(--font-mono)] text-xs text-[#71717a]">
            {formatTime(elapsed)}
          </span>
        )}
      </div>
    </div>
  );
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

  if (!shouldRenderAssistantMessage(msg, isGenerating, isLast)) {
    return null;
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ type: "spring", stiffness: 400, damping: 30 }}
      className={`flex gap-2.5 ${isUser ? "justify-end" : ""}`}
    >
      {/* Assistant avatar */}
      {!isUser && (
        <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-[#10b981]/30 bg-[#10b981]/10">
          <RippleIcon size={14} className="text-[#10b981]" />
        </div>
      )}

      {isUser ? (
        /* User message */
        <div className="max-w-[95%] rounded-2xl rounded-br-md border border-[#3b82f6]/20 bg-[#3b82f6]/[0.05] px-4 py-3 text-sm leading-relaxed text-[#fafafa]">
          <div className="whitespace-pre-wrap">{msg.content}</div>
        </div>
      ) : (
        /* Assistant message */
        <div className="max-w-full min-w-0 flex-1 space-y-2">
          {showThinking && isEmptyAssistant && <ThinkingIndicator hasContent={false} />}

          {msg.content && (
            <div className="rounded-2xl rounded-tl-md border border-[#27272a] bg-[#18181b] px-4 py-3 text-sm leading-relaxed text-[#fafafa]">
              <MarkdownRenderer content={msg.content} />
            </div>
          )}

          {msg.askUser && !isGenerating && isLast && onQuickReply && (
            <div className="rounded-xl border border-[#10b981]/30 bg-[#18181b] px-4 py-3">
              <div className="mb-2 flex items-center gap-2 text-xs font-medium text-[#10b981]">
                <span>{">"}</span>
                <span>Select an option</span>
              </div>
              <p className="mb-3 text-sm text-[#fafafa]">{msg.askUser.question}</p>
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
            <div className="rounded-xl border border-[#ef4444]/30 bg-[#ef4444]/[0.03] px-4 py-3">
              <div className="mb-2 flex items-center gap-2 text-xs font-medium text-[#ef4444]">
                <span>!</span>
                <span>Permission Required</span>
              </div>
              <p className="mb-2 text-sm text-[#fafafa]">
                Tool:{" "}
                <span className="font-medium text-[#f59e0b]">{msg.permissionRequest.tool}</span>
              </p>
              <div className="mb-3 overflow-x-auto rounded-lg border border-[#27272a] bg-[#18181b] p-3 font-[family-name:var(--font-mono)] text-xs text-[#10b981]">
                {typeof msg.permissionRequest.params === "string"
                  ? msg.permissionRequest.params
                  : JSON.stringify(msg.permissionRequest.params, null, 2)}
              </div>
              <div className="flex flex-col gap-2">
                <motion.button
                  whileHover={{ scale: 1.01 }}
                  whileTap={{ scale: 0.99 }}
                  onClick={() => onPermissionResolve("allow")}
                  className="rounded-lg border border-[#10b981]/40 bg-[#10b981]/10 px-4 py-2 text-sm text-[#10b981] transition-colors hover:bg-[#10b981]/15"
                >
                  Allow Once
                </motion.button>
                <motion.button
                  whileHover={{ scale: 1.01 }}
                  whileTap={{ scale: 0.99 }}
                  onClick={() => onPermissionResolve("always")}
                  className="rounded-lg border border-[#3b82f6]/30 bg-[#3b82f6]/[0.06] px-4 py-2 text-sm text-[#3b82f6] transition-colors hover:bg-[#3b82f6]/10"
                >
                  Always Allow
                </motion.button>
                <motion.button
                  whileHover={{ scale: 1.01 }}
                  whileTap={{ scale: 0.99 }}
                  onClick={() => onPermissionResolve("deny")}
                  className="rounded-lg border border-[#ef4444]/30 bg-[#ef4444]/[0.06] px-4 py-2 text-sm text-[#ef4444] transition-colors hover:bg-[#ef4444]/10"
                >
                  Deny
                </motion.button>
              </div>
            </div>
          )}

          {showThinking && !isEmptyAssistant && <ThinkingIndicator hasContent={true} />}
        </div>
      )}

      {/* User avatar */}
      {isUser && (
        <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-[#3b82f6]/30 bg-[#3b82f6]/10">
          <User size={14} className="text-[#3b82f6]" />
        </div>
      )}
    </motion.div>
  );
}
