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
    <div className="shrink-0 border-t border-[#d0d7de] bg-white px-4 py-3">
      <div className="rounded-lg border border-[#d0d7de] bg-white p-2 shadow-sm focus-within:border-[#0969da]">
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
                ? "Steer Codex, approve a direction, or add context..."
                : "Describe the task you want Codex to work on..."
          }
          className="max-h-[220px] min-h-16 w-full resize-none bg-transparent px-1 py-1 text-sm leading-relaxed text-[#24292f] outline-none placeholder:text-[#8c959f] disabled:opacity-60"
        />
        <div className="flex items-center justify-between gap-3 border-t border-[#d8dee4] pt-2">
          <div className="hidden text-xs text-[#6e7781] sm:block">
            Enter sends · Shift+Enter adds a newline
          </div>
          {isGenerating ? (
            <button
              type="button"
              onClick={onStop}
              className="inline-flex h-8 items-center gap-2 rounded-md border border-[#cf222e]/30 bg-[#ffebe9] px-3 text-sm font-semibold text-[#cf222e] hover:bg-[#ffd7d5]"
            >
              <Square size={13} fill="currentColor" />
              Stop
            </button>
          ) : (
            <button
              type="button"
              onClick={onSend}
              disabled={!value.trim()}
              className="inline-flex h-8 items-center gap-2 rounded-md border border-[#0969da] bg-[#0969da] px-3 text-sm font-semibold text-white hover:bg-[#075dbd] disabled:cursor-not-allowed disabled:border-[#d0d7de] disabled:bg-[#f6f8fa] disabled:text-[#8c959f]"
            >
              <Send size={14} />
              Send
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
