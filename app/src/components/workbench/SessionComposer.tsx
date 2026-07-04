"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  AlertTriangle,
  Blocks,
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
import type { SkillInfo } from "@/types";
import {
  filesFromClipboardData,
  partitionTransferFiles,
  type PendingImageSource,
  type PendingLocalImage,
} from "@/lib/pendingImages";
import {
  getMeasuredViewportMenuPosition,
  getResponsiveMenuBottomInsetPx,
  type ViewportMenuAnchorRect,
} from "@/lib/menuPosition";
import WorkspaceFolderPicker from "./WorkspaceFolderPicker";
import { AgentDelegationComposerButton } from "./AgentDelegationControls";
import {
  LUCIDE_STANDARD_STROKE_WIDTH,
  TYPOGRAPHY_META_CLASS,
  TYPOGRAPHY_MICRO_CLASS,
  TYPOGRAPHY_MOBILE_BODY_CLASS,
  WORKBENCH_MENU_CLASS,
  WORKBENCH_MENU_ITEM_CLASS,
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
  onCloseModelDropdown: () => void;
  onSelectModel: (model: string) => void;
  contextFolderPath?: string | null;
  workspaceScopeLabel?: string;
  workspaceScopePath?: string;
  onSelectWorkspaceFolder?: (path: string) => void | Promise<void>;
  onFocusStateChange?: (focused: boolean) => void;
  availableSkills?: SkillInfo[];
  selectedRequiredSkillId?: string | null;
  isLoadingSkills?: boolean;
  onLoadSkills?: () => void | Promise<void>;
  onSelectRequiredSkill?: (skillId: string | null) => void;
  onCreateAgentDelegation?: () => void;
  canCreateAgentDelegation?: boolean;
}

export function shouldExpandComposer(value: string, isComposerFocused: boolean): boolean {
  return isComposerFocused || value.trim().length > 0;
}

export function composerToolbarClassName(isExpandedComposer: boolean): string {
  return `inline-flex h-11 shrink-0 items-center gap-1.5 lg:h-8 ${
    isExpandedComposer ? "col-start-1 row-start-2" : "lg:mb-[2px]"
  }`;
}

const COMPOSER_ICON_BUTTON_CLASS =
  "inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-transparent text-[#646A73] transition-colors hover:bg-[#F5F6F7] hover:text-[#1F2329] active:bg-[#EFF0F1] disabled:cursor-not-allowed disabled:opacity-40 lg:h-7 lg:w-7 lg:rounded-md";

const COMPOSER_ICON_BUTTON_ACTIVE_CLASS =
  "bg-[#F0F5FF] text-[#1456F0] shadow-[0_1px_2px_rgba(20,86,240,0.08)] hover:bg-[#E8F0FF] hover:text-[#1456F0] active:bg-[#DDE8FF]";

const COMPOSER_SEND_BUTTON_BASE_CLASS =
  "inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-transparent transition-colors focus-visible:ring-2 focus-visible:ring-[#BACEFD] focus-visible:outline-none disabled:cursor-not-allowed lg:h-8 lg:w-8 lg:rounded-lg";

const MODEL_MENU_WIDTH = 192;
const MODEL_MENU_ITEM_HEIGHT = 32;
const MODEL_MENU_VERTICAL_PADDING = 8;

function skillDisplayName(skill: SkillInfo): string {
  return skill.display_name || skill.name;
}

interface ModelMenuPosition {
  top: number;
  left: number;
  anchorRect: ViewportMenuAnchorRect;
  measuredHeight: number | null;
}

function modelMenuHeight(optionCount: number): number {
  return optionCount * MODEL_MENU_ITEM_HEIGHT + MODEL_MENU_VERTICAL_PADDING;
}

function rectToViewportAnchor(rect: DOMRect): ViewportMenuAnchorRect {
  return {
    top: rect.top,
    right: rect.right,
    bottom: rect.bottom,
    left: rect.left,
  };
}

