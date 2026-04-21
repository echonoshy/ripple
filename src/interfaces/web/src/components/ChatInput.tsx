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
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
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

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== "Enter" || e.shiftKey) return;
    // 当 IME 正在组词时（如中文输入法选字），Enter 仅用于确认候选，不应触发发送。
    // `isComposing` 是现代浏览器的标准属性；`keyCode === 229` 是兼容旧浏览器的回退判断。
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    e.preventDefault();
    if (!isGenerating && value.trim()) {
      onSend();
    }
  };

  return (
    <div className="z-20 shrink-0 border-t border-white/10 bg-black/90 px-4 pt-3 pb-6 backdrop-blur-sm md:px-6">
      <div className="mx-auto max-w-5xl">
        <div className="relative flex items-end gap-2 rounded-xl border border-white/10 bg-[#0a0a0a] p-1.5 transition-all duration-200 focus-within:border-white/20 focus-within:border-white/40 focus-within:shadow-[0_0_15px_rgba(255,255,255,0.05)] focus-within:ring-0">
          {/* Terminal prompt prefix */}
          <span className="flex shrink-0 items-center pb-3 pl-3 font-[family-name:var(--font-mono)] text-sm font-medium text-[#ededed]">
            {">_"}
          </span>
          <textarea
            ref={textareaRef}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={isGenerating}
            rows={1}
            placeholder={isGenerating ? "Thinking..." : "Ask anything..."}
            className="max-h-[400px] min-h-[44px] flex-1 resize-none bg-transparent py-3 pr-2 text-sm leading-relaxed text-[#ededed] placeholder:text-[#666666] focus:outline-none disabled:opacity-60 [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-white/10 [&::-webkit-scrollbar-track]:bg-transparent"
          />
          <div className="flex shrink-0 items-center gap-1.5 pr-1 pb-1">
            {isGenerating ? (
              <motion.button
                whileHover={{ scale: 1.05 }}
                whileTap={{ scale: 0.95 }}
                type="button"
                onClick={onStop}
                className="flex h-9 w-9 items-center justify-center rounded-lg border border-[#ff4444]/40 bg-[#ff4444]/10 text-[#ff4444] transition-colors hover:bg-[#ff4444]/15"
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
                className="flex h-9 w-9 items-center justify-center rounded-lg border border-white/10 bg-black/5 text-[#ededed] transition-colors hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-30"
              >
                <Send size={14} className="ml-0.5" />
              </motion.button>
            )}
          </div>
        </div>

        <div className="mt-2 flex justify-center gap-4 text-xs text-[#666666]">
          <span className="flex items-center gap-1">
            <kbd className="rounded border border-white/10 bg-[#0a0a0a] px-1.5 py-0.5 font-[family-name:var(--font-mono)] text-[10px] text-[#888888]">
              Shift
            </kbd>{" "}
            +{" "}
            <kbd className="rounded border border-white/10 bg-[#0a0a0a] px-1.5 py-0.5 font-[family-name:var(--font-mono)] text-[10px] text-[#888888]">
              Enter
            </kbd>{" "}
            换行
          </span>
          <span className="flex items-center gap-1">
            <kbd className="rounded border border-white/10 bg-[#0a0a0a] px-1.5 py-0.5 font-[family-name:var(--font-mono)] text-[10px] text-[#888888]">
              Enter
            </kbd>{" "}
            发送
          </span>
        </div>
      </div>
    </div>
  );
}
