"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FileText, Paperclip, Send, Sparkles, Square, Trash2, X } from "lucide-react";
import type { ChatFileRef } from "@/lib/chatInput";
import {
  getQuickActionMatches,
  getSlashCommandTrigger,
  type QuickAction,
} from "@/lib/composerTriggers";
import { shouldApplyInputFocus } from "@/lib/inputFocus";
import { formatModelName } from "@/lib/models";

interface SessionComposerProps {
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  onStop: () => void;
  onClearContext: () => void;
  onCompactContext: () => void;
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
  onCompactContext,
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
  const modelDropdownRef = useRef<HTMLDivElement>(null);
  const [quickActionsState, setQuickActionsState] = useState<QuickActionsState | null>(null);
  const [dismissedSlashKey, setDismissedSlashKey] = useState<string | null>(null);
  const [quickActionIndex, setQuickActionIndex] = useState(0);
  const canSend = Boolean(value.trim() || pendingFiles.length > 0);
  const inputDisabled = isGenerating;
  const sendDisabled = isGenerating || isBlocked;
  const isQuickActionsOpen = quickActionsState !== null;
  const availableModels = useMemo(
    () => (models.length > 0 ? models : [{ id: selectedModel, owned_by: "ripple" }]),
    [models, selectedModel]
  );
  const quickActionMatches = useMemo(
    () => getQuickActionMatches(quickActionsState?.query ?? ""),
    [quickActionsState?.query]
  );

