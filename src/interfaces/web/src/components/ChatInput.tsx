"use client";

import React, { useRef, useEffect, useCallback } from "react";
import { motion } from "framer-motion";
import { Send, Square } from "lucide-react";
import { shouldApplyInputFocus } from "@/lib/inputFocus";

interface ChatInputProps {
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  onStop: () => void;
  isGenerating: boolean;
  hasSession: boolean;
  focusToken: number;
}

export default function ChatInput({
  value,
  onChange,
  onSend,
  onStop,
  isGenerating,
  hasSession,
  focusToken,
}: ChatInputProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const adjustHeight = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 400)}px`;
  }, []);

  useEffect(() => {
    adjustHeight();
  }, [value, adjustHeight]);

  useEffect(() => {
    if (shouldApplyInputFocus(focusToken, isGenerating)) {
      textareaRef.current?.focus();
    }
  }, [focusToken, isGenerating]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (!isGenerating && value.trim()) {
        onSend();
      }
    }
  };

  return (
    <div className="z-20 shrink-0 border-t border-slate-200/50 bg-slate-50/80 px-4 pt-3 pb-6 backdrop-blur-md md:px-6">
      <div className="mx-auto max-w-5xl">
        <div className="relative flex items-end gap-2 rounded-2xl border border-slate-200 bg-white p-1.5 shadow-sm transition-all focus-within:border-violet-300 focus-within:ring-4 focus-within:ring-violet-500/10 hover:border-slate-300">
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
                  : "Ask Ripple anything..."
            }
            className="max-h-[400px] min-h-[44px] flex-1 resize-none bg-transparent py-3 pr-2 pl-4 text-[14px] leading-relaxed text-slate-700 placeholder:text-slate-400 focus:outline-none disabled:opacity-60 [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-slate-200 hover:[&::-webkit-scrollbar-thumb]:bg-slate-300 [&::-webkit-scrollbar-track]:bg-transparent"
          />
          <div className="flex shrink-0 items-center gap-1.5 pr-1 pb-1">
            {isGenerating ? (
              <motion.button
                whileHover={{ scale: 1.05 }}
                whileTap={{ scale: 0.95 }}
                type="button"
                onClick={onStop}
                className="flex h-9 w-9 items-center justify-center rounded-xl bg-red-500 text-white shadow-sm transition-colors hover:bg-red-600"
                title="Stop generation"
              >
                <Square size={14} fill="currentColor" />
              </motion.button>
            ) : (
              <motion.button
                whileHover={{ scale: 1.05 }}
                whileTap={{ scale: 0.95 }}
                type="button"
                onClick={onSend}
                disabled={!value.trim()}
                className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-violet-500 to-fuchsia-500 text-white shadow-sm disabled:cursor-not-allowed disabled:opacity-50"
              >
                <Send size={14} className="ml-0.5" />
              </motion.button>
            )}
          </div>
        </div>

        <div className="mt-2 flex justify-center gap-4 text-[11px] text-slate-400">
          <span className="flex items-center gap-1">
            <kbd className="rounded border border-slate-200 bg-slate-100 px-1.5 py-0.5 font-sans text-[10px] text-slate-500">
              Shift
            </kbd>{" "}
            +{" "}
            <kbd className="rounded border border-slate-200 bg-slate-100 px-1.5 py-0.5 font-sans text-[10px] text-slate-500">
              Enter
            </kbd>{" "}
            换行
          </span>
          <span className="flex items-center gap-1">
            <kbd className="rounded border border-slate-200 bg-slate-100 px-1.5 py-0.5 font-sans text-[10px] text-slate-500">
              Enter
            </kbd>{" "}
            发送
          </span>
        </div>
      </div>
    </div>
  );
}
