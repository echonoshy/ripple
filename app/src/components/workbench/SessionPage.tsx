"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type DragEvent,
  type FormEvent,
} from "react";
import {
  AlertTriangle,
  ArrowBigLeft,
  BrainCircuit,
  ChevronLeft,
  CheckCircle2,
  Circle,
  Ellipsis,
  Folder,
  Loader2,
  MessageCircleMore,
  Pin,
} from "lucide-react";
import type {
  Message,
  PlanStep,
  PlanProgress,
  UsageInfo,
  WorkbenchSessionSummary,
  WorkbenchTimelineEvent,
} from "@/types";
import type { FeishuAuthOpenPayload, FeishuAuthWaitingState } from "@/components/MarkdownRenderer";
import { useI18n } from "@/i18n";
import type { ChatFileRef } from "@/lib/chatInput";
import { formatModelName } from "@/lib/models";
import {
  filesFromDropData,
  partitionTransferFiles,
  type PendingImageSource,
  type PendingLocalImage,
} from "@/lib/pendingImages";
import SessionComposer from "./SessionComposer";
import SessionTimeline from "./SessionTimeline";
import { COMPACT_IOS_PAGE_BACKGROUND, MOBILE_GLASS_ICON_BUTTON_CLASS } from "./stylePrimitives";

const STICK_TO_BOTTOM_MS = 1200;
const BOTTOM_LOCK_THRESHOLD_PX = 40;
const mobileHeaderButtonClass = MOBILE_GLASS_ICON_BUTTON_CLASS;

function currentTimeMs(): number {
  return typeof performance === "undefined" ? Date.now() : performance.now();
}

function formatCompactTokenCount(value: number): string {
  const absoluteValue = Math.abs(value);
  if (absoluteValue >= 1_000_000) return formatTokenUnit(value, 1_000_000, "m");
  if (absoluteValue >= 1_000) return formatTokenUnit(value, 1_000, "k");
  return value.toLocaleString();
}

function formatTokenUnit(value: number, unit: number, suffix: string): string {
  const scaledValue = value / unit;
  const precision = Math.abs(scaledValue) < 100 && !Number.isInteger(scaledValue) ? 1 : 0;
  return `${scaledValue.toFixed(precision).replace(/\.0$/, "")}${suffix}`;
}

function folderName(
  path: string | null | undefined,
  workspaceLabel: string,
  folderFallback: string
): string {
  if (!path || path === "/workspace") return workspaceLabel;
  return path.split("/").filter(Boolean).pop() || folderFallback;
}

interface SessionPageProps {
  userId?: string;
  session: WorkbenchSessionSummary | null;
  messages: Message[];
  timelineEvents: WorkbenchTimelineEvent[];
  planProgress: PlanProgress | null;
  planSteps: PlanStep[];
  tokenUsage: UsageInfo;
  lastContextTokens: number;
  input: string;
  pendingFiles: ChatFileRef[];
  pendingLocalImages: PendingLocalImage[];
  isUploadingFiles?: boolean;
  uploadError?: string | null;
  isGenerating: boolean;
  isComposerBlocked?: boolean;
  focusToken: number;
  selectedModel: string;
  models: { id: string; owned_by: string }[];
  isModelDropdownOpen: boolean;
  sessionId: string | null;
  scrollToBottomRequest?: number;
  restoreScrollTop?: number | null;
  contextFolderPath?: string | null;
  onSelectWorkspaceFolder?: (path: string) => void | Promise<void>;
  onNewSession: () => void;
  onUpdateSessionSettings: (updates: { title?: string; pinned?: boolean }) => Promise<unknown>;
  onInputChange: (value: string) => void;
  onClearContext: () => void;
  onCompactContext: () => void;
  onAttachFiles: (files: File[]) => void | Promise<void>;
  onRemovePendingFile: (path: string) => void;
  onAddPendingImages: (files: File[], source: PendingImageSource) => void;
  onRemovePendingLocalImage: (id: string) => void;
  onToggleModelDropdown: () => void;
  onSelectModel: (model: string) => void;
  onSend: () => void;
  onStop: () => void;
  onQuickReply: (option: string) => void;
  onPermissionResolve: (action: "allow" | "always" | "deny") => void;
  onFeishuAuthOpen?: (payload: FeishuAuthOpenPayload) => void;
  feishuAuthWaiting?: FeishuAuthWaitingState | null;
  onBackToMobileSessions?: () => void;
  onRestoreScrollComplete?: () => void;
  isInspectorCollapsed?: boolean;
}