  const adjustHeight = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 180)}px`;
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

  useEffect(() => {
    if (!isModelDropdownOpen) return;

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (modelDropdownRef.current?.contains(target)) return;
      onToggleModelDropdown();
    };

    document.addEventListener("pointerdown", handlePointerDown, true);
    return () => document.removeEventListener("pointerdown", handlePointerDown, true);
  }, [onToggleModelDropdown, isModelDropdownOpen]);

  const runQuickAction = useCallback(
    (action: QuickAction) => {
      setQuickActionsState(null);

      if (action.id === "clear") {
        onChange("");
        onClearContext();
        requestAnimationFrame(() => textareaRef.current?.focus());
        return;
      }
      if (action.id === "compact") {
        onChange("");
        onCompactContext();
        requestAnimationFrame(() => textareaRef.current?.focus());
      }
    },
    [onChange, onClearContext, onCompactContext]
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
    <div className="shrink-0 border-t border-[#e8edf7] bg-white/76 px-3 pt-1 pb-[max(env(safe-area-inset-bottom),8px)] shadow-[0_-14px_32px_rgba(44,63,123,0.08)] backdrop-blur-2xl sm:px-4 sm:pt-2 md:px-6 lg:pb-[max(env(safe-area-inset-bottom),12px)]">
      <div className="mx-auto max-w-4xl rounded-[20px] border border-[#dfe6f4] bg-white/92 p-1.5 shadow-[0_12px_30px_rgba(44,63,123,0.12)] transition-colors focus-within:border-[#8da0ff] sm:rounded-2xl sm:p-1.5">
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="hidden"
          onChange={handleAttachChange}
          disabled={inputDisabled}
        />
        <div className="flex items-end gap-1.5">
          <div className="-mr-1 flex h-10 shrink-0 items-center sm:mb-[2px] sm:h-8">
            <div ref={quickActionsRef} className="relative flex items-center">
              {isQuickActionsOpen && (
                <div className="absolute bottom-full left-0 z-30 mb-2 w-52 overflow-hidden rounded-xl border border-[#dfe6f4] bg-white shadow-[0_14px_34px_rgba(44,63,123,0.14)]">
                  {quickActionMatches.map((action, index) => (
                    <button
                      key={action.id}
                      type="button"
                      onClick={() => runQuickAction(action)}
                      className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-[#111827] hover:bg-[#f7f8fa] ${
                        index === quickActionIndex ? "bg-[#eef3ff]" : ""
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
                className="inline-flex h-10 w-10 items-center justify-center rounded-full text-[#4b5563] hover:bg-[#f3f4f6] hover:text-[#111827] active:bg-[#eef3ff] disabled:cursor-not-allowed disabled:opacity-50 sm:h-8 sm:w-8"
              >
                <Paperclip size={15} />
              </button>
            </div>
            <div ref={modelDropdownRef} className="relative flex shrink-0 items-center">
              <button
                type="button"
                aria-label="Select model"
                title={`Model: ${formatModelName(selectedModel)}`}
                onClick={onToggleModelDropdown}
                className="inline-flex h-10 w-10 items-center justify-center rounded-full text-[#4b5563] hover:bg-[#f3f4f6] hover:text-[#111827] active:bg-[#eef3ff] sm:h-8 sm:w-8"
              >
                <Sparkles size={15} />
              </button>
              {isModelDropdownOpen && (
                <div className="absolute bottom-full left-0 z-30 mb-2 w-48 overflow-hidden rounded-xl border border-[#dfe6f4] bg-white shadow-[0_14px_34px_rgba(44,63,123,0.14)]">
                  <div className="p-1">
                    {availableModels.map((model) => (
                      <button
                        key={model.id}
                        type="button"
                        onClick={() => onSelectModel(model.id)}
                        className={`flex w-full items-center rounded px-3 py-2 text-left font-[family-name:var(--font-mono)] text-xs hover:bg-[#f7f8fa] ${
                          selectedModel === model.id
                            ? "bg-[#eef3ff] text-[#2457e6]"
                            : "text-[#111827]"
                        }`}
                      >
                        {formatModelName(model.id)}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
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
                ? "Working..."
                : isBlocked
                  ? "Draft your next message..."
                  : hasSession
                    ? "Ask anything..."
                    : "Ask anything..."
            }
            className="session-composer-input mb-[2px] max-h-[104px] min-h-9 min-w-0 flex-1 resize-none bg-transparent px-1.5 py-2 text-[16px] leading-5 text-[#111827] outline-none placeholder:text-[14px] placeholder:text-[#9aa3af] disabled:opacity-60 sm:mb-0 sm:max-h-[180px] sm:min-h-[36px] sm:w-full sm:px-2 sm:py-1.5 sm:text-[14px] sm:leading-6 sm:placeholder:text-[#8b8f94]"
          />
          {isGenerating || isBlocked ? (
            <button
              type="button"
              onClick={onStop}
              aria-label="Stop generation"
              title={isBlocked ? "Stop running session" : "Stop generation"}
              className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-[#cf222e]/20 bg-[#ffebe9] text-[#cf222e] shadow-[0_8px_18px_rgba(207,34,46,0.10)] hover:bg-[#ffd7d5] sm:mb-[2px] sm:h-8 sm:w-8"
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
              className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-[#4067ff]/20 bg-[linear-gradient(135deg,#2f6bff,#7b5cff)] text-white shadow-[0_10px_22px_rgba(64,92,255,0.30)] disabled:cursor-not-allowed disabled:border-[#dfe6f4] disabled:bg-[#f3f6fb] disabled:bg-none disabled:text-[#9aa3af] disabled:shadow-none sm:mb-[2px] sm:h-8 sm:w-8"
            >
              <Send size={14} />
            </button>
          )}
        </div>
        {pendingFiles.length > 0 && (
          <div className="flex flex-wrap gap-1.5 px-1 pt-1 pb-2">
            {pendingFiles.map((file) => (
              <span
                key={file.path}
                className="inline-flex max-w-[240px] items-center gap-1.5 rounded-full border border-[#dfe6f4] bg-[#f6f8ff] px-2 py-1 text-[11px] text-[#384152]"
                title={file.path}
              >
                <FileText size={13} className="shrink-0 text-[#6b7280]" />
                <span className="truncate">{file.name}</span>
                <button
                  type="button"
                  aria-label={`Remove ${file.name}`}
                  title={`Remove ${file.name}`}
                  onClick={() => onRemovePendingFile(file.path)}
                  className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[#667085] hover:bg-[#e5e7eb] hover:text-[#111827]"
                >
                  <X size={11} />
                </button>
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
