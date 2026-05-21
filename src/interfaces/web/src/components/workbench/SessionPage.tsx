"use client";

import { useEffect, useRef } from "react";
import { AlertTriangle, Check, CheckCircle2, Circle, Copy, Loader2 } from "lucide-react";
import type {
  Message,
  PlanStep,
  PlanProgress,
  UsageInfo,
  WorkbenchSessionSummary,
  WorkbenchTimelineEvent,
} from "@/types";
import type { FeishuAuthOpenPayload, FeishuAuthWaitingState } from "@/components/MarkdownRenderer";
import type { ChatFileRef } from "@/lib/chatInput";
import SessionComposer from "./SessionComposer";
import SessionTimeline from "./SessionTimeline";

interface SessionPageProps {
  session: WorkbenchSessionSummary | null;
  messages: Message[];
  timelineEvents: WorkbenchTimelineEvent[];
  planProgress: PlanProgress | null;
  planSteps: PlanStep[];
  tokenUsage: UsageInfo;
  lastContextTokens: number;
  input: string;
  pendingFiles: ChatFileRef[];
  isGenerating: boolean;
  isComposerBlocked?: boolean;
  focusToken: number;
  selectedModel: string;
  models: { id: string; owned_by: string }[];
  isModelDropdownOpen: boolean;
  sessionId: string | null;
  sessionIdCopied: boolean;
  onInputChange: (value: string) => void;
  onClearContext: () => void;
  onAttachFiles: (files: File[]) => void | Promise<void>;
  onRemovePendingFile: (path: string) => void;
  onToggleModelDropdown: () => void;
  onSelectModel: (model: string) => void;
  onCopySessionId: () => void;
  onSend: () => void;
  onStop: () => void;
  onQuickReply: (option: string) => void;
  onPermissionResolve: (action: "allow" | "always" | "deny") => void;
  onFeishuAuthOpen?: (payload: FeishuAuthOpenPayload) => void;
  feishuAuthWaiting?: FeishuAuthWaitingState | null;
}

