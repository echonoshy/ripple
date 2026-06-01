"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  BrainCircuit,
  FileText,
  FolderGit2,
  Image as ImageIcon,
  Loader2,
  Paperclip,
  Send,
  Square,
  Trash2,
  X,
} from "lucide-react";
import type { ChatFileRef } from "@/lib/chatInput";
import {
  getQuickActionMatches,
  getSlashCommandTrigger,
  type QuickAction,
} from "@/lib/composerTriggers";
import { shouldApplyInputFocus } from "@/lib/inputFocus";
import { formatModelName } from "@/lib/models";
import {
  filesFromClipboardData,
  partitionTransferFiles,
  type PendingImageSource,
  type PendingLocalImage,
} from "@/lib/pendingImages";
import WorkspaceFolderPicker from "./WorkspaceFolderPicker";
import { LUCIDE_STANDARD_STROKE_WIDTH } from "./stylePrimitives";

interface SessionComposerProps {
  userId?: string;
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  onStop: () => void;
  onClearContext: () => void;
  onCompactContext: () => void;
  onAttachFiles: (files: File[]) => void | Promise<void>;
  onRemovePendingFile: (path: string) => void;
  onAddPendingImages: (files: File[], source: PendingImageSource) => void;
  onRemovePendingLocalImage: (id: string) => void;
  pendingFiles: ChatFileRef[];
  pendingLocalImages: PendingLocalImage[];
  isUploadingFiles?: boolean;
  uploadError?: string | null;
  isGenerating: boolean;
  isBlocked?: boolean;
  hasSession: boolean;
  focusToken: number;
  selectedModel: string;
  models: { id: string; owned_by: string }[];
  isModelDropdownOpen: boolean;
  onToggleModelDropdown: () => void;
  onSelectModel: (model: string) => void;
  contextFolderPath?: string | null;
  workspaceScopeLabel?: string;
  workspaceScopePath?: string;
  onSelectWorkspaceFolder?: (path: string) => void | Promise<void>;
}

type QuickActionsState = {
  query: string;
  key: string;
};

export function shouldExpandComposer(value: string, isComposerFocused: boolean): boolean {
  return isComposerFocused || value.trim().length > 0;
}

export function composerToolbarClassName(isExpandedComposer: boolean): string {
  return `flex h-10 shrink-0 items-center sm:h-8 ${
    isExpandedComposer ? "col-start-1 row-start-2" : "-mr-1 sm:mb-[2px]"
  }`;
}

