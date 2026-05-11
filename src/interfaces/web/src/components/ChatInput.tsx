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
    <div className="border-ripple-ink bg-ripple-paper z-20 shrink-0 border-t-2 px-4 pt-3 pb-6 md:px-6">
      <div className="mx-auto max-w-5xl">
        <div className="border-ripple-ink focus-within:bg-ripple-yellow/20 relative flex items-end gap-2 border-2 bg-white p-1.5 shadow-[4px_4px_0_#111111] transition-all duration-100 focus-within:translate-x-0.5 focus-within:translate-y-0.5 focus-within:shadow-[2px_2px_0_#111111]">
          {/* Terminal prompt prefix */}
          <span className="border-ripple-ink bg-ripple-lavender text-ripple-ink mb-1 flex shrink-0 items-center border-2 px-2 py-1 font-[family-name:var(--font-mono)] text-sm font-bold">
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
            className="text-ripple-ink placeholder:text-ripple-ink/45 [&::-webkit-scrollbar-thumb]:bg-ripple-ink max-h-[400px] min-h-[44px] flex-1 resize-none bg-transparent py-3 pr-2 text-sm leading-relaxed font-medium focus:outline-none disabled:opacity-60 [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-track]:bg-transparent"
          />
          <div className="flex shrink-0 items-center gap-1.5 pr-1 pb-1">
            {isGenerating ? (
              <motion.button
                whileHover={{ scale: 1.05 }}
                whileTap={{ scale: 0.95 }}
                type="button"
                onClick={onStop}
                className="btn-icon bg-ripple-red/35 h-9 w-9"
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
                className="btn-icon disabled:text-ripple-ink/35 h-9 w-9 disabled:cursor-not-allowed disabled:bg-white disabled:opacity-60"
              >
                <Send size={14} className="ml-0.5" />
              </motion.button>
            )}
          </div>
        </div>

        <div className="text-ripple-ink/55 mt-3 flex justify-center gap-4 text-xs font-bold">
          <span className="flex items-center gap-1">
            <kbd className="border-ripple-ink text-ripple-ink border-2 bg-white px-1.5 py-0.5 font-[family-name:var(--font-mono)] text-[10px] shadow-[1px_1px_0_#111111]">
              Shift
            </kbd>{" "}
            +{" "}
            <kbd className="border-ripple-ink text-ripple-ink border-2 bg-white px-1.5 py-0.5 font-[family-name:var(--font-mono)] text-[10px] shadow-[1px_1px_0_#111111]">
              Enter
            </kbd>{" "}
            换行
          </span>
          <span className="flex items-center gap-1">
            <kbd className="border-ripple-ink text-ripple-ink border-2 bg-white px-1.5 py-0.5 font-[family-name:var(--font-mono)] text-[10px] shadow-[1px_1px_0_#111111]">
              Enter
            </kbd>{" "}
            发送
          </span>
        </div>
      </div>
    </div>
  );
}
