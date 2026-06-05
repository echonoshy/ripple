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
  X,
} from "lucide-react";
import { useI18n } from "@/i18n";
import type { ChatFileRef } from "@/lib/chatInput";
import { shouldApplyInputFocus } from "@/lib/inputFocus";
import { formatModelName } from "@/lib/models";
import {
  filesFromClipboardData,
  partitionTransferFiles,
  type PendingImageSource,
  type PendingLocalImage,
} from "@/lib/pendingImages";
import WorkspaceFolderPicker from "./WorkspaceFolderPicker";
import {
  LUCIDE_STANDARD_STROKE_WIDTH,
  TYPOGRAPHY_META_CLASS,
  TYPOGRAPHY_MICRO_CLASS,
  TYPOGRAPHY_MOBILE_BODY_CLASS,
} from "./stylePrimitives";

interface SessionComposerProps {
  userId?: string;
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  onStop: () => void;
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
  onFocusStateChange?: (focused: boolean) => void;
}

export function shouldExpandComposer(value: string, isComposerFocused: boolean): boolean {
  return isComposerFocused || value.trim().length > 0;
}

export function composerToolbarClassName(isExpandedComposer: boolean): string {
  return `flex h-11 shrink-0 items-center lg:h-8 ${
    isExpandedComposer ? "col-start-1 row-start-2" : "-mr-1 lg:mb-[2px]"
  }`;
}