export default function SessionComposer({
  userId,
  value,
  onChange,
  onSend,
  onStop,
  onClearContext,
  onCompactContext,
  onAttachFiles,
  onRemovePendingFile,
  onAddPendingImages,
  onRemovePendingLocalImage,
  pendingFiles,
  pendingLocalImages,
  isUploadingFiles = false,
  uploadError = null,
  isGenerating,
  isBlocked = false,
  hasSession,
  focusToken,
  selectedModel,
  models,
  isModelDropdownOpen,
  onToggleModelDropdown,
  onSelectModel,
  contextFolderPath = null,
  workspaceScopeLabel = "Workspace",
  workspaceScopePath = "/workspace",
  onSelectWorkspaceFolder,
}: SessionComposerProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const quickActionsRef = useRef<HTMLDivElement>(null);
  const modelDropdownRef = useRef<HTMLDivElement>(null);
  const folderPickerRef = useRef<HTMLDivElement>(null);
  const [quickActionsState, setQuickActionsState] = useState<QuickActionsState | null>(null);
  const [dismissedSlashKey, setDismissedSlashKey] = useState<string | null>(null);
  const [quickActionIndex, setQuickActionIndex] = useState(0);
  const [isComposerFocused, setIsComposerFocused] = useState(false);
  const [isFolderPickerOpen, setIsFolderPickerOpen] = useState(false);
  const canSend = Boolean(value.trim() || pendingFiles.length > 0 || pendingLocalImages.length > 0);
  const inputDisabled = isGenerating;
  const attachDisabled = inputDisabled || isUploadingFiles;
  const sendDisabled = isGenerating || isBlocked || isUploadingFiles;
  const hasFocusFolder = Boolean(contextFolderPath);
  const folderButtonTitle = hasFocusFolder
    ? `Focus folder: ${workspaceScopeLabel}`
    : "Set focus folder";
  const isQuickActionsOpen = quickActionsState !== null;
  const availableModels = useMemo(
    () => (models.length > 0 ? models : [{ id: selectedModel, owned_by: "ripple" }]),
    [models, selectedModel]
  );
  const quickActionMatches = useMemo(
    () => getQuickActionMatches(quickActionsState?.query ?? ""),
    [quickActionsState?.query]
  );
  const isExpandedComposer = shouldExpandComposer(value, isComposerFocused);

  const adjustHeight = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 180)}px`;
  }, []);

  useEffect(() => {
    adjustHeight();
  }, [value, isExpandedComposer, adjustHeight]);

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

  useEffect(() => {
    if (!isFolderPickerOpen) return;

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (folderPickerRef.current?.contains(target)) return;
      setIsFolderPickerOpen(false);
    };

    document.addEventListener("pointerdown", handlePointerDown, true);
    return () => document.removeEventListener("pointerdown", handlePointerDown, true);
  }, [isFolderPickerOpen]);

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

  const handlePaste = (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    if (attachDisabled) return;
    const files = filesFromClipboardData(event.clipboardData);
    if (files.length === 0) return;
    const { images, attachments: attachmentFiles } = partitionTransferFiles(files);
    if (images.length === 0 && attachmentFiles.length === 0) return;

    event.preventDefault();
    closeOpenPopups(false);
    if (images.length > 0) onAddPendingImages(images, "paste");
    if (attachmentFiles.length > 0) void onAttachFiles(attachmentFiles);
  };

  const handleComposerBlur = (event: React.FocusEvent<HTMLDivElement>) => {
    const nextFocusedElement = event.relatedTarget;
    if (nextFocusedElement instanceof Node && event.currentTarget.contains(nextFocusedElement)) {
      return;
    }
    setIsComposerFocused(false);
  };

  const toolbarControls = (
    <div className={composerToolbarClassName(isExpandedComposer)}>
      {onSelectWorkspaceFolder && (
        <div ref={folderPickerRef} className="relative flex shrink-0 items-center">
          <button
            type="button"
            data-ripple-composer-folder-button
            aria-label="Set focus folder"
            aria-pressed={hasFocusFolder}
            title={folderButtonTitle}
            onClick={() => {
              setQuickActionsState(null);
              if (isModelDropdownOpen) onToggleModelDropdown();
              setIsFolderPickerOpen((open) => !open);
            }}
            className={`inline-flex h-10 w-10 items-center justify-center rounded-full hover:bg-[#f3f4f6] hover:text-[#111827] active:bg-[#eef3ff] sm:h-8 sm:w-8 ${
              hasFocusFolder ? "bg-[#eef4ff] text-[#2463eb]" : "text-[#4b5563]"
            }`}
          >
            <FolderGit2 size={16} strokeWidth={LUCIDE_STANDARD_STROKE_WIDTH} />
          </button>
          {isFolderPickerOpen && (
            <WorkspaceFolderPicker
              userId={userId}
              contextFolderPath={contextFolderPath}
              onSelectFolder={onSelectWorkspaceFolder}
              onClose={() => setIsFolderPickerOpen(false)}
            />
          )}
          <span className="sr-only">{workspaceScopePath}</span>
        </div>
      )}
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
          disabled={attachDisabled}
          className="inline-flex h-10 w-10 items-center justify-center rounded-full text-[#4b5563] hover:bg-[#f3f4f6] hover:text-[#111827] active:bg-[#eef3ff] disabled:cursor-not-allowed disabled:opacity-50 sm:h-8 sm:w-8"
        >
          {isUploadingFiles ? (
            <Loader2 size={15} className="animate-spin" />
          ) : (
            <Paperclip size={16} strokeWidth={LUCIDE_STANDARD_STROKE_WIDTH} />
          )}
        </button>
      </div>
      <div ref={modelDropdownRef} className="relative flex shrink-0 items-center">
        <button
          type="button"
          aria-label="Select model"
          title={`Model: ${formatModelName(selectedModel)}`}
          onClick={() => {
            setIsFolderPickerOpen(false);
            onToggleModelDropdown();
          }}
          className="inline-flex h-10 w-10 items-center justify-center rounded-full text-[#4b5563] hover:bg-[#f3f4f6] hover:text-[#111827] active:bg-[#eef3ff] sm:h-8 sm:w-8"
        >
          <BrainCircuit size={16} strokeWidth={LUCIDE_STANDARD_STROKE_WIDTH} />
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
                    selectedModel === model.id ? "bg-[#eef3ff] text-[#2457e6]" : "text-[#111827]"
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
  );

  const composerInput = (
    <textarea
      ref={textareaRef}
      value={value}
      onChange={handleComposerChange}
      onKeyDown={handleKeyDown}
      onKeyUp={handleComposerSelection}
      onSelect={handleComposerSelection}
      onFocus={() => setIsComposerFocused(true)}
      onPaste={handlePaste}
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
      className={`session-composer-input mb-[2px] max-h-[104px] min-h-9 min-w-0 resize-none bg-transparent px-1.5 py-2 text-[14px] leading-5 text-[#111827] outline-none placeholder:text-[13px] placeholder:text-[#9aa3af] disabled:opacity-60 sm:mb-0 sm:max-h-[180px] sm:min-h-[36px] sm:px-2 sm:py-1.5 sm:text-[14px] sm:leading-6 sm:placeholder:text-[#8b8f94] ${
        isExpandedComposer ? "col-span-2 row-start-1 w-full" : "flex-1"
      }`}
    />
  );

  const sendControl =
    isGenerating || isBlocked ? (
      <button
        type="button"
        onClick={onStop}
        aria-label="Stop generation"
        title={isBlocked ? "Stop running session" : "Stop generation"}
        className={`inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-[#cf222e]/20 bg-[#ffebe9] text-[#cf222e] shadow-[0_8px_18px_rgba(207,34,46,0.10)] hover:bg-[#ffd7d5] sm:h-8 sm:w-8 ${
          isExpandedComposer ? "col-start-2 row-start-2 justify-self-end" : "sm:mb-[2px]"
        }`}
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
        className={`inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-[#4067ff]/20 bg-[linear-gradient(135deg,#2f6bff,#7b5cff)] text-white shadow-[0_10px_22px_rgba(64,92,255,0.30)] disabled:cursor-not-allowed disabled:border-[#dfe6f4] disabled:bg-[#f3f6fb] disabled:bg-none disabled:text-[#9aa3af] disabled:shadow-none sm:h-8 sm:w-8 ${
          isExpandedComposer ? "col-start-2 row-start-2 justify-self-end" : "sm:mb-[2px]"
        }`}
      >
        <Send size={14} />
      </button>
    );

  return (
    <div className="shrink-0 border-t border-[#e8edf7] bg-white/76 px-3 pt-1 pb-[max(env(safe-area-inset-bottom),8px)] shadow-[0_-14px_32px_rgba(44,63,123,0.08)] backdrop-blur-2xl sm:px-4 sm:pt-2 md:px-6 lg:pb-[max(env(safe-area-inset-bottom),12px)]">
      <div className="mx-auto max-w-4xl rounded-2xl border border-[#dfe6f4] bg-white/92 p-1.5 shadow-[0_12px_30px_rgba(44,63,123,0.12)] transition-colors focus-within:border-[#8da0ff] sm:p-1.5">
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="hidden"
          onChange={handleAttachChange}
          disabled={attachDisabled}
        />
        <div
          data-composer-expanded={isExpandedComposer ? "true" : "false"}
          data-composer-layout={isExpandedComposer ? "stacked" : "inline"}
          onBlur={handleComposerBlur}
          className={
            isExpandedComposer
              ? "grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-1.5 gap-y-1"
              : "flex items-end gap-1.5"
          }
        >
          {toolbarControls}
          {composerInput}
          {sendControl}
        </div>
        {pendingLocalImages.length > 0 && (
          <div className="flex flex-wrap gap-2 px-1 pt-1 pb-2">
            {pendingLocalImages.map((image) => (
              <span
                key={image.id}
                className="group relative inline-flex h-16 w-16 shrink-0 overflow-hidden rounded-lg border border-[#dfe6f4] bg-[#f6f8ff]"
                title={image.name}
              >
                {image.previewUrl ? (
                  <img
                    src={image.previewUrl}
                    alt={image.name}
                    className="h-full w-full object-cover"
                  />
                ) : (
                  <span className="flex h-full w-full items-center justify-center text-[#6b7280]">
                    <ImageIcon size={18} />
                  </span>
                )}
                <button
                  type="button"
                  aria-label={`Remove ${image.name}`}
                  title={`Remove ${image.name}`}
                  onClick={() => onRemovePendingLocalImage(image.id)}
                  className="absolute top-1 right-1 inline-flex h-5 w-5 items-center justify-center rounded-full bg-white/92 text-[#384152] shadow-[0_2px_8px_rgba(15,23,42,0.16)] hover:bg-[#ffebe9] hover:text-[#cf222e]"
                >
                  <X size={12} />
                </button>
              </span>
            ))}
          </div>
        )}
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
        {(isUploadingFiles || uploadError) && (
          <div
            className={`flex min-w-0 items-start gap-1.5 px-2 pt-1 pb-2 text-[11px] ${
              uploadError ? "text-[#cf222e]" : "text-[#57606a]"
            }`}
          >
            {isUploadingFiles ? (
              <Loader2 size={13} className="mt-0.5 shrink-0 animate-spin" />
            ) : (
              <AlertTriangle size={13} className="mt-0.5 shrink-0" />
            )}
            <span className="min-w-0 break-words">
              {isUploadingFiles ? "Uploading files" : uploadError}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