function getComposerModelMenuPosition(
  anchorRect: ViewportMenuAnchorRect,
  optionCount: number,
  measuredHeight?: number | null
): ModelMenuPosition {
  const position = getMeasuredViewportMenuPosition({
    anchorRect,
    menuWidth: MODEL_MENU_WIDTH,
    estimatedMenuHeight: modelMenuHeight(optionCount),
    measuredMenuHeight: measuredHeight,
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight,
    bottomInset: getResponsiveMenuBottomInsetPx(),
    align: "left",
  });

  return {
    ...position,
    anchorRect,
    measuredHeight: measuredHeight ?? null,
  };
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
  onCloseModelDropdown,
  onSelectModel,
  contextFolderPath = null,
  workspaceScopeLabel,
  workspaceScopePath = "/workspace",
  onSelectWorkspaceFolder,
  onFocusStateChange,
  availableSkills = [],
  selectedRequiredSkillId = null,
  isLoadingSkills = false,
  onLoadSkills,
  onSelectRequiredSkill,
  onCreateAgentDelegation,
  canCreateAgentDelegation = false,
}: SessionComposerProps) {
  const { t } = useI18n();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const lastAppliedFocusTokenRef = useRef(focusToken);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const modelDropdownRef = useRef<HTMLDivElement>(null);
  const modelButtonRef = useRef<HTMLButtonElement>(null);
  const modelMenuRef = useRef<HTMLDivElement>(null);
  const skillDropdownRef = useRef<HTMLDivElement>(null);
  const skillMenuRef = useRef<HTMLDivElement>(null);
  const folderPickerRef = useRef<HTMLDivElement>(null);
  const touchSelectedModelRef = useRef<string | null>(null);
  const [isComposerFocused, setIsComposerFocused] = useState(false);
  const [isFolderPickerOpen, setIsFolderPickerOpen] = useState(false);
  const [isSkillMenuOpen, setIsSkillMenuOpen] = useState(false);
  const [modelMenuPosition, setModelMenuPosition] = useState<ModelMenuPosition | null>(null);
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
  const selectedRequiredSkill = availableSkills.find(
    (skill) => skill.id === selectedRequiredSkillId
  );
  const selectableSkills = availableSkills.filter(
    (skill) => skill.enabled && (skill.user_status === "available" || skill.status === "available")
  );
  const sendControlLayoutClass = isExpandedComposer
    ? "col-start-2 row-start-2 justify-self-end"
    : "lg:mb-[2px]";

  const updateModelMenuPosition = useCallback(
    (measuredHeight?: number | null) => {
      if (typeof window === "undefined") return null;
      const anchor = modelButtonRef.current?.getBoundingClientRect();
      if (!anchor) return null;
      const position = getComposerModelMenuPosition(
        rectToViewportAnchor(anchor),
        availableModels.length,
        measuredHeight
      );
      setModelMenuPosition(position);
      return position;
    },
    [availableModels.length]
  );

  const closeModelMenu = useCallback(() => {
    setModelMenuPosition(null);
    onCloseModelDropdown();
  }, [onCloseModelDropdown]);

  const closeSkillMenu = useCallback(() => {
    setIsSkillMenuOpen(false);
  }, []);

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
      if (modelDropdownRef.current && modelDropdownRef.current.getClientRects().length === 0)
        return;
      if (modelDropdownRef.current?.contains(target)) return;
      if (modelMenuRef.current?.contains(target)) return;
      closeModelMenu();
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeModelMenu();
    };

    const handleResize = () => closeModelMenu();

    document.addEventListener("pointerdown", handlePointerDown, true);
    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("resize", handleResize);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown, true);
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("resize", handleResize);
    };
  }, [closeModelMenu, isModelDropdownOpen]);

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

  useEffect(() => {
    if (!isSkillMenuOpen) return;

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (skillDropdownRef.current?.contains(target)) return;
      if (skillMenuRef.current?.contains(target)) return;
      closeSkillMenu();
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeSkillMenu();
    };

    document.addEventListener("pointerdown", handlePointerDown, true);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown, true);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [closeSkillMenu, isSkillMenuOpen]);

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

  const handleModelButtonClick = () => {
    setIsFolderPickerOpen(false);
    closeSkillMenu();
    if (isModelDropdownOpen) {
      closeModelMenu();
      return;
    }
    updateModelMenuPosition();
    onToggleModelDropdown();
  };

  const handleSkillButtonClick = () => {
    if (!onSelectRequiredSkill) return;
    setIsFolderPickerOpen(false);
    if (isModelDropdownOpen) closeModelMenu();
    if (!isSkillMenuOpen) void onLoadSkills?.();
    setIsSkillMenuOpen((open) => !open);
  };

  const handleModelOptionPointerDown = useCallback(
    (event: React.PointerEvent<HTMLButtonElement>, model: string) => {
      if (event.pointerType !== "touch") return;
      event.preventDefault();
      touchSelectedModelRef.current = model;
      onSelectModel(model);
      window.setTimeout(() => {
        if (touchSelectedModelRef.current === model) touchSelectedModelRef.current = null;
      }, 350);
    },
    [onSelectModel]
  );

  const handleModelOptionClick = useCallback(
    (model: string) => {
      if (touchSelectedModelRef.current === model) {
        touchSelectedModelRef.current = null;
        return;
      }
      onSelectModel(model);
    },
    [onSelectModel]
  );

  const modelMenu = (
    <div
      ref={modelMenuRef}
      data-ripple-composer-model-menu
      role="menu"
      className={`max-h-[calc(100dvh-104px)] w-48 overflow-y-auto ${WORKBENCH_MENU_CLASS}`}
    >
      {availableModels.map((model) => {
        const selected = selectedModel === model.id;
        return (
          <button
            key={model.id}
            type="button"
            role="menuitemradio"
            aria-checked={selected}
            onPointerDown={(event) => handleModelOptionPointerDown(event, model.id)}
            onClick={() => handleModelOptionClick(model.id)}
            className={`${WORKBENCH_MENU_ITEM_CLASS} justify-between font-[family-name:var(--font-mono)] ${TYPOGRAPHY_META_CLASS} ${
              selected ? "bg-[#F0F5FF] text-[#1456F0]" : "text-[#1F2329]"
            }`}
          >
            {formatModelName(model.id)}
          </button>
        );
      })}
    </div>
  );

  const modelMenuPortal =
    isModelDropdownOpen && modelMenuPosition && typeof document !== "undefined"
      ? createPortal(
          <div
            style={{
              top: modelMenuPosition.top,
              left: modelMenuPosition.left,
              position: "fixed",
            }}
            className="z-50"
          >
            {modelMenu}
          </div>,
          document.body
        )
      : null;

  const toolbarLayoutClass = composerToolbarClassName(isExpandedComposer);
  const toolbarControls = (
    <div className={toolbarLayoutClass}>
      {onSelectWorkspaceFolder && (
        <div ref={folderPickerRef} className="relative flex shrink-0 items-center">
          <button
            type="button"
            data-ripple-composer-folder-button
            aria-label={t("composer.setFocusFolder")}
            aria-pressed={hasFocusFolder}
            title={folderButtonTitle}
            onClick={() => {
              if (isModelDropdownOpen) closeModelMenu();
              closeSkillMenu();
              setIsFolderPickerOpen((open) => !open);
            }}
            className={`${COMPOSER_ICON_BUTTON_CLASS} ${
              hasFocusFolder ? COMPOSER_ICON_BUTTON_ACTIVE_CLASS : ""
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
      {onSelectRequiredSkill && (
        <div ref={skillDropdownRef} className="relative flex shrink-0 items-center">
          <button
            type="button"
            data-ripple-composer-skill-button
            aria-label={t("composer.selectSkill")}
            aria-pressed={Boolean(selectedRequiredSkill)}
            title={
              selectedRequiredSkill
                ? t("composer.selectedSkill", { name: skillDisplayName(selectedRequiredSkill) })
                : t("composer.selectSkill")
            }
            onClick={handleSkillButtonClick}
            className={`${COMPOSER_ICON_BUTTON_CLASS} ${
              selectedRequiredSkill || isSkillMenuOpen ? COMPOSER_ICON_BUTTON_ACTIVE_CLASS : ""
            }`}
          >
            {isLoadingSkills ? (
              <Loader2 size={15} className="animate-spin" />
            ) : (
              <Blocks size={16} strokeWidth={LUCIDE_STANDARD_STROKE_WIDTH} />
            )}
          </button>
          {isSkillMenuOpen && (
            <div
              ref={skillMenuRef}
              data-ripple-composer-skill-menu
              role="menu"
              className={`absolute bottom-full left-0 z-40 mb-2 max-h-72 w-72 overflow-y-auto ${WORKBENCH_MENU_CLASS}`}
            >
              {selectableSkills.length === 0 ? (
                <div className={`px-2.5 py-2 ${TYPOGRAPHY_MICRO_CLASS} text-[#646A73]`}>
                  {isLoadingSkills ? t("skills.refresh") : t("skills.noResults")}
                </div>
              ) : (
                selectableSkills.map((skill) => {
                  const selected = skill.id === selectedRequiredSkillId;
                  return (
                    <button
                      key={skill.id}
                      type="button"
                      role="menuitemradio"
                      aria-checked={selected}
                      onClick={() => {
                        onSelectRequiredSkill(skill.id);
                        closeSkillMenu();
                      }}
                      className={`${WORKBENCH_MENU_ITEM_CLASS} min-h-8 justify-between ${TYPOGRAPHY_META_CLASS} ${
                        selected ? "bg-[#F0F5FF] text-[#1456F0]" : "text-[#1F2329]"
                      }`}
                    >
                      <span className="min-w-0 truncate">{skillDisplayName(skill)}</span>
                    </button>
                  );
                })
              )}
            </div>
          )}
        </div>
      )}
      {onCreateAgentDelegation && (
        <AgentDelegationComposerButton
          disabled={!canCreateAgentDelegation || inputDisabled}
          onClick={() => {
            setIsFolderPickerOpen(false);
            closeSkillMenu();
            if (isModelDropdownOpen) closeModelMenu();
            onCreateAgentDelegation();
          }}
        />
      )}
      <div className="relative flex items-center">
        <button
          type="button"
          aria-label={t("composer.attachFiles")}
          title={t("composer.attachFiles")}
          onClick={() => fileInputRef.current?.click()}
          disabled={attachDisabled}
          className={COMPOSER_ICON_BUTTON_CLASS}
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
          ref={modelButtonRef}
          type="button"
          data-ripple-composer-model-button
          aria-label={t("composer.selectModel")}
          title={t("composer.modelTitle", { model: formatModelName(selectedModel) })}
          onClick={handleModelButtonClick}
          className={COMPOSER_ICON_BUTTON_CLASS}
        >
          <BrainCircuit size={16} strokeWidth={LUCIDE_STANDARD_STROKE_WIDTH} />
        </button>
        {isModelDropdownOpen && !modelMenuPortal ? modelMenu : null}
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
      className={`session-composer-input mb-[2px] max-h-[104px] min-h-10 min-w-0 resize-none bg-transparent px-1.5 py-2 ${TYPOGRAPHY_MOBILE_BODY_CLASS} text-[#1F2329] outline-none [-ms-overflow-style:none] [scrollbar-width:none] placeholder:text-[15px] placeholder:text-[#8F959E] disabled:opacity-60 lg:mb-0 lg:max-h-[180px] lg:min-h-[36px] lg:px-2 lg:py-1.5 lg:text-[14px] lg:leading-[22px] lg:placeholder:text-[#8F959E] [&::-webkit-scrollbar]:hidden [&::-webkit-scrollbar]:h-0 [&::-webkit-scrollbar]:w-0 ${
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
        className={`${COMPOSER_SEND_BUTTON_BASE_CLASS} border-[#FAD4D4] bg-[#FFF1F0] text-[#B42318] hover:bg-[#FFE3E0] ${sendControlLayoutClass}`}
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
        className={`${COMPOSER_SEND_BUTTON_BASE_CLASS} bg-[#1456F0] text-white shadow-[0_1px_2px_rgba(20,86,240,0.18)] hover:bg-[#0F4BD8] active:bg-[#0C3BAA] disabled:border-[#EFF0F1] disabled:bg-[#F8F9FA] disabled:text-[#BBBFC4] disabled:shadow-none ${sendControlLayoutClass}`}
      >
        <Send size={14} strokeWidth={LUCIDE_STANDARD_STROKE_WIDTH} />
      </button>
    );

  return (
    <div className="shrink-0 border-t border-[#DEE0E3] bg-white px-3 pt-1 pb-[max(env(safe-area-inset-bottom),8px)] shadow-[0_-1px_2px_rgba(31,35,41,0.04)] sm:px-4 sm:pt-2 md:px-6 lg:pb-[max(env(safe-area-inset-bottom),12px)]">
      <div className="mx-auto max-w-4xl rounded-xl border border-[#DEE0E3] bg-white p-1.5 shadow-[0_1px_2px_rgba(31,35,41,0.04)] transition-colors focus-within:border-[#1456F0] sm:p-1.5">
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="hidden"
          onChange={handleAttachChange}
          disabled={attachDisabled}
        />
        {selectedRequiredSkill && onSelectRequiredSkill && (
          <div className="flex min-w-0 px-1 pt-0.5 pb-1">
            <div
              data-ripple-composer-skill-chip
              className={`inline-flex max-w-full items-center gap-1.5 rounded-lg border border-[#BACEFD] bg-[#F0F5FF] px-2 py-1 ${TYPOGRAPHY_MICRO_CLASS} text-[#1456F0]`}
            >
              <Blocks size={13} className="shrink-0" strokeWidth={LUCIDE_STANDARD_STROKE_WIDTH} />
              <span className="min-w-0 truncate">{skillDisplayName(selectedRequiredSkill)}</span>
              <button
                type="button"
                aria-label={t("composer.clearSelectedSkill")}
                title={t("composer.clearSelectedSkill")}
                onClick={() => onSelectRequiredSkill(null)}
                className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[#1456F0] hover:bg-[#DDE8FF]"
              >
                <X size={11} />
              </button>
            </div>
          </div>
        )}
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
        {modelMenuPortal}
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
                  className="absolute top-1 right-1 inline-flex h-5 w-5 items-center justify-center rounded-full bg-white text-[#2B2F36] shadow-[0_2px_8px_rgba(15,23,42,0.16)] hover:bg-[#FFF1F0] hover:text-[#B42318]"
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
