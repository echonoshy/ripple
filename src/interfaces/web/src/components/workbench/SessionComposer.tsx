"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, FileText, Paperclip, Send, Square, Trash2, X } from "lucide-react";
import type { ChatFileRef } from "@/lib/chatInput";
import {
  getQuickActionMatches,
  getSlashCommandTrigger,
  type QuickAction,
} from "@/lib/composerTriggers";
import { shouldApplyInputFocus } from "@/lib/inputFocus";

interface SessionComposerProps {
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  onStop: () => void;
  onClearContext: () => void;
  onAttachFiles: (files: File[]) => void | Promise<void>;
  onRemovePendingFile: (path: string) => void;
  pendingFiles: ChatFileRef[];
  isGenerating: boolean;
  isBlocked?: boolean;
  hasSession: boolean;
  focusToken: number;
  selectedModel: string;
  models: { id: string; owned_by: string }[];
  isModelDropdownOpen: boolean;
  onToggleModelDropdown: () => void;
  onSelectModel: (model: string) => void;
}

type QuickActionsState = {
  query: string;
  key: string;
};

export default function SessionComposer({
  value,
  onChange,
  onSend,
  onStop,
  onClearContext,
  onAttachFiles,
  onRemovePendingFile,
  pendingFiles,
  isGenerating,
  isBlocked = false,
  hasSession,
  focusToken,
  selectedModel,
  models,
  isModelDropdownOpen,
  onToggleModelDropdown,
  onSelectModel,
}: SessionComposerProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const quickActionsRef = useRef<HTMLDivElement>(null);
  const [quickActionsState, setQuickActionsState] = useState<QuickActionsState | null>(null);
  const [dismissedSlashKey, setDismissedSlashKey] = useState<string | null>(null);
  const [quickActionIndex, setQuickActionIndex] = useState(0);
  const canSend = Boolean(value.trim() || pendingFiles.length > 0);
  const inputDisabled = isGenerating;
  const sendDisabled = isGenerating || isBlocked;
  const isQuickActionsOpen = quickActionsState !== null;
  const quickActionMatches = useMemo(
    () => getQuickActionMatches(quickActionsState?.query ?? ""),
    [quickActionsState?.query]
  );

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
    if (shouldApplyInputFocus(focusToken, inputDisabled)) {
      textareaRef.current?.focus();
    }
  }, [focusToken, inputDisabled]);

  const getTextareaCursor = useCallback(
    () => textareaRef.current?.selectionStart ?? value.length,
    [value.length]
  );

  const closeOpenPopups = useCallback(
    (rememberDismissal: boolean = true) => {
      const cursor = getTextareaCursor();
      if (rememberDismissal) {
        const slashTrigger = getSlashCommandTrigger(value, cursor);
        if (slashTrigger) {
          setDismissedSlashKey(slashTrigger.key);
        }
      }

      setQuickActionsState(null);
    },
    [getTextareaCursor, value]
  );

  const syncInputDrivenPopups = useCallback(
    (nextValue: string, cursor: number) => {
      if (inputDisabled) return;

      const slashTrigger = getSlashCommandTrigger(nextValue, cursor);
      if (slashTrigger && slashTrigger.key !== dismissedSlashKey) {
        setQuickActionsState(slashTrigger);
        setQuickActionIndex(0);
        return;
      }

      setQuickActionsState(null);
    },
    [dismissedSlashKey, inputDisabled]
  );

  useEffect(() => {
    if (!isQuickActionsOpen) return;

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (quickActionsRef.current?.contains(target)) return;
      closeOpenPopups();
    };

    document.addEventListener("pointerdown", handlePointerDown, true);
    return () => document.removeEventListener("pointerdown", handlePointerDown, true);
  }, [closeOpenPopups, isQuickActionsOpen]);

  const runQuickAction = useCallback(
    (action: QuickAction) => {
      setQuickActionsState(null);

      if (action.id === "clear") {
        onChange("");
        onClearContext();
        requestAnimationFrame(() => textareaRef.current?.focus());
      }
    },
    [onChange, onClearContext]
  );

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (isQuickActionsOpen && event.key === "Escape") {
      event.preventDefault();
      closeOpenPopups();
      return;
    }

    if (isQuickActionsOpen) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const direction = event.key === "ArrowDown" ? 1 : -1;
        setQuickActionIndex((index) => {
          const count = quickActionMatches.length;
          if (count === 0) return 0;
          return (index + direction + count) % count;
        });
        return;
      }

      if ((event.key === "Enter" || event.key === "Tab") && !event.shiftKey) {
        const action = quickActionMatches[quickActionIndex] ?? quickActionMatches[0];
        if (action) {
          event.preventDefault();
          runQuickAction(action);
          return;
        }
      }
    }

    if (event.key !== "Enter" || event.shiftKey) return;
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    event.preventDefault();
    if (!inputDisabled && canSend) onSend();
  };

  const handleComposerChange = (event: React.ChangeEvent<HTMLTextAreaElement>) => {
    const nextValue = event.target.value;
    onChange(nextValue);
    syncInputDrivenPopups(nextValue, event.target.selectionStart ?? nextValue.length);
  };

  const handleComposerSelection = (event: React.SyntheticEvent<HTMLTextAreaElement>) => {
    const currentValue = event.currentTarget.value;
    syncInputDrivenPopups(currentValue, event.currentTarget.selectionStart ?? currentValue.length);
  };

  const handleAttachChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files || []);
    event.target.value = "";
    if (files.length === 0) return;
    void onAttachFiles(files);
  };

  return (
    <div className="shrink-0 border-t border-[#e5e7eb] bg-white px-5 pt-3 pb-[92px] md:px-8 lg:pb-5">
      <div className="mx-auto max-w-4xl rounded-xl border border-[#d7dce3] bg-white p-2 shadow-[0_10px_30px_rgba(23,26,31,0.06)] transition-colors focus-within:border-[#aab4c2]">
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="hidden"
          onChange={handleAttachChange}
          disabled={inputDisabled}
        />
        <textarea
          ref={textareaRef}
          value={value}
          onChange={handleComposerChange}
          onKeyDown={handleKeyDown}
          onKeyUp={handleComposerSelection}
          onSelect={handleComposerSelection}
          disabled={inputDisabled}
          rows={1}
          placeholder={
            isGenerating
              ? "Codex is working..."
              : isBlocked
                ? "Draft your next message..."
                : hasSession
                  ? "Ask Codex anything about your codebase..."
                  : "Ask Codex anything about your codebase..."
          }
          className="session-composer-input max-h-[220px] min-h-[46px] w-full resize-none bg-transparent px-2 py-2 text-[14px] leading-6 text-[#0d0d0d] outline-none placeholder:text-[#8b8f94] disabled:opacity-60"
        />
        {pendingFiles.length > 0 && (
          <div className="flex flex-wrap gap-1.5 px-1 pb-2">
            {pendingFiles.map((file) => (
              <span
                key={file.path}
                className="inline-flex max-w-[240px] items-center gap-1.5 rounded-md border border-[#d7dce3] bg-[#f7f8fa] px-2 py-1 text-xs text-[#374151]"
                title={file.path}
              >
                <FileText size={13} className="shrink-0 text-[#6b7280]" />
                <span className="truncate">{file.name}</span>
                <button
                  type="button"
                  aria-label={`Remove ${file.name}`}
                  title={`Remove ${file.name}`}
                  onClick={() => onRemovePendingFile(file.path)}
                  className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded text-[#6b7280] hover:bg-[#e5e7eb] hover:text-[#0d0d0d]"
                >
                  <X size={11} />
                </button>
              </span>
            ))}
          </div>
        )}
        <div className="flex items-center justify-between gap-2 pt-1">
          <div className="flex items-center gap-1">
            <div ref={quickActionsRef} className="relative">
              {isQuickActionsOpen && (
                <div className="absolute bottom-full left-0 z-30 mb-2 w-52 overflow-hidden rounded-lg border border-[#e5e7eb] bg-white shadow-lg">
                  {quickActionMatches.map((action, index) => (
                    <button
                      key={action.id}
                      type="button"
                      onClick={() => runQuickAction(action)}
                      className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-[#0d0d0d] hover:bg-[#f7f8fa] ${
                        index === quickActionIndex ? "bg-[#f7f8fa]" : ""
                      }`}
                    >
                      <Trash2 size={14} className="text-[#6b7280]" />
                      <span className="font-[family-name:var(--font-mono)] text-xs">
                        /{action.command}
                      </span>
                      <span className="text-xs text-[#6b7280]">{action.label}</span>
                    </button>
                  ))}
                </div>
              )}

              <button
                type="button"
                aria-label="Attach files"
                title="Attach files"
                onClick={() => fileInputRef.current?.click()}
                disabled={inputDisabled}
                className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-[#e5e7eb] bg-white text-[#374151] hover:bg-[#f7f8fa] hover:text-[#0d0d0d] disabled:cursor-not-allowed disabled:opacity-50"
              >
                <Paperclip size={15} />
              </button>
            </div>
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
            {isGenerating || isBlocked ? (
              <button
                type="button"
                onClick={onStop}
                aria-label="Stop generation"
                title={isBlocked ? "Stop running session" : "Stop generation"}
                className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-[#cf222e]/25 bg-[#ffebe9] text-[#cf222e] hover:bg-[#ffd7d5]"
              >
                <Square size={13} fill="currentColor" />
              </button>
            ) : (
              <button
                type="button"
                onClick={onSend}
                disabled={!canSend || sendDisabled}
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
