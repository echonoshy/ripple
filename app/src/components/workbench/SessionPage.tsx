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
  ArrowLeft,
  CheckCircle2,
  Circle,
  Loader2,
  MoreHorizontal,
  Pin,
  Plus,
} from "lucide-react";
import type {
  Message,
  PlanStep,
  PlanProgress,
  ProjectInfo,
  UsageInfo,
  WorkbenchSessionSummary,
  WorkbenchTimelineEvent,
} from "@/types";
import type { FeishuAuthOpenPayload, FeishuAuthWaitingState } from "@/components/MarkdownRenderer";
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

const STICK_TO_BOTTOM_MS = 1200;
const BOTTOM_LOCK_THRESHOLD_PX = 40;

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
  projects?: ProjectInfo[];
  activeProjectId?: string | null;
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
  projects = [],
  activeProjectId = null,
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
}: SessionPageProps) {
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
  const tokenBadgeText = `Tokens ${formatCompactTokenCount(
    tokenUsage.prompt_tokens
  )} in / ${formatCompactTokenCount(tokenUsage.completion_tokens)} out${
    tokenBadgeContextLabel ? ` \u00b7 Ctx ${tokenBadgeContextLabel}` : ""
  }`;
  const tokenBadgeAccessibleLabel = `Tokens in ${tokenUsage.prompt_tokens.toLocaleString()}, out ${tokenUsage.completion_tokens.toLocaleString()}.${
    contextUsageLabel ? ` Context ${contextUsageLabel}.` : ""
  }`;
  const lastTimelineEvent = timelineEvents[timelineEvents.length - 1] || null;
  const lastTimelineEventId = lastTimelineEvent?.id || "";
  const lastTimelineEventBodyLength = lastTimelineEvent?.body.length || 0;
  const modelDisplayName = formatModelName(selectedModel);
  const currentModelLabel = isGenerating ? "Working..." : modelDisplayName;
  const currentModelAccessibleLabel = `Current model: ${modelDisplayName}`;
  const activeProject = projects.find((project) => project.projectId === activeProjectId) || null;
  const workspaceScopeLabel = session?.projectName || activeProject?.name || "Workspace";
  const workspaceScopePath = session?.projectRoot || activeProject?.rootPath || "/workspace";
  const projectBadgeLabel = session?.projectName ? `Project: ${session.projectName}` : null;
  const projectBadgeTitle = session?.projectRoot || session?.projectName || "";

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

    startStickToBottom();
  }, [sessionId, startStickToBottom]);

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
      setSettingsError("Session name cannot be empty.");
      return;
    }
    try {
      setIsSavingSettings(true);
      setSettingsError(null);
      const saved = await onUpdateSessionSettings({ title, pinned: settingsPinned });
      if (!saved) {
        setSettingsError("Could not save session settings.");
        return;
      }
      closeSessionSettings();
    } catch (err) {
      setSettingsError(err instanceof Error ? err.message : "Could not save session settings.");
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
      className={`relative flex h-full min-h-0 flex-col bg-[radial-gradient(circle_at_18%_0%,rgba(47,107,255,0.10),transparent_32%),radial-gradient(circle_at_88%_5%,rgba(139,92,246,0.10),transparent_34%),#fbfdff] ${
        isDraggingFiles ? "ring-2 ring-[#8da0ff] ring-inset" : ""
      }`}
    >
      <div className="grid min-h-[calc(56px+env(safe-area-inset-top))] shrink-0 grid-cols-[44px_minmax(0,1fr)_88px] items-center border-b border-[#e8edf7] bg-white/72 px-2.5 pt-[max(env(safe-area-inset-top),0px)] shadow-[0_8px_22px_rgba(44,63,123,0.04)] backdrop-blur-2xl lg:hidden">
        <button
          type="button"
          aria-label="Back to sessions"
          title="Back to sessions"
          onClick={onBackToMobileSessions}
          className="inline-flex h-10 w-10 items-center justify-center rounded-full text-[#172033] active:bg-[#eef3ff]"
        >
          <ArrowLeft size={22} strokeWidth={2.4} />
        </button>
        <div className="min-w-0 text-center">
          <div className="truncate text-[15px] leading-5 font-semibold text-[#111827]">
            {session?.title || "Session"}
          </div>
          <div className="mt-0.5 flex min-w-0 items-center justify-center gap-1.5 text-[11px] leading-4 text-[#7a8496]">
            <span
              className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                isGenerating ? "animate-pulse bg-[#2f6bff]" : "bg-[#2fbf71]"
              }`}
            />
            <span className="truncate">{currentModelLabel}</span>
            {projectBadgeLabel && (
              <span title={projectBadgeTitle} className="min-w-0 truncate">
                {projectBadgeLabel}
              </span>
            )}
          </div>
        </div>
        <div className="flex items-center justify-end gap-1">
          <button
            type="button"
            aria-label="New session"
            title="New session"
            onClick={onNewSession}
            className="inline-flex h-10 w-10 items-center justify-center rounded-full text-[#172033] active:bg-[#eef3ff]"
          >
            <Plus size={21} strokeWidth={2.4} />
          </button>
          <button
            type="button"
            aria-label="Session options"
            title="Session options"
            onClick={openSessionSettings}
            disabled={!sessionId}
            className="inline-flex h-10 w-10 items-center justify-center rounded-full text-[#172033] active:bg-[#eef3ff] disabled:opacity-40"
          >
            <MoreHorizontal size={22} strokeWidth={2.4} />
          </button>
        </div>
      </div>

      <div className="hidden h-14 shrink-0 items-center justify-between gap-3 border-b border-[#e8edf7] bg-white/62 px-5 shadow-[0_8px_22px_rgba(44,63,123,0.04)] backdrop-blur-2xl lg:flex">
        <div className="min-w-0">
          <div className="truncate text-[14px] font-semibold text-[#111827]">
            {session?.title || "Session"}
          </div>
        </div>
        <div className="flex min-w-0 shrink-0 items-center gap-2">
          {projectBadgeLabel && (
            <span
              title={projectBadgeTitle}
              className="inline-flex max-w-[220px] shrink-0 items-center rounded-full border border-[#dfe6f4] bg-white/82 px-3 py-1.5 text-[12px] font-semibold text-[#374151] shadow-[0_8px_18px_rgba(44,63,123,0.06)]"
            >
              <span className="truncate">{projectBadgeLabel}</span>
            </span>
          )}
          <span
            aria-label={currentModelAccessibleLabel}
            title={currentModelAccessibleLabel}
            className="inline-flex max-w-[220px] shrink-0 items-center gap-1.5 rounded-full border border-[#dfe6f4] bg-white/82 px-3 py-1.5 text-[12px] font-semibold text-[#374151] shadow-[0_8px_18px_rgba(44,63,123,0.06)]"
          >
            <span
              className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                isGenerating ? "animate-pulse bg-[#2f6bff]" : "bg-[#2fbf71]"
              }`}
            />
            <span className="truncate">{currentModelLabel}</span>
          </span>
        </div>
      </div>

      {isSessionSettingsOpen && (
        <div className="absolute inset-0 z-40 flex justify-end bg-[#172033]/14 backdrop-blur-[1px]">
          <button
            type="button"
            aria-label="Close session settings"
            className="absolute inset-0 hidden cursor-default sm:block"
            onClick={closeSessionSettings}
          />
          <section className="relative flex h-full w-full flex-col border-l border-[#dfe6f4] bg-white shadow-[-18px_0_44px_rgba(44,63,123,0.12)] sm:max-w-[380px]">
            <div className="grid h-14 shrink-0 grid-cols-[44px_minmax(0,1fr)_44px] items-center border-b border-[#e8edf7] px-2.5">
              <button
                type="button"
                aria-label="Back to session"
                title="Back to session"
                onClick={closeSessionSettings}
                className="inline-flex h-10 w-10 items-center justify-center rounded-full text-[#172033] hover:bg-[#f7f8fa]"
              >
                <ArrowLeft size={21} strokeWidth={2.35} />
              </button>
              <div className="truncate text-center text-[15px] font-semibold text-[#111827]">
                Session settings
              </div>
            </div>

            <form onSubmit={handleSettingsSubmit} className="flex min-h-0 flex-1 flex-col">
              <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-4 py-4">
                <label className="block">
                  <span className="mb-2 block text-[12px] font-medium text-[#667085]">
                    Session name
                  </span>
                  <input
                    value={settingsTitle}
                    onChange={(event) => setSettingsTitle(event.target.value)}
                    maxLength={120}
                    className="h-10 w-full rounded-full border border-[#dfe6f4] bg-white px-4 text-[14px] text-[#111827] outline-none focus:border-[#8da0ff]"
                    autoFocus
                  />
                </label>

                <button
                  type="button"
                  aria-pressed={settingsPinned}
                  onClick={() => setSettingsPinned((pinned) => !pinned)}
                  className={`flex h-11 w-full items-center justify-between rounded-full border px-4 text-left text-[14px] font-medium ${
                    settingsPinned
                      ? "border-[#9bb5ff] bg-[#eef4ff] text-[#0b57d0]"
                      : "border-[#dfe6f4] bg-white text-[#111827] hover:bg-[#f7f8fa]"
                  }`}
                >
                  <span className="inline-flex min-w-0 items-center gap-2">
                    <Pin size={15} className="shrink-0" />
                    <span className="truncate">Pinned</span>
                  </span>
                  <span
                    className={`h-5 w-9 rounded-full p-0.5 transition-colors ${
                      settingsPinned ? "bg-[#2f6bff]" : "bg-[#d0d7e2]"
                    }`}
                  >
                    <span
                      className={`block h-4 w-4 rounded-full bg-white shadow-sm transition-transform ${
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

              <div className="shrink-0 border-t border-[#e8edf7] p-3 pb-[max(env(safe-area-inset-bottom),12px)]">
                <button
                  type="submit"
                  disabled={!sessionId || !settingsTitle.trim() || isSavingSettings}
                  className="inline-flex h-10 w-full items-center justify-center gap-2 rounded-full bg-[linear-gradient(135deg,#2f6bff,#7b5cff)] px-4 text-sm font-semibold text-white shadow-[0_12px_26px_rgba(64,92,255,0.24)] transition-all duration-200 hover:brightness-110 active:scale-[0.98] disabled:cursor-not-allowed disabled:bg-[#eef2f7] disabled:bg-none disabled:text-[#9aa3af] disabled:shadow-none"
                >
                  {isSavingSettings ? <Loader2 size={15} className="animate-spin" /> : null}
                  Save
                </button>
              </div>
            </form>
          </section>
        </div>
      )}

      <div
        ref={scrollContainerRef}
        onScroll={handleScroll}
        className="min-h-0 flex-1 overflow-y-auto bg-transparent px-3 py-2 sm:px-4 sm:py-5 md:px-5"
      >
        <div ref={contentRef} className="mx-auto max-w-5xl space-y-2 sm:space-y-5">
          {planSteps.length > 0 && (
            <section className="rounded-2xl border border-[#dfe6f4] bg-white/78 shadow-[0_12px_30px_rgba(44,63,123,0.06)] backdrop-blur-xl">
              <div className="flex items-center justify-between border-b border-[#e8edf7] px-3 py-1.5">
                <div className="text-[12px] font-semibold text-[#111827]">Current plan</div>
                {planProgress && (
                  <div className="font-[family-name:var(--font-mono)] text-[10px] text-[#7a8496]">
                    {planProgress.completed}/{planProgress.total}
                  </div>
                )}
              </div>
              <div className="divide-y divide-[#e8edf7]">
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
                              ? "animate-spin text-[#2f6bff]"
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
              Context usage is around {contextPercent}% ({contextUsageLabel} tokens). Consider
              starting a new session soon.
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
        projects={projects}
        activeProjectId={activeProjectId}
        currentSessionProjectId={session?.projectId ?? null}
        workspaceScopeLabel={workspaceScopeLabel}
        workspaceScopePath={workspaceScopePath}
        onSelectWorkspaceFolder={onSelectWorkspaceFolder}
      />
    </div>
  );
}
