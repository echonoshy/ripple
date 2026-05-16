"use client";

import React, { useCallback, useEffect, useRef } from "react";
import { Send, Square } from "lucide-react";
import { shouldApplyInputFocus } from "@/lib/inputFocus";

interface TaskComposerProps {
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  onStop: () => void;
  isGenerating: boolean;
  hasSession: boolean;
  focusToken: number;
}

export default function TaskComposer({
  value,
  onChange,
  onSend,
  onStop,
  isGenerating,
  hasSession,
  focusToken,
}: TaskComposerProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const adjustHeight = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  }, []);

  useEffect(() => {
    adjustHeight();
  }, [value, adjustHeight]);

  useEffect(() => {
    if (shouldApplyInputFocus(focusToken, isGenerating)) {
      textareaRef.current?.focus();
    }
  }, [focusToken, isGenerating]);

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter" || event.shiftKey) return;
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    event.preventDefault();
    if (!isGenerating && value.trim()) onSend();
  };

  return (
    <div className="shrink-0 border-t border-[#dde2ea] bg-white px-5 pt-3 pb-5 md:px-10 lg:px-[72px]">
      <div className="mx-auto max-w-4xl rounded-xl border border-[#cfd6e2] bg-white p-2 shadow-[0_10px_30px_rgba(23,26,31,0.08)] transition-colors focus-within:border-[#9aa7b7]">
        <textarea
          ref={textareaRef}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={handleKeyDown}
          disabled={isGenerating}
          rows={1}
          placeholder={
            isGenerating
              ? "Codex is working..."
              : hasSession
                ? "Message Codex..."
                : "Ask Codex to work on something..."
          }
          className="max-h-[220px] min-h-[58px] w-full resize-none bg-transparent px-2 py-2 text-[15px] leading-6 text-[#171a1f] outline-none placeholder:text-[#8b8f94] disabled:opacity-60"
        />
        <div className="flex items-center justify-end gap-2 pt-1">
          {isGenerating ? (
            <button
              type="button"
              onClick={onStop}
              aria-label="Stop generation"
              title="Stop generation"
              className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-[#cf222e]/25 bg-[#ffebe9] text-[#cf222e] hover:bg-[#ffd7d5]"
            >
              <Square size={13} fill="currentColor" />
            </button>
          ) : (
            <button
              type="button"
              onClick={onSend}
              disabled={!value.trim()}
              aria-label="Send message"
              title="Send message"
              className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-[#2463eb] bg-[#2463eb] text-white shadow-[0_8px_24px_rgba(36,99,235,0.18)] hover:bg-[#1d56d8] disabled:cursor-not-allowed disabled:border-[#dde2ea] disabled:bg-[#f7f8fa] disabled:text-[#8b8f94] disabled:shadow-none"
            >
              <Send size={14} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