export default function SessionComposer({
  userId,
  value,
  onChange,
  onSend,
  onStop,
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
  workspaceScopeLabel,
  workspaceScopePath = "/workspace",
  onSelectWorkspaceFolder,
  onFocusStateChange,
}: SessionComposerProps) {
  const { t } = useI18n();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const lastAppliedFocusTokenRef = useRef(focusToken);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const modelDropdownRef = useRef<HTMLDivElement>(null);
  const folderPickerRef = useRef<HTMLDivElement>(null);
  const [isComposerFocused, setIsComposerFocused] = useState(false);
  const [isFolderPickerOpen, setIsFolderPickerOpen] = useState(false);
  const canSend = Boolean(value.trim() || pendingFiles.length > 0 || pendingLocalImages.length > 0);
  const inputDisabled = isGenerating;
  const attachDisabled = inputDisabled || isUploadingFiles;
  const sendDisabled = isGenerating || isBlocked || isUploadingFiles;
  const hasFocusFolder = Boolean(contextFolderPath);
  const effectiveWorkspaceScopeLabel = workspaceScopeLabel || t("files.workspaceName");
  const folderButtonTitle = hasFocusFolder
    ? t("composer.focusFolder", { label: effectiveWorkspaceScopeLabel })
    : t("composer.setFocusFolder");
  const availableModels = useMemo(
    () => (models.length > 0 ? models : [{ id: selectedModel, owned_by: "ripple" }]),
    [models, selectedModel]
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
    if (focusToken <= lastAppliedFocusTokenRef.current) return;
    if (!shouldApplyInputFocus(focusToken, inputDisabled)) return;
    textareaRef.current?.focus();
    lastAppliedFocusTokenRef.current = focusToken;
  }, [focusToken, inputDisabled]);

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

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter" || event.shiftKey) return;
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    event.preventDefault();
    if (!inputDisabled && canSend) onSend();
  };

  const handleComposerChange = (event: React.ChangeEvent<HTMLTextAreaElement>) => {
    const nextValue = event.target.value;
    onChange(nextValue);
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
    if (images.length > 0) onAddPendingImages(images, "paste");
    if (attachmentFiles.length > 0) void onAttachFiles(attachmentFiles);
  };

  const handleComposerBlur = (event: React.FocusEvent<HTMLDivElement>) => {
    const nextFocusedElement = event.relatedTarget;
    if (nextFocusedElement instanceof Node && event.currentTarget.contains(nextFocusedElement)) {
      return;
    }
    setIsComposerFocused(false);
    onFocusStateChange?.(false);
  };

  const toolbarControls = (
    <div className={composerToolbarClassName(isExpandedComposer)}>
      {onSelectWorkspaceFolder && (
        <div ref={folderPickerRef} className="relative flex shrink-0 items-center">
          <button
            type="button"
            data-ripple-composer-folder-button
            aria-label={t("composer.setFocusFolder")}
            aria-pressed={hasFocusFolder}
            title={folderButtonTitle}
            onClick={() => {
              if (isModelDropdownOpen) onToggleModelDropdown();
              setIsFolderPickerOpen((open) => !open);
            }}
            className={`inline-flex h-11 w-11 items-center justify-center rounded-full hover:bg-[#F5F6F7] hover:text-[#1F2329] active:bg-[#F0F5FF] lg:h-8 lg:w-8 ${
              hasFocusFolder ? "bg-[#F0F5FF] text-[#1456F0]" : "text-[#2B2F36]"
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
      <div className="relative flex items-center">
        <button
          type="button"
          aria-label={t("composer.attachFiles")}
          title={t("composer.attachFiles")}
          onClick={() => fileInputRef.current?.click()}
          disabled={attachDisabled}
          className="inline-flex h-11 w-11 items-center justify-center rounded-full text-[#2B2F36] hover:bg-[#F5F6F7] hover:text-[#1F2329] active:bg-[#F0F5FF] disabled:cursor-not-allowed disabled:opacity-50 lg:h-8 lg:w-8"
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
          aria-label={t("composer.selectModel")}
          title={t("composer.modelTitle", { model: formatModelName(selectedModel) })}
          onClick={() => {
            setIsFolderPickerOpen(false);
            onToggleModelDropdown();
          }}
          className="inline-flex h-11 w-11 items-center justify-center rounded-full text-[#2B2F36] hover:bg-[#F5F6F7] hover:text-[#1F2329] active:bg-[#F0F5FF] lg:h-8 lg:w-8"
        >
          <BrainCircuit size={16} strokeWidth={LUCIDE_STANDARD_STROKE_WIDTH} />
        </button>
        {isModelDropdownOpen && (
          <div className="absolute bottom-full left-0 z-30 mb-2 w-48 overflow-hidden rounded-2xl border border-[#DEE0E3] bg-white/94 shadow-[0_14px_34px_rgba(31,35,41,0.16)] backdrop-blur-2xl">
            <div className="p-1">
              {availableModels.map((model) => (
                <button
                  key={model.id}
                  type="button"
                  onClick={() => onSelectModel(model.id)}
                  className={`flex w-full items-center rounded-xl px-3 py-2 text-left font-[family-name:var(--font-mono)] ${TYPOGRAPHY_META_CLASS} hover:bg-[#F5F6F7] ${
                    selectedModel === model.id ? "bg-[#F0F5FF] text-[#1456F0]" : "text-[#1F2329]"
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
      onFocus={() => {
        setIsComposerFocused(true);
        onFocusStateChange?.(true);
      }}
      onPaste={handlePaste}
      disabled={inputDisabled}
      rows={1}
      placeholder={
        isGenerating
          ? t("composer.working")
          : isBlocked
            ? t("composer.draftNextMessage")
            : hasSession
              ? t("composer.askAnything")
              : t("composer.askAnything")
      }
      className={`session-composer-input mb-[2px] max-h-[104px] min-h-10 min-w-0 resize-none bg-transparent px-1.5 py-2 ${TYPOGRAPHY_MOBILE_BODY_CLASS} text-[#1F2329] [-ms-overflow-style:none] [scrollbar-width:none] outline-none placeholder:text-[15px] placeholder:text-[#8F959E] disabled:opacity-60 [&::-webkit-scrollbar]:hidden [&::-webkit-scrollbar]:h-0 [&::-webkit-scrollbar]:w-0 lg:mb-0 lg:max-h-[180px] lg:min-h-[36px] lg:px-2 lg:py-1.5 lg:text-[14px] lg:leading-[22px] lg:placeholder:text-[#8F959E] ${
        isExpandedComposer ? "col-span-2 row-start-1 w-full" : "flex-1"
      }`}
    />
  );

  const sendControl =
    isGenerating || isBlocked ? (
      <button
        type="button"
        onClick={onStop}
        aria-label={t("composer.stopGeneration")}
        title={isBlocked ? t("composer.stopRunningSession") : t("composer.stopGeneration")}
        className={`inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full border border-[#B42318]/20 bg-[#FFF1F0] text-[#B42318] shadow-[0_8px_18px_rgba(180,35,24,0.10)] hover:bg-[#FFE3E0] lg:h-8 lg:w-8 ${
          isExpandedComposer ? "col-start-2 row-start-2 justify-self-end" : "lg:mb-[2px]"
        }`}
      >
        <Square size={13} fill="currentColor" />
      </button>
    ) : (
      <button
        type="button"
        onClick={onSend}
        disabled={!canSend || sendDisabled}
        aria-label={t("composer.sendMessage")}
        title={t("composer.sendMessage")}
        className={`inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full border border-[#1456F0]/20 bg-[#1456F0] text-white shadow-[0_10px_22px_rgba(20,86,240,0.26)] hover:bg-[#0F4BD8] disabled:cursor-not-allowed disabled:border-[#DEE0E3] disabled:bg-[#F5F6F7] disabled:bg-none disabled:text-[#8F959E] disabled:shadow-none lg:h-8 lg:w-8 ${
          isExpandedComposer ? "col-start-2 row-start-2 justify-self-end" : "lg:mb-[2px]"
        }`}
      >
        <Send size={14} />
      </button>
    );

  return (
    <div className="shrink-0 border-t border-[#DEE0E3]/70 bg-white/76 px-3 pt-1 pb-[max(env(safe-area-inset-bottom),8px)] shadow-[0_-14px_32px_rgba(31,35,41,0.08)] backdrop-blur-2xl sm:px-4 sm:pt-2 md:px-6 lg:pb-[max(env(safe-area-inset-bottom),12px)]">
      <div className="mx-auto max-w-4xl rounded-[22px] border border-[#DEE0E3] bg-white/92 p-1.5 shadow-[0_12px_30px_rgba(31,35,41,0.10)] transition-colors focus-within:border-[#1456F0] sm:p-1.5">
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
                className="group relative inline-flex h-16 w-16 shrink-0 overflow-hidden rounded-xl border border-[#DEE0E3] bg-[#F5F6F7]"
                title={image.name}
              >
                {image.previewUrl ? (
                  <img
                    src={image.previewUrl}
                    alt={image.name}
                    className="h-full w-full object-cover"
                  />
                ) : (
                  <span className="flex h-full w-full items-center justify-center text-[#646A73]">
                    <ImageIcon size={18} />
                  </span>
                )}
                <button
                  type="button"
                  aria-label={t("composer.removeItem", { name: image.name })}
                  title={t("composer.removeItem", { name: image.name })}
                  onClick={() => onRemovePendingLocalImage(image.id)}
                  className="absolute top-1 right-1 inline-flex h-5 w-5 items-center justify-center rounded-full bg-white/92 text-[#2B2F36] shadow-[0_2px_8px_rgba(15,23,42,0.16)] hover:bg-[#FFF1F0] hover:text-[#B42318]"
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
                className={`inline-flex max-w-[240px] items-center gap-1.5 rounded-full border border-[#DEE0E3] bg-[#F5F6F7] px-2 py-1 ${TYPOGRAPHY_MICRO_CLASS} text-[#2B2F36]`}
                title={file.path}
              >
                <FileText size={13} className="shrink-0 text-[#646A73]" />
                <span className="truncate">{file.name}</span>
                <button
                  type="button"
                  aria-label={t("composer.removeItem", { name: file.name })}
                  title={t("composer.removeItem", { name: file.name })}
                  onClick={() => onRemovePendingFile(file.path)}
                  className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[#646A73] hover:bg-[#EFF0F1] hover:text-[#1F2329]"
                >
                  <X size={11} />
                </button>
              </span>
            ))}
          </div>
        )}
        {(isUploadingFiles || uploadError) && (
          <div
            className={`flex min-w-0 items-start gap-1.5 px-2 pt-1 pb-2 ${TYPOGRAPHY_MICRO_CLASS} ${
              uploadError ? "text-[#B42318]" : "text-[#646A73]"
            }`}
          >
            {isUploadingFiles ? (
              <Loader2 size={13} className="mt-0.5 shrink-0 animate-spin" />
            ) : (
              <AlertTriangle size={13} className="mt-0.5 shrink-0" />
            )}
            <span className="min-w-0 break-words">
              {isUploadingFiles ? t("composer.uploadingFiles") : uploadError}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
