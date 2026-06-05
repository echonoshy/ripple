"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent,
} from "react";
import {
  AlertTriangle,
  BrainCircuit,
  ChevronLeft,
  CheckCircle2,
  Circle,
  Folder,
  Loader2,
  MessageCircleMore,
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
import {
  COMPACT_IOS_PAGE_BACKGROUND,
  MOBILE_GLASS_ICON_BUTTON_CLASS,
  TYPOGRAPHY_BODY_CLASS,
  TYPOGRAPHY_BODY_MEDIUM_CLASS,
  TYPOGRAPHY_META_CLASS,
  TYPOGRAPHY_META_MEDIUM_CLASS,
  TYPOGRAPHY_MICRO_CLASS,
  TYPOGRAPHY_MICRO_MEDIUM_CLASS,
} from "./stylePrimitives";

const STICK_TO_BOTTOM_MS = 1200;
const BOTTOM_LOCK_THRESHOLD_PX = 40;
const MOBILE_CHAT_HEADER_FALLBACK_HEIGHT_PX = 68;
const MOBILE_CHAT_COMPOSER_FALLBACK_HEIGHT_PX = 92;
const MOBILE_CHAT_HEADER_SCROLL_DELTA_PX = 10;
const MOBILE_CHAT_HEADER_TOP_LOCK_PX = 8;
const mobileHeaderButtonClass = MOBILE_GLASS_ICON_BUTTON_CLASS;

interface MobileChatHeaderScrollInput {
  previousScrollTop: number;
  nextScrollTop: number;
  isHidden: boolean;
}

interface VisualViewportKeyboardSource {
  innerHeight: number;
  visualViewport?: { height: number; offsetTop: number } | null;
}

export function shouldHideMobileChatHeaderOnScroll({
  previousScrollTop,
  nextScrollTop,
  isHidden,
}: MobileChatHeaderScrollInput): boolean {
  if (nextScrollTop <= MOBILE_CHAT_HEADER_TOP_LOCK_PX) return false;

  const delta = nextScrollTop - previousScrollTop;
  if (delta > MOBILE_CHAT_HEADER_SCROLL_DELTA_PX) return true;
  if (delta < -MOBILE_CHAT_HEADER_SCROLL_DELTA_PX) return false;
  return isHidden;
}

export function getVisualViewportKeyboardInset(
  source?: VisualViewportKeyboardSource | null
): number {
  const currentSource =
    source ||
    (typeof window === "undefined"
      ? null
      : {
          innerHeight: window.innerHeight,
          visualViewport: window.visualViewport
            ? {
                height: window.visualViewport.height,
                offsetTop: window.visualViewport.offsetTop,
              }
            : null,
        });
  if (!currentSource?.visualViewport) return 0;

  const visualBottom =
    currentSource.visualViewport.offsetTop + currentSource.visualViewport.height;
  return Math.max(0, Math.round(currentSource.innerHeight - visualBottom));
}

function currentTimeMs(): number {
  return typeof performance === "undefined" ? Date.now() : performance.now();
}

export function sessionTimelineBottomScrollTop({
  scrollHeight,
  clientHeight,
}: {
  scrollHeight: number;
  clientHeight: number;
}): number | null {
  const maxScrollTop = Math.max(0, scrollHeight - clientHeight);
  return maxScrollTop > 0 ? maxScrollTop : null;
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
  onInputChange: (value: string) => void;
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
  onInputChange,
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
  const mobileHeaderRef = useRef<HTMLDivElement | null>(null);
  const composerOverlayRef = useRef<HTMLDivElement | null>(null);
  const previousAutoScrollSessionIdRef = useRef<string | null | undefined>(undefined);
  const previousScrollToBottomRequestRef = useRef(scrollToBottomRequest);
  const stickToBottomUntilRef = useRef(0);
  const isGeneratingRef = useRef(isGenerating);
  const isComposerFocusedRef = useRef(false);
  const composerFocusedScrollTopRef = useRef<number | null>(null);
  const lastMobileHeaderScrollTopRef = useRef(0);
  const [isDraggingFiles, setIsDraggingFiles] = useState(false);
  const [mobileHeaderHeight, setMobileHeaderHeight] = useState(
    MOBILE_CHAT_HEADER_FALLBACK_HEIGHT_PX
  );
  const [mobileComposerHeight, setMobileComposerHeight] = useState(
    MOBILE_CHAT_COMPOSER_FALLBACK_HEIGHT_PX
  );
  const [mobileKeyboardInset, setMobileKeyboardInset] = useState(0);
  const [isMobileHeaderHidden, setIsMobileHeaderHidden] = useState(false);
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
    ? "shrink-0 animate-pulse text-[#1456F0]"
    : "shrink-0 text-[#646A73]";
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
  const mobileTimelineStyle = {
    "--ripple-mobile-chat-header-height": `${mobileHeaderHeight}px`,
    "--ripple-mobile-chat-composer-height": `${mobileComposerHeight}px`,
    "--ripple-mobile-keyboard-inset": `${mobileKeyboardInset}px`,
  } as CSSProperties;
  const composerOverlayStyle = {
    transform:
      mobileKeyboardInset > 0 ? `translate3d(0, -${mobileKeyboardInset}px, 0)` : undefined,
  } as CSSProperties;

  const restoreComposerFocusedScrollTop = useCallback(() => {
    if (!isComposerFocusedRef.current) return;
    const scrollContainer = scrollContainerRef.current;
    const restoreScrollTop = composerFocusedScrollTopRef.current;
    if (!scrollContainer || typeof restoreScrollTop !== "number") return;
    scrollContainer.scrollTop = restoreScrollTop;
  }, []);

  const shouldSuppressTimelineAutoScroll = useCallback(
    () => isComposerFocusedRef.current,
    []
  );

  const handleComposerFocusStateChange = useCallback(
    (focused: boolean) => {
      isComposerFocusedRef.current = focused;
      const scrollContainer = scrollContainerRef.current;
      composerFocusedScrollTopRef.current =
        focused && scrollContainer ? scrollContainer.scrollTop : null;
      if (focused) {
        window.requestAnimationFrame(() => {
          restoreComposerFocusedScrollTop();
        });
      }
    },
    [restoreComposerFocusedScrollTop]
  );

  const scrollToBottom = useCallback(() => {
    if (shouldSuppressTimelineAutoScroll()) return;
    const scrollContainer = scrollContainerRef.current;
    if (!scrollContainer) return;
    const nextScrollTop = sessionTimelineBottomScrollTop({
      scrollHeight: scrollContainer.scrollHeight,
      clientHeight: scrollContainer.clientHeight,
    });
    if (nextScrollTop === null) return;
    scrollContainer.scrollTop = nextScrollTop;
  }, [shouldSuppressTimelineAutoScroll]);

  const shouldKeepStickingToBottom = useCallback(
    () =>
      !shouldSuppressTimelineAutoScroll() &&
      (isGeneratingRef.current || currentTimeMs() <= stickToBottomUntilRef.current),
    [shouldSuppressTimelineAutoScroll]
  );

  const updateMobileHeaderVisibility = useCallback(
    (nextScrollTop: number) => {
      const previousScrollTop = lastMobileHeaderScrollTopRef.current;
      lastMobileHeaderScrollTopRef.current = nextScrollTop;
      setIsMobileHeaderHidden((isHidden) =>
        shouldHideMobileChatHeaderOnScroll({
          previousScrollTop,
          nextScrollTop,
          isHidden,
        })
      );
    },
    []
  );

  const startStickToBottom = useCallback(() => {
    stickToBottomUntilRef.current = currentTimeMs() + STICK_TO_BOTTOM_MS;
    scrollToBottom();
  }, [scrollToBottom]);

  const handleScroll = useCallback(() => {
    const scrollContainer = scrollContainerRef.current;
    if (!scrollContainer) return;
    updateMobileHeaderVisibility(scrollContainer.scrollTop);
    if (isComposerFocusedRef.current) {
      composerFocusedScrollTopRef.current = scrollContainer.scrollTop;
    }

    const distanceFromBottom =
      scrollContainer.scrollHeight - scrollContainer.scrollTop - scrollContainer.clientHeight;
    if (distanceFromBottom > BOTTOM_LOCK_THRESHOLD_PX) {
      stickToBottomUntilRef.current = 0;
    }
  }, [updateMobileHeaderVisibility]);

  useEffect(() => {
    isGeneratingRef.current = isGenerating;
  }, [isGenerating]);

  useLayoutEffect(() => {
    if (typeof ResizeObserver === "undefined") return;
    const observedNodes: { node: HTMLDivElement; update: (height: number) => void }[] = [];
    if (mobileHeaderRef.current) {
      observedNodes.push({ node: mobileHeaderRef.current, update: setMobileHeaderHeight });
    }
    if (composerOverlayRef.current) {
      observedNodes.push({ node: composerOverlayRef.current, update: setMobileComposerHeight });
    }
    if (observedNodes.length === 0) return;

    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const nextHeight = Math.ceil(entry.contentRect.height);
        const observed = observedNodes.find((item) => item.node === entry.target);
        if (observed && nextHeight > 0) observed.update(nextHeight);
      }
    });

    for (const { node, update } of observedNodes) {
      const height = Math.ceil(node.getBoundingClientRect().height);
      if (height > 0) update(height);
      observer.observe(node);
    }

    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;

    const updateKeyboardInset = () => {
      setMobileKeyboardInset(getVisualViewportKeyboardInset());
      window.requestAnimationFrame(() => {
        restoreComposerFocusedScrollTop();
      });
    };

    updateKeyboardInset();
    window.visualViewport?.addEventListener("resize", updateKeyboardInset);
    window.visualViewport?.addEventListener("scroll", updateKeyboardInset);
    window.addEventListener("resize", updateKeyboardInset);

    return () => {
      window.visualViewport?.removeEventListener("resize", updateKeyboardInset);
      window.visualViewport?.removeEventListener("scroll", updateKeyboardInset);
      window.removeEventListener("resize", updateKeyboardInset);
    };
  }, [restoreComposerFocusedScrollTop]);

  useLayoutEffect(() => {
    restoreComposerFocusedScrollTop();
  }, [
    input,
    mobileComposerHeight,
    mobileHeaderHeight,
    mobileKeyboardInset,
    restoreComposerFocusedScrollTop,
  ]);

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
      data-ripple-mobile-chat-surface
      onDragOver={handlePageDragOver}
      onDragLeave={handlePageDragLeave}
      onDrop={handlePageDrop}
      className={`relative flex h-full min-h-0 flex-col overflow-hidden ${COMPACT_IOS_PAGE_BACKGROUND} ${
        isDraggingFiles ? "ring-2 ring-[#1456F0] ring-inset" : ""
      }`}
    >
      <div
        ref={mobileHeaderRef}
        data-ripple-mobile-chat-header="true"
        data-ripple-mobile-chat-header-hidden={isMobileHeaderHidden ? "true" : "false"}
        className={`absolute inset-x-0 top-0 z-30 grid min-h-[calc(56px+env(safe-area-inset-top))] grid-cols-[44px_minmax(0,1fr)_44px] items-center border-b border-[#DEE0E3]/70 bg-white/76 px-2.5 pt-[max(env(safe-area-inset-top),0px)] shadow-[0_8px_22px_rgba(31,35,41,0.05)] backdrop-blur-2xl transition-transform duration-150 ease-out lg:hidden ${
          isMobileHeaderHidden ? "pointer-events-none -translate-y-full" : "translate-y-0"
        }`}
      >
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
          <div className={`truncate ${TYPOGRAPHY_BODY_MEDIUM_CLASS} text-[#1F2329]`}>
            {session?.title || t("sessions.fallbackTitle")}
          </div>
          <div className={`mt-1 flex min-w-0 items-center justify-center gap-1.5 ${TYPOGRAPHY_MICRO_CLASS} text-[#646A73]`}>
            <span
              data-ripple-current-model-badge="mobile"
              aria-label={currentModelAccessibleLabel}
              title={currentModelAccessibleLabel}
              className={`inline-flex max-w-[116px] min-w-0 items-center gap-1 rounded-full border border-[#DEE0E3] bg-white/74 px-1.5 py-0.5 ${TYPOGRAPHY_MICRO_MEDIUM_CLASS} text-[#646A73] shadow-[0_4px_12px_rgba(31,35,41,0.05)]`}
            >
              <BrainCircuit size={11} className={modelBadgeIconClass} strokeWidth={2.2} />
              <span
                className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                  isGenerating ? "animate-pulse bg-[#1456F0]" : "bg-[#22A06B]"
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
                className={`inline-flex max-w-[144px] min-w-0 items-center gap-1 rounded-full border border-[#DEE0E3] bg-white/74 px-1.5 py-0.5 ${TYPOGRAPHY_MICRO_MEDIUM_CLASS} text-[#646A73] shadow-[0_4px_12px_rgba(31,35,41,0.05)] hover:text-[#1456F0]`}
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
        </div>
      </div>

      <div className="hidden h-14 shrink-0 items-center justify-between gap-3 border-b border-[#DEE0E3]/70 bg-white/70 px-5 shadow-[0_8px_22px_rgba(31,35,41,0.04)] backdrop-blur-2xl lg:flex">
        <div className="min-w-0">
          <div className={`truncate ${TYPOGRAPHY_BODY_MEDIUM_CLASS} text-[#1F2329]`}>
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
              className={`inline-flex max-w-[220px] shrink-0 items-center gap-1.5 rounded-full border border-[#DEE0E3] bg-white/82 px-3 py-1.5 ${TYPOGRAPHY_META_MEDIUM_CLASS} text-[#2B2F36] shadow-[0_8px_18px_rgba(31,35,41,0.05)]`}
            >
              <Folder size={13} className="shrink-0 text-[#646A73]" strokeWidth={2.2} />
              <span className="truncate">{focusFolderLabel}</span>
            </button>
          )}
          <span
            data-ripple-current-model-badge="desktop"
            aria-label={currentModelAccessibleLabel}
            title={currentModelAccessibleLabel}
            className={`inline-flex max-w-[220px] shrink-0 items-center gap-1.5 rounded-full border border-[#DEE0E3] bg-white/82 px-3 py-1.5 ${TYPOGRAPHY_META_MEDIUM_CLASS} text-[#2B2F36] shadow-[0_8px_18px_rgba(31,35,41,0.05)]`}
          >
            <BrainCircuit size={13} className={modelBadgeIconClass} strokeWidth={2.2} />
            <span
              className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                isGenerating ? "animate-pulse bg-[#1456F0]" : "bg-[#22A06B]"
              }`}
            />
            <span className="truncate">{currentModelLabel}</span>
          </span>
        </div>
      </div>

      <div
        ref={scrollContainerRef}
        data-ripple-session-scroll="timeline"
        onScroll={handleScroll}
        style={mobileTimelineStyle}
        className="min-h-0 flex-1 overflow-y-auto bg-white/92 px-3 pt-[calc(var(--ripple-mobile-chat-header-height)+8px)] pb-[calc(var(--ripple-mobile-chat-composer-height)+var(--ripple-mobile-keyboard-inset)+12px)] sm:px-4 md:px-5 lg:py-5"
      >
        <div ref={contentRef} className="mx-auto max-w-5xl space-y-2 sm:space-y-5">
          {planSteps.length > 0 && (
            <section className="rounded-2xl border border-[#DEE0E3] bg-white/82 shadow-[0_12px_30px_rgba(31,35,41,0.06)] backdrop-blur-xl">
              <div className="flex items-center justify-between border-b border-[#EFF0F1] px-3 py-1.5">
                <div className={`${TYPOGRAPHY_META_MEDIUM_CLASS} text-[#1F2329]`}>
                  {t("sessions.currentPlan")}
                </div>
                {planProgress && (
                  <div className={`font-[family-name:var(--font-mono)] ${TYPOGRAPHY_MICRO_CLASS} text-[#646A73]`}>
                    {planProgress.completed}/{planProgress.total}
                  </div>
                )}
              </div>
              <div className="divide-y divide-[#EFF0F1]">
                {planSteps.map((step) => {
                  const Icon =
                    step.status === "completed"
                      ? CheckCircle2
                      : step.status === "in_progress"
                        ? Loader2
                        : Circle;
                  return (
                    <div key={step.id} className={`flex items-start gap-2 px-3 py-1.5 ${TYPOGRAPHY_BODY_MEDIUM_CLASS}`}>
                      <Icon
                        size={15}
                        className={`mt-0.5 shrink-0 ${
                          step.status === "completed"
                            ? "text-[#16845B]"
                            : step.status === "in_progress"
                              ? "animate-spin text-[#1456F0]"
                              : "text-[#8F959E]"
                        }`}
                      />
                      <span
                        className={
                          step.status === "completed"
                            ? "text-[#646A73] line-through decoration-[#8F959E]"
                            : "text-[#1F2329]"
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
            <div className={`flex items-start gap-2 rounded-2xl border border-[#FAD355]/55 bg-[#FFF8DB]/90 p-3 ${TYPOGRAPHY_BODY_CLASS} text-[#8B5E00] shadow-[0_10px_24px_rgba(196,122,0,0.08)]`}>
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
              className={`inline-flex max-w-full flex-wrap items-center gap-x-1.5 gap-y-0.5 rounded-full border border-[#EFF0F1]/70 bg-white/60 px-2.5 py-1 font-[family-name:var(--font-mono)] ${TYPOGRAPHY_META_CLASS} text-[#8F959E] italic shadow-[0_6px_18px_rgba(31,35,41,0.04)] backdrop-blur-xl`}
            >
              {tokenBadgeText}
            </span>
          </div>
        )}
      </div>

      <div
        ref={composerOverlayRef}
        data-ripple-mobile-composer-overlay="true"
        style={composerOverlayStyle}
        className="absolute inset-x-0 bottom-0 z-30 transition-transform duration-150 ease-out lg:static lg:z-auto lg:shrink-0"
      >
        <SessionComposer
          userId={userId}
          value={input}
          onChange={onInputChange}
          onSend={onSend}
          onStop={onStop}
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
          onFocusStateChange={handleComposerFocusStateChange}
        />
      </div>
    </div>
  );
}
