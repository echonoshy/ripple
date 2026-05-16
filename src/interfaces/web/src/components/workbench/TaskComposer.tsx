"use client";

import React, { useCallback, useEffect, useRef } from "react";
import { AtSign, ChevronDown, Paperclip, Plus, Send, Square } from "lucide-react";
import { shouldApplyInputFocus } from "@/lib/inputFocus";

interface TaskComposerProps {
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  onStop: () => void;
  isGenerating: boolean;
  hasSession: boolean;
  focusToken: number;
  selectedModel: string;
  models: { id: string; owned_by: string }[];
  isModelDropdownOpen: boolean;
  onToggleModelDropdown: () => void;
  onSelectModel: (model: string) => void;
}

export default function TaskComposer({
  value,
  onChange,
  onSend,
  onStop,
  isGenerating,
  hasSession,
  focusToken,
  selectedModel,
  models,
  isModelDropdownOpen,
  onToggleModelDropdown,
  onSelectModel,
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
    <div className="shrink-0 border-t border-[#e5e7eb] bg-white px-5 pt-3 pb-[92px] md:px-8 lg:pb-5">
      <div className="mx-auto max-w-4xl rounded-xl border border-[#d7dce3] bg-white p-2 shadow-[0_10px_30px_rgba(23,26,31,0.06)] transition-colors focus-within:border-[#aab4c2]">
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
                ? "Ask Codex anything about your codebase..."
                : "Ask Codex anything about your codebase..."
          }
          className="max-h-[220px] min-h-[46px] w-full resize-none bg-transparent px-2 py-2 text-[14px] leading-6 text-[#0d0d0d] outline-none placeholder:text-[#8b8f94] disabled:opacity-60"
        />
        <div className="flex items-center justify-between gap-2 pt-1">
          <div className="flex items-center gap-1">
            {[
              { label: "Add", icon: Plus },
              { label: "Attach", icon: Paperclip },
              { label: "Mention", icon: AtSign },
            ].map((item) => {
              const Icon = item.icon;
              return (
                <button
                  key={item.label}
                  type="button"
                  aria-label={item.label}
                  title={item.label}
                  onClick={() => textareaRef.current?.focus()}
                  className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-[#e5e7eb] bg-white text-[#374151] hover:bg-[#f7f8fa] hover:text-[#0d0d0d]"
                >
                  <Icon size={15} />
                </button>
              );
            })}
          </div>

          <div className="flex items-center gap-2">
            <div className="relative">
              <button
                type="button"
                aria-label="Select model"
                title={`Model: ${selectedModel}`}
                onClick={onToggleModelDropdown}
                className="hidden h-8 max-w-[180px] items-center gap-1.5 rounded-md px-2 font-[family-name:var(--font-mono)] text-xs font-medium text-[#0d0d0d] hover:bg-[#f7f8fa] sm:inline-flex"
              >
                <span className="truncate">{selectedModel}</span>
                <ChevronDown
                  size={13}
                  className={`shrink-0 text-[#6b7280] transition-transform ${
                    isModelDropdownOpen ? "rotate-180" : ""
                  }`}
                />
              </button>
              {isModelDropdownOpen && (
                <div className="absolute right-0 bottom-full z-30 mb-2 w-48 overflow-hidden rounded-lg border border-[#e5e7eb] bg-white shadow-lg">
                  <div className="p-1">
                    {models.map((model) => (
                      <button
                        key={model.id}
                        type="button"
                        onClick={() => onSelectModel(model.id)}
                        className={`flex w-full items-center rounded px-3 py-2 text-left font-[family-name:var(--font-mono)] text-xs hover:bg-[#f7f8fa] ${
                          selectedModel === model.id
                            ? "bg-[#eef4ff] text-[#0b57d0]"
                            : "text-[#0d0d0d]"
                        }`}
                      >
                        {model.id}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
            {isGenerating ? (
              <button
                type="button"
                onClick={onStop}
                aria-label="Stop generation"
                title="Stop generation"
                className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-[#cf222e]/25 bg-[#ffebe9] text-[#cf222e] hover:bg-[#ffd7d5]"
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
                className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-[#2463eb] bg-[#2463eb] text-white shadow-[0_8px_24px_rgba(36,99,235,0.18)] hover:bg-[#1d56d8] disabled:cursor-not-allowed disabled:border-[#e5e7eb] disabled:bg-[#f7f8fa] disabled:text-[#8b8f94] disabled:shadow-none"
              >
                <Send size={14} />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