export default function SessionPage({
  session,
  messages,
  timelineEvents,
  planProgress,
  planSteps,
  tokenUsage,
  lastContextTokens,
  input,
  pendingFiles,
  isGenerating,
  isComposerBlocked = false,
  focusToken,
  selectedModel,
  models,
  isModelDropdownOpen,
  sessionId,
  sessionIdCopied,
  onInputChange,
  onClearContext,
  onAttachFiles,
  onRemovePendingFile,
  onToggleModelDropdown,
  onSelectModel,
  onCopySessionId,
  onSend,
  onStop,
  onQuickReply,
  onPermissionResolve,
  onFeishuAuthOpen,
  feishuAuthWaiting,
}: SessionPageProps) {
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
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

  useEffect(() => {
    const scrollContainer = scrollContainerRef.current;
    if (!scrollContainer) return;

    const frame = window.requestAnimationFrame(() => {
      scrollContainer.scrollTo({
        top: scrollContainer.scrollHeight,
        behavior: isGenerating ? "auto" : "smooth",
      });
    });

    return () => window.cancelAnimationFrame(frame);
  }, [isGenerating, messages.length, planSteps.length, timelineEvents, tokenUsage.total_tokens]);

  return (
    <div className="relative flex h-full min-h-0 flex-col bg-white">
      {sessionId && (
        <div className="pointer-events-none absolute top-3 right-4 z-30">
          <button
            type="button"
            onClick={onCopySessionId}
            title={sessionIdCopied ? "Copied" : `Copy session ID: ${sessionId}`}
            className="pointer-events-auto inline-flex h-8 max-w-[180px] items-center gap-1.5 rounded-md border border-[#e5e7eb] bg-white/95 px-2 font-[family-name:var(--font-mono)] text-xs text-[#6b7280] shadow-[0_8px_24px_rgba(23,26,31,0.08)] backdrop-blur hover:bg-[#f7f8fa] hover:text-[#0d0d0d]"
          >
            <span className="truncate">{sessionId}</span>
            {sessionIdCopied ? (
              <Check size={12} className="shrink-0" />
            ) : (
              <Copy size={12} className="shrink-0" />
            )}
          </button>
        </div>
      )}

      <div
        ref={scrollContainerRef}
        className="min-h-0 flex-1 overflow-y-auto bg-white px-4 py-5 md:px-5"
      >
        <div className="mx-auto max-w-5xl space-y-5">
          {planSteps.length > 0 && (
            <section className="rounded-lg border border-[#e5e7eb] bg-[#f7f8fa]">
              <div className="flex items-center justify-between border-b border-[#e5e7eb] px-3 py-2">
                <div className="text-sm font-semibold text-[#0d0d0d]">Current plan</div>
                {planProgress && (
                  <div className="font-[family-name:var(--font-mono)] text-xs text-[#6b7280]">
                    {planProgress.completed}/{planProgress.total}
                  </div>
                )}
              </div>
              <div className="divide-y divide-[#e5e7eb]">
                {planSteps.map((step) => {
                  const Icon =
                    step.status === "completed"
                      ? CheckCircle2
                      : step.status === "in_progress"
                        ? Loader2
                        : Circle;
                  return (
                    <div key={step.id} className="flex items-start gap-2 px-3 py-2 text-sm">
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
                            ? "text-[#6b7280] line-through decoration-[#8b8f94]"
                            : "text-[#0d0d0d]"
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
            <div className="flex items-start gap-2 rounded-lg border border-[#bf8700]/35 bg-[#fff8c5] p-3 text-sm text-[#7d4e00]">
              <AlertTriangle size={16} className="mt-0.5 shrink-0" />
              Context usage is around {contextPercent}% ({contextUsageLabel} tokens). Consider
              starting a new session soon.
            </div>
          )}

          {!hasMessages && (
            <section className="rounded-lg border border-[#e5e7eb] bg-[#fbfbfc] px-4 py-3">
              <div className="text-sm font-semibold text-[#0d0d0d]">
                <span className="sm:hidden">Start here</span>
                <span className="hidden sm:inline">Workspace briefing</span>
              </div>
              <div className="mt-3 grid gap-3 text-sm leading-6 text-[#6b7280] md:grid-cols-3">
                <div>
                  <div className="font-medium text-[#0d0d0d]">
                    <span className="sm:hidden">Files</span>
                    <span className="hidden sm:inline">Open the Files view</span>
                  </div>
                  <span className="sm:hidden">Review files before edits.</span>
                  <span className="hidden sm:inline">
                    Browse, preview, and edit workspace files before starting.
                  </span>
                </div>
                <div>
                  <div className="font-medium text-[#0d0d0d]">
                    <span className="sm:hidden">Sessions</span>
                    <span className="hidden sm:inline">Review recent sessions</span>
                  </div>
                  <span className="sm:hidden">Reopen work with context.</span>
                  <span className="hidden sm:inline">
                    Pick up an existing run from the sidebar when context already exists.
                  </span>
                </div>
                <div>
                  <div className="font-medium text-[#0d0d0d]">
                    <span className="sm:hidden">Ask</span>
                    <span className="hidden sm:inline">Ask Codex from the composer</span>
                  </div>
                  <span className="sm:hidden">Updates and approvals land here.</span>
                  <span className="hidden sm:inline">
                    New activity, plans, and approvals will appear here once the session starts.
                  </span>
                </div>
              </div>
            </section>
          )}

          <SessionTimeline
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
          <div className="mx-auto mt-4 max-w-5xl font-[family-name:var(--font-mono)] text-xs text-[#6b7280]">
            tokens in {tokenUsage.prompt_tokens.toLocaleString()} / out{" "}
            {tokenUsage.completion_tokens.toLocaleString()}
            {contextUsageLabel ? <> · context {contextUsageLabel}</> : null}
          </div>
        )}
      </div>

      <SessionComposer
        value={input}
        onChange={onInputChange}
        onSend={onSend}
        onStop={onStop}
        onClearContext={onClearContext}
        onAttachFiles={onAttachFiles}
        onRemovePendingFile={onRemovePendingFile}
        pendingFiles={pendingFiles}
        isGenerating={isGenerating}
        isBlocked={isComposerBlocked}
        hasSession={hasMessages || Boolean(session)}
        focusToken={focusToken}
        selectedModel={selectedModel}
        models={models}
        isModelDropdownOpen={isModelDropdownOpen}
        onToggleModelDropdown={onToggleModelDropdown}
        onSelectModel={onSelectModel}
      />
    </div>
  );
}
