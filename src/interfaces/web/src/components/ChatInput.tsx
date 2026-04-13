"use client";

import React, { useRef, useEffect, useCallback } from "react";
import { motion } from "framer-motion";
import { Send, Square } from "lucide-react";

interface ChatInputProps {
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  onStop: () => void;
  isGenerating: boolean;
  hasSession: boolean;
}

export default function ChatInput({
  value,
  onChange,
  onSend,
  onStop,
  isGenerating,
  hasSession,
}: ChatInputProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const adjustHeight = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, []);

  useEffect(() => {
    adjustHeight();
  }, [value, adjustHeight]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (!isGenerating && value.trim()) {
        onSend();
      }
    }
  };

  return (
    <div className="pointer-events-none absolute right-0 bottom-0 left-0 z-20 bg-gradient-to-t from-slate-50 via-slate-50/95 to-transparent px-4 pt-6 pb-4 md:px-6">
      <div className="pointer-events-auto mx-auto max-w-3xl">
        <div className="glass-bubble relative flex items-end gap-2 rounded-2xl p-2 shadow-lg shadow-slate-200/50">
          <textarea
            ref={textareaRef}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={isGenerating}
            rows={1}
            placeholder={
              isGenerating
                ? "Ripple is working..."
                : !hasSession
                  ? "输入消息开始新对话..."
                  : "Ask Ripple anything... (Shift+Enter 换行)"
            }
            className="max-h-[200px] min-h-[44px] flex-1 resize-none bg-transparent py-3 pr-2 pl-4 text-[15px] leading-relaxed text-slate-700 placeholder:text-slate-400 focus:outline-none disabled:opacity-60"
          />
          <div className="flex shrink-0 items-center gap-1.5 pb-1.5">
            {isGenerating ? (
              <motion.button
                whileHover={{ scale: 1.05 }}
                whileTap={{ scale: 0.95 }}
                type="button"
                onClick={onStop}
                className="flex h-10 w-10 items-center justify-center rounded-xl bg-red-500 text-white shadow-md shadow-red-500/25 transition-colors hover:bg-red-600"
                title="Stop generation"
              >
                <Square size={16} fill="currentColor" />
              </motion.button>
            ) : (
              <motion.button
                whileHover={{ scale: 1.05 }}
                whileTap={{ scale: 0.95 }}
                type="button"
                onClick={onSend}
                disabled={!value.trim()}
                className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-violet-500 to-fuchsia-500 text-white shadow-md shadow-purple-500/30 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <Send size={16} className="ml-0.5" />
              </motion.button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
