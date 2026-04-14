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
      <div className="flex items-center gap-2 px-1 py-1.5 text-sm text-slate-400">
        <div className="flex gap-0.5">
          {[0, 1, 2].map((i) => (
            <span
              key={i}
              className="inline-block h-1.5 w-1.5 animate-bounce rounded-full bg-violet-400"
              style={{ animationDelay: `${i * 150}ms` }}
            />
          ))}
        </div>
        <span>处理中{elapsed > 3 ? ` · ${formatTime(elapsed)}` : ""}</span>
      </div>
    );
  }

  return (
    <div className="inline-flex items-center gap-3 rounded-2xl rounded-tl-md border border-violet-100 bg-gradient-to-r from-violet-50 to-fuchsia-50 px-5 py-4 shadow-sm">
      <div className="relative flex h-5 w-5 items-center justify-center">
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-violet-400 opacity-30" />
        <Loader2 size={16} className="relative animate-spin text-violet-500" />
      </div>
      <div className="flex flex-col">
        <span className="text-sm font-medium text-slate-600">
          {elapsed < 5 ? "思考中..." : elapsed < 30 ? "正在生成回复..." : "仍在处理，请耐心等待..."}
        </span>
        {elapsed >= 3 && (
          <span className="text-xs text-slate-400">已等待 {formatTime(elapsed)}</span>
        )}
      </div>
    </div>
  );
}

interface ChatMessageProps {
  msg: Message;
  isGenerating: boolean;
  isLast: boolean;
}

export default function ChatMessage({ msg, isGenerating, isLast }: ChatMessageProps) {
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
      transition={{ duration: 0.3, ease: [0.23, 1, 0.32, 1] }}
      className={`flex gap-2.5 ${isUser ? "justify-end" : ""}`}
    >
      {!isUser && (
        <div className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-violet-500 to-fuchsia-500 shadow-sm">
          <RippleIcon size={12} className="text-white" />
        </div>
      )}

      {isUser ? (
        <div className="max-w-[95%] rounded-xl rounded-br-sm bg-gradient-to-br from-blue-500 to-indigo-600 px-3.5 py-2.5 text-[14px] leading-snug text-white shadow-sm">
          <div className="whitespace-pre-wrap">{msg.content}</div>
        </div>
      ) : (
        <div className="max-w-full min-w-0 flex-1 space-y-2">
          {showThinking && isEmptyAssistant && <ThinkingIndicator hasContent={false} />}

          {msg.content && (
            <div className="rounded-xl rounded-tl-sm border border-white/60 bg-white/80 px-4 py-3 text-[14px] leading-snug text-slate-700 shadow-sm backdrop-blur-sm">
              <MarkdownRenderer content={msg.content} />
            </div>
          )}

          {showThinking && !isEmptyAssistant && <ThinkingIndicator hasContent={true} />}
        </div>
      )}

      {isUser && (
        <div className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-blue-400 to-indigo-500 shadow-sm">
          <User size={12} className="text-white" />
        </div>
      )}
    </motion.div>
  );
}