export default function SessionPage({
  userId,
  session,
  messages,
  timelineEvents,
  planProgress,
  planSteps,
  tokenUsage,
  lastContextTokens,
  input,
  pendingFiles,
  pendingLocalImages,
  isUploadingFiles = false,
  uploadError = null,
  isGenerating,
  isComposerBlocked = false,
  focusToken,
  selectedModel,
  models,
  isModelDropdownOpen,
  sessionId,
  scrollToBottomRequest = 0,
  restoreScrollTop = null,
  contextFolderPath = null,
  onSelectWorkspaceFolder,
  onNewSession,
  onUpdateSessionSettings,
  onInputChange,
  onClearContext,
  onCompactContext,
  onAttachFiles,
  onRemovePendingFile,
  onAddPendingImages,
  onRemovePendingLocalImage,
  onToggleModelDropdown,
  onSelectModel,
  onSend,
  onStop,
  onQuickReply,
  onPermissionResolve,
  onFeishuAuthOpen,
  feishuAuthWaiting,
  onBackToMobileSessions,
  onRestoreScrollComplete,
}: SessionPageProps) {
  const { t } = useI18n();
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const previousAutoScrollSessionIdRef = useRef<string | null | undefined>(undefined);
  const previousScrollToBottomRequestRef = useRef(scrollToBottomRequest);
  const stickToBottomUntilRef = useRef(0);
  const isGeneratingRef = useRef(isGenerating);
  const [isSessionSettingsOpen, setIsSessionSettingsOpen] = useState(false);
  const [settingsTitle, setSettingsTitle] = useState(session?.title || "");
  const [settingsPinned, setSettingsPinned] = useState(Boolean(session?.pinned));
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [isSavingSettings, setIsSavingSettings] = useState(false);
  const [isDraggingFiles, setIsDraggingFiles] = useState(false);
  const hasMessages = messages.length > 0;
  const contextWindow =
    typeof tokenUsage.model_context_window === "number" && tokenUsage.model_context_window > 0
      ? tokenUsage.model_context_window
      : null;
  const contextPercent =
    lastContextTokens && contextWindow
      ? Math.min(Math.round((lastContextTokens / contextWindow) * 100), 100)
      : 0;
  const contextUsageLabel = lastContextTokens
    ? contextWindow
      ? `${lastContextTokens.toLocaleString()} / ${contextWindow.toLocaleString()}`
      : lastContextTokens.toLocaleString()
    : null;
  const tokenBadgeContextLabel = lastContextTokens
    ? contextWindow
      ? `${formatCompactTokenCount(lastContextTokens)} / ${formatCompactTokenCount(
          contextWindow
        )} (${contextPercent}%)`
      : formatCompactTokenCount(lastContextTokens)
    : null;
  const tokenBadgeText = t("sessions.tokenBadge", {
    input: formatCompactTokenCount(tokenUsage.prompt_tokens),
    output: formatCompactTokenCount(tokenUsage.completion_tokens),
    context: tokenBadgeContextLabel
      ? t("sessions.tokenBadgeContext", { context: tokenBadgeContextLabel })
      : "",
  });
  const tokenBadgeAccessibleLabel = t("sessions.tokenAccessible", {
    input: tokenUsage.prompt_tokens.toLocaleString(),
    output: tokenUsage.completion_tokens.toLocaleString(),
    context: contextUsageLabel
      ? t("sessions.tokenAccessibleContext", { context: contextUsageLabel })
      : "",
  });
  const lastTimelineEvent = timelineEvents[timelineEvents.length - 1] || null;
  const lastTimelineEventId = lastTimelineEvent?.id || "";
  const lastTimelineEventBodyLength = lastTimelineEvent?.body.length || 0;
  const modelDisplayName = formatModelName(selectedModel);
  const currentModelLabel = isGenerating ? t("composer.working") : modelDisplayName;
  const currentModelAccessibleLabel = t("sessions.currentModel", { model: modelDisplayName });
  const modelBadgeIconClass = isGenerating
    ? "shrink-0 animate-pulse text-[#007aff]"
    : "shrink-0 text-[#6e6e73]";
  const effectiveContextFolderPath = session?.contextFolderPath ?? contextFolderPath ?? null;
  const workspaceScopePath = effectiveContextFolderPath || "/workspace";
  const workspaceScopeLabel = folderName(
    effectiveContextFolderPath,
    t("files.workspaceName"),
    t("files.folderName")
  );
  const focusFolderLabel = effectiveContextFolderPath ? workspaceScopeLabel : null;
  const focusFolderAccessibleLabel = focusFolderLabel
    ? t("sessions.focusFolder", { label: focusFolderLabel })
    : null;
  const folderBadgeTitle = effectiveContextFolderPath || t("sessions.fullWorkspace");
  const requestFolderPicker = useCallback(() => {
    if (!onSelectWorkspaceFolder) return;
    document.querySelector<HTMLButtonElement>("[data-ripple-composer-folder-button]")?.click();
  }, [onSelectWorkspaceFolder]);

  const scrollToBottom = useCallback(() => {
    const scrollContainer = scrollContainerRef.current;
    if (!scrollContainer) return;
    scrollContainer.scrollTop = scrollContainer.scrollHeight;
  }, []);

  const shouldKeepStickingToBottom = useCallback(
    () => isGeneratingRef.current || currentTimeMs() <= stickToBottomUntilRef.current,
    []
  );

  const startStickToBottom = useCallback(() => {
    stickToBottomUntilRef.current = currentTimeMs() + STICK_TO_BOTTOM_MS;
    scrollToBottom();
  }, [scrollToBottom]);

  const handleScroll = useCallback(() => {
    const scrollContainer = scrollContainerRef.current;
    if (!scrollContainer) return;

    const distanceFromBottom =
      scrollContainer.scrollHeight - scrollContainer.scrollTop - scrollContainer.clientHeight;
    if (distanceFromBottom > BOTTOM_LOCK_THRESHOLD_PX) {
      stickToBottomUntilRef.current = 0;
    }
  }, []);

  useEffect(() => {
    isGeneratingRef.current = isGenerating;
  }, [isGenerating]);

  useLayoutEffect(() => {
    const previousScrollSessionId = previousAutoScrollSessionIdRef.current;
    const sessionChanged = previousScrollSessionId !== sessionId;
    previousAutoScrollSessionIdRef.current = sessionId;

    if (!sessionChanged) return;

    if (typeof restoreScrollTop === "number") {
      const scrollContainer = scrollContainerRef.current;
      if (scrollContainer) {
        scrollContainer.scrollTop = restoreScrollTop;
      }
      stickToBottomUntilRef.current = 0;
      onRestoreScrollComplete?.();
      return;
    }

    startStickToBottom();
  }, [onRestoreScrollComplete, restoreScrollTop, sessionId, startStickToBottom]);

  useLayoutEffect(() => {
    const previousScrollToBottomRequest = previousScrollToBottomRequestRef.current;
    const requestChanged = previousScrollToBottomRequest !== scrollToBottomRequest;
    previousScrollToBottomRequestRef.current = scrollToBottomRequest;

    if (!requestChanged) return;

    startStickToBottom();
  }, [scrollToBottomRequest, startStickToBottom]);

  useLayoutEffect(() => {
    if (!shouldKeepStickingToBottom()) return;
    scrollToBottom();
  }, [
    isGenerating,
    lastTimelineEventBodyLength,
    lastTimelineEventId,
    messages.length,
    planSteps.length,
    scrollToBottom,
    shouldKeepStickingToBottom,
    tokenUsage.total_tokens,
  ]);

  useEffect(() => {
    const content = contentRef.current;
    if (!content || typeof ResizeObserver === "undefined") return;

    const observer = new ResizeObserver(() => {
      if (shouldKeepStickingToBottom()) {
        scrollToBottom();
      }
    });
    observer.observe(content);

    return () => observer.disconnect();
  }, [scrollToBottom, shouldKeepStickingToBottom]);

  useEffect(() => {
    if (!isSessionSettingsOpen) return;
    setSettingsTitle(session?.title || "");
    setSettingsPinned(Boolean(session?.pinned));
    setSettingsError(null);
  }, [isSessionSettingsOpen, session?.pinned, session?.sessionId, session?.title]);

  const openSessionSettings = () => {
    if (!sessionId) return;
    setIsSessionSettingsOpen(true);
  };

  const closeSessionSettings = () => {
    setIsSessionSettingsOpen(false);
    setSettingsError(null);
  };

  const handleSettingsSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!sessionId || isSavingSettings) return;
    const title = settingsTitle.trim();
    if (!title) {
      setSettingsError(t("sessions.cannotBeEmpty"));
      return;
    }
    try {
      setIsSavingSettings(true);
      setSettingsError(null);
      const saved = await onUpdateSessionSettings({ title, pinned: settingsPinned });
      if (!saved) {
        setSettingsError(t("sessions.saveFailed"));
        return;
      }
      closeSessionSettings();
    } catch (err) {
      setSettingsError(err instanceof Error ? err.message : t("sessions.saveFailed"));
    } finally {
      setIsSavingSettings(false);
    }
  };

  const handlePageDragOver = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      if (isGenerating || isUploadingFiles) return;
      const hasFiles = Array.from(event.dataTransfer.types || []).includes("Files");
      if (!hasFiles) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
      setIsDraggingFiles(true);
    },
    [isGenerating, isUploadingFiles]
  );

  const handlePageDragLeave = useCallback((event: DragEvent<HTMLDivElement>) => {
    const relatedTarget = event.relatedTarget;
    if (relatedTarget instanceof Node && event.currentTarget.contains(relatedTarget)) return;
    setIsDraggingFiles(false);
  }, []);

  const handlePageDrop = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      if (isGenerating || isUploadingFiles) return;
      const files = filesFromDropData(event.dataTransfer);
      if (files.length === 0) {
        setIsDraggingFiles(false);
        return;
      }

      event.preventDefault();
      setIsDraggingFiles(false);
      const { images, attachments: attachmentFiles } = partitionTransferFiles(files);
      if (images.length > 0) onAddPendingImages(images, "drop");
      if (attachmentFiles.length > 0) void onAttachFiles(attachmentFiles);
    },
    [isGenerating, isUploadingFiles, onAddPendingImages, onAttachFiles]
  );

  return (
    <div
      onDragOver={handlePageDragOver}
      onDragLeave={handlePageDragLeave}
      onDrop={handlePageDrop}
      className={`relative flex h-full min-h-0 flex-col ${COMPACT_IOS_PAGE_BACKGROUND} ${
        isDraggingFiles ? "ring-2 ring-[#007aff] ring-inset" : ""
      }`}
    >
      <div className="grid min-h-[calc(56px+env(safe-area-inset-top))] shrink-0 grid-cols-[44px_minmax(0,1fr)_88px] items-center border-b border-[#d7d7dd]/70 bg-white/76 px-2.5 pt-[max(env(safe-area-inset-top),0px)] shadow-[0_8px_22px_rgba(60,60,67,0.05)] backdrop-blur-2xl lg:hidden">
        <button
          type="button"
          aria-label={t("sessions.backToSessions")}
          title={t("sessions.backToSessions")}
          onClick={onBackToMobileSessions}
          className={mobileHeaderButtonClass}
        >
          <ChevronLeft size={22} strokeWidth={2.2} />
        </button>
        <div className="min-w-0 text-center">
          <div className="truncate text-[15px] leading-5 font-semibold text-[#111827]">
            {session?.title || t("sessions.fallbackTitle")}
          </div>
          <div className="mt-1 flex min-w-0 items-center justify-center gap-1.5 text-[11px] leading-4 text-[#7a8496]">
            <span
              data-ripple-current-model-badge="mobile"
              aria-label={currentModelAccessibleLabel}
              title={currentModelAccessibleLabel}
              className="inline-flex max-w-[104px] min-w-0 items-center gap-1 rounded-full border border-[#d7d7dd] bg-white/74 px-1.5 py-0.5 text-[10px] font-semibold text-[#6e6e73] shadow-[0_4px_12px_rgba(60,60,67,0.05)]"
            >
              <BrainCircuit
                size={11}
                className={modelBadgeIconClass}
                strokeWidth={2.2}
              />
              <span
                className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                  isGenerating ? "animate-pulse bg-[#007aff]" : "bg-[#34c759]"
                }`}
              />
              <span className="truncate">{currentModelLabel}</span>
            </span>
            {focusFolderLabel && focusFolderAccessibleLabel && (
              <button
                type="button"
                aria-label={focusFolderAccessibleLabel}
                title={folderBadgeTitle}
                onClick={requestFolderPicker}
                className="inline-flex max-w-[132px] min-w-0 items-center gap-1 rounded-full border border-[#d7d7dd] bg-white/74 px-1.5 py-0.5 text-[10px] font-semibold text-[#6e6e73] shadow-[0_4px_12px_rgba(60,60,67,0.05)] hover:text-[#007aff]"
              >
                <Folder size={10} className="shrink-0" strokeWidth={2.2} />
                <span className="truncate">{focusFolderLabel}</span>
              </button>
            )}
          </div>
        </div>
        <div className="flex items-center justify-end gap-1">
          <button
            type="button"
            aria-label={t("sessions.newSession")}
            title={t("sessions.newSession")}
            onClick={onNewSession}
            className={mobileHeaderButtonClass}
          >
            <MessageCircleMore size={18} strokeWidth={2.2} />
          </button>
          <button
            type="button"
            aria-label={t("sessions.options")}
            title={t("sessions.options")}
            onClick={openSessionSettings}
            disabled={!sessionId}
            className={`${mobileHeaderButtonClass} disabled:cursor-not-allowed disabled:opacity-40`}
          >
            <Ellipsis size={18} strokeWidth={2.2} />
          </button>
        </div>
      </div>

      <div className="hidden h-14 shrink-0 items-center justify-between gap-3 border-b border-[#d7d7dd]/70 bg-white/70 px-5 shadow-[0_8px_22px_rgba(60,60,67,0.04)] backdrop-blur-2xl lg:flex">
        <div className="min-w-0">
          <div className="truncate text-[14px] font-semibold text-[#111827]">
            {session?.title || t("sessions.fallbackTitle")}
          </div>
        </div>
        <div className="flex min-w-0 shrink-0 items-center gap-2">
          {focusFolderLabel && focusFolderAccessibleLabel && (
            <button
              type="button"
              aria-label={focusFolderAccessibleLabel}
              title={folderBadgeTitle}
              onClick={requestFolderPicker}
              className="inline-flex max-w-[220px] shrink-0 items-center gap-1.5 rounded-full border border-[#d7d7dd] bg-white/82 px-3 py-1.5 text-[12px] font-semibold text-[#3c3c43] shadow-[0_8px_18px_rgba(60,60,67,0.05)]"
            >
              <Folder size={13} className="shrink-0 text-[#6e6e73]" strokeWidth={2.2} />
              <span className="truncate">{focusFolderLabel}</span>
            </button>
          )}
          <span
            data-ripple-current-model-badge="desktop"
            aria-label={currentModelAccessibleLabel}
            title={currentModelAccessibleLabel}
            className="inline-flex max-w-[220px] shrink-0 items-center gap-1.5 rounded-full border border-[#d7d7dd] bg-white/82 px-3 py-1.5 text-[12px] font-semibold text-[#3c3c43] shadow-[0_8px_18px_rgba(60,60,67,0.05)]"
          >
            <BrainCircuit
              size={13}
              className={modelBadgeIconClass}
              strokeWidth={2.2}
            />
            <span
              className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                isGenerating ? "animate-pulse bg-[#007aff]" : "bg-[#34c759]"
              }`}
            />
            <span className="truncate">{currentModelLabel}</span>
          </span>
        </div>
      </div>

      {isSessionSettingsOpen && (
        <div className="absolute inset-0 z-40 flex justify-end bg-[#1d1d1f]/14 backdrop-blur-[1px]">
          <button
            type="button"
            aria-label={t("sessions.settingsTitle")}
            className="absolute inset-0 hidden cursor-default sm:block"
            onClick={closeSessionSettings}
          />
          <section className="relative flex h-full w-full flex-col border-l border-[#d7d7dd] bg-[#f2f2f7] shadow-[-18px_0_44px_rgba(60,60,67,0.14)] sm:max-w-[380px]">
            <div className="grid h-14 shrink-0 grid-cols-[44px_minmax(0,1fr)_44px] items-center border-b border-[#d7d7dd]/70 bg-white/82 px-2.5 backdrop-blur-2xl">
              <button
                type="button"
                aria-label={t("sessions.backToSession")}
                title={t("sessions.backToSession")}
                onClick={closeSessionSettings}
                className={mobileHeaderButtonClass}
              >
                <ArrowBigLeft size={18} strokeWidth={2.2} />
              </button>
              <div className="truncate text-center text-[15px] font-semibold text-[#111827]">
                {t("sessions.settingsTitle")}
              </div>
            </div>

            <form onSubmit={handleSettingsSubmit} className="flex min-h-0 flex-1 flex-col">
              <div
                data-ripple-session-settings-body="grouped-form"
                className="min-h-0 flex-1 overflow-y-auto bg-[#f2f2f7] px-4 py-4"
              >
                <section
                  data-ripple-session-settings-group="name"
                  className="rounded-2xl border border-[#d7d7dd] bg-white/88 p-3 shadow-[0_10px_28px_rgba(60,60,67,0.06)]"
                >
                  <label className="block">
                    <span className="mb-2 block text-[12px] font-medium text-[#667085]">
                      {t("sessions.name")}
                    </span>
                    <input
                      value={settingsTitle}
                      onChange={(event) => setSettingsTitle(event.target.value)}
                      maxLength={120}
                      className="h-10 w-full rounded-xl border border-[#d7d7dd] bg-white px-3 text-[14px] text-[#111827] transition-colors outline-none focus:border-[#007aff]"
                      autoFocus
                    />
                  </label>
                </section>

                <button
                  type="button"
                  aria-pressed={settingsPinned}
                  onClick={() => setSettingsPinned((pinned) => !pinned)}
                  data-ripple-session-settings-group="pinned"
                  className={`mt-3 flex w-full items-center gap-3 rounded-2xl border p-3 text-left shadow-[0_10px_28px_rgba(60,60,67,0.06)] transition-colors ${
                    settingsPinned
                      ? "border-[#cfe4ff] bg-[#eaf4ff]/88 text-[#111827]"
                      : "border-[#dfe6f4] bg-white/88 text-[#111827] hover:bg-white"
                  }`}
                >
                  <span className="grid h-8 w-8 shrink-0 place-items-center rounded-xl border border-[#e5e5ea] bg-[#f2f2f7] text-[#6e6e73]">
                    <Pin size={15} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[14px] font-semibold text-[#111827]">
                      {t("sessions.pinnedLabel")}
                    </span>
                    <span className="mt-0.5 block truncate text-[12px] leading-4 text-[#7a8496]">
                      {t("sessions.pinnedDescription")}
                    </span>
                  </span>
                  <span
                    aria-hidden="true"
                    className={`h-6 w-10 shrink-0 rounded-full p-0.5 transition-colors ${
                      settingsPinned ? "bg-[#34c759]" : "bg-[#d1d1d6]"
                    }`}
                  >
                    <span
                      className={`block h-5 w-5 rounded-full bg-white shadow-[0_2px_8px_rgba(44,63,123,0.18)] transition-transform ${
                        settingsPinned ? "translate-x-4" : "translate-x-0"
                      }`}
                    />
                  </span>
                </button>

                {settingsError ? (
                  <div className="flex items-start gap-2 rounded-xl border border-[#cf222e]/25 bg-[#ffebe9] px-3 py-2 text-[13px] font-medium text-[#cf222e]">
                    <AlertTriangle size={14} className="mt-0.5 shrink-0" />
                    <span className="min-w-0 break-words">{settingsError}</span>
                  </div>
                ) : null}
              </div>

              <div className="flex shrink-0 gap-2 border-t border-[#d7d7dd]/70 bg-white/86 p-3 pb-[max(env(safe-area-inset-bottom),12px)] backdrop-blur-2xl">
                <button
                  type="button"
                  onClick={closeSessionSettings}
                  className="inline-flex h-10 w-[40%] items-center justify-center rounded-xl border border-[#d7d7dd] bg-white px-4 text-sm font-semibold text-[#3c3c43] shadow-[0_6px_18px_rgba(60,60,67,0.05)] transition-colors hover:bg-[#f2f2f7] active:bg-[#eaf4ff]"
                >
                  {t("sessions.cancel")}
                </button>
                <button
                  type="submit"
                  disabled={!sessionId || !settingsTitle.trim() || isSavingSettings}
                  className="inline-flex h-10 flex-1 items-center justify-center gap-2 rounded-xl bg-[#007aff] px-4 text-sm font-semibold text-white shadow-[0_10px_22px_rgba(0,122,255,0.22)] transition-all duration-200 hover:bg-[#006ee6] active:scale-[0.98] disabled:cursor-not-allowed disabled:bg-[#eef2f7] disabled:text-[#9aa3af] disabled:shadow-none"
                >
                  {isSavingSettings ? <Loader2 size={15} className="animate-spin" /> : null}
                  {t("sessions.save")}
                </button>
              </div>
            </form>
          </section>
        </div>
      )}

      <div
        ref={scrollContainerRef}
        data-ripple-session-scroll="timeline"
        onScroll={handleScroll}
        className="min-h-0 flex-1 overflow-y-auto bg-white/92 px-3 py-2 sm:px-4 sm:py-5 md:px-5"
      >
        <div ref={contentRef} className="mx-auto max-w-5xl space-y-2 sm:space-y-5">
          {planSteps.length > 0 && (
            <section className="rounded-2xl border border-[#d7d7dd] bg-white/82 shadow-[0_12px_30px_rgba(60,60,67,0.06)] backdrop-blur-xl">
              <div className="flex items-center justify-between border-b border-[#e5e5ea] px-3 py-1.5">
                <div className="text-[12px] font-semibold text-[#111827]">
                  {t("sessions.currentPlan")}
                </div>
                {planProgress && (
                  <div className="font-[family-name:var(--font-mono)] text-[10px] text-[#7a8496]">
                    {planProgress.completed}/{planProgress.total}
                  </div>
                )}
              </div>
              <div className="divide-y divide-[#e5e5ea]">
                {planSteps.map((step) => {
                  const Icon =
                    step.status === "completed"
                      ? CheckCircle2
                      : step.status === "in_progress"
                        ? Loader2
                        : Circle;
                  return (
                    <div key={step.id} className="flex items-start gap-2 px-3 py-1.5 text-[12px]">
                      <Icon
                        size={15}
                        className={`mt-0.5 shrink-0 ${
                          step.status === "completed"
                            ? "text-[#1a7f37]"
                            : step.status === "in_progress"
                              ? "animate-spin text-[#007aff]"
                              : "text-[#8b8f94]"
                        }`}
                      />
                      <span
                        className={
                          step.status === "completed"
                            ? "text-[#667085] line-through decoration-[#98a2b3]"
                            : "text-[#111827]"
                        }
                      >
                        {step.subject}
                      </span>
                    </div>
                  );
                })}
              </div>
            </section>
          )}

          {contextPercent > 75 && (
            <div className="flex items-start gap-2 rounded-2xl border border-[#f2cc79]/55 bg-[#fff8df]/90 p-3 text-[13px] text-[#7d4e00] shadow-[0_10px_24px_rgba(196,122,0,0.08)]">
              <AlertTriangle size={16} className="mt-0.5 shrink-0" />
              {t("sessions.contextWarning", { percent: `${contextPercent}%` })} (
              {t("sessions.contextDetail", { usage: contextUsageLabel || "" })}).{" "}
              {t("sessions.contextSuggestion")}
            </div>
          )}

          <SessionTimeline
            userId={userId}
            messages={messages}
            events={timelineEvents}
            isGenerating={isGenerating}
            onQuickReply={onQuickReply}
            onPermissionResolve={onPermissionResolve}
            onFeishuAuthOpen={onFeishuAuthOpen}
            feishuAuthWaiting={feishuAuthWaiting}
          />
        </div>

        {tokenUsage.total_tokens > 0 && (
          <div className="mx-auto mt-4 flex max-w-5xl justify-start">
            <span
              aria-label={tokenBadgeAccessibleLabel}
              title={tokenBadgeAccessibleLabel}
              className="inline-flex max-w-full flex-wrap items-center gap-x-1.5 gap-y-0.5 rounded-full border border-[#edf2fb]/70 bg-white/60 px-2.5 py-1 font-[family-name:var(--font-mono)] text-[11px] leading-4 text-[#8a94a6] italic shadow-[0_6px_18px_rgba(44,63,123,0.04)] backdrop-blur-xl"
            >
              {tokenBadgeText}
            </span>
          </div>
        )}
      </div>

      <SessionComposer
        userId={userId}
        value={input}
        onChange={onInputChange}
        onSend={onSend}
        onStop={onStop}
        onClearContext={onClearContext}
        onCompactContext={onCompactContext}
        onAttachFiles={onAttachFiles}
        onRemovePendingFile={onRemovePendingFile}
        onAddPendingImages={onAddPendingImages}
        onRemovePendingLocalImage={onRemovePendingLocalImage}
        pendingFiles={pendingFiles}
        pendingLocalImages={pendingLocalImages}
        isUploadingFiles={isUploadingFiles}
        uploadError={uploadError}
        isGenerating={isGenerating}
        isBlocked={isComposerBlocked}
        hasSession={hasMessages || Boolean(session)}
        focusToken={focusToken}
        selectedModel={selectedModel}
        models={models}
        isModelDropdownOpen={isModelDropdownOpen}
        onToggleModelDropdown={onToggleModelDropdown}
        onSelectModel={onSelectModel}
        contextFolderPath={effectiveContextFolderPath}
        workspaceScopeLabel={workspaceScopeLabel}
        workspaceScopePath={workspaceScopePath}
        onSelectWorkspaceFolder={onSelectWorkspaceFolder}
      />
    </div>
  );
}
