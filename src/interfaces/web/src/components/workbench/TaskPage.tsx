"use client";

import React from "react";
import { useEffect, useRef } from "react";
import { AlertTriangle, CheckCircle2, Circle, Loader2 } from "lucide-react";
import type {
  Message,
  TaskInfo,
  TaskProgress,
  UsageInfo,
  WorkbenchTaskSummary,
  WorkbenchTimelineEvent,
} from "@/types";
import TaskComposer from "./TaskComposer";
import TaskTimeline from "./TaskTimeline";
import StatusChip from "./StatusChip";

interface TaskPageProps {
  task: WorkbenchTaskSummary | null;
  messages: Message[];
  timelineEvents: WorkbenchTimelineEvent[];
  taskProgress: TaskProgress | null;
  taskSteps: TaskInfo[];
  tokenUsage: UsageInfo;
  lastContextTokens: number;
  input: string;
  isGenerating: boolean;
  focusToken: number;
  onInputChange: (value: string) => void;
  onSend: () => void;
  onStop: () => void;
  onQuickReply: (option: string) => void;
  onPermissionResolve: (action: "allow" | "always" | "deny") => void;
}

export default function TaskPage({
  task,
  messages,
  timelineEvents,
  taskProgress,
  taskSteps,
  tokenUsage,
  lastContextTokens,
  input,
  isGenerating,
  focusToken,
  onInputChange,
  onSend,
  onStop,
  onQuickReply,
  onPermissionResolve,
}: TaskPageProps) {
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const hasMessages = messages.length > 0;
  const taskTitle = task?.title || (hasMessages ? "Codex task" : "New Codex task");
  const taskStatus: WorkbenchTaskSummary["status"] = isGenerating
    ? "running"
    : task?.status || "idle";
  const contextPercent = lastContextTokens
    ? Math.min(Math.round((lastContextTokens / 200_000) * 100), 100)
    : 0;

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
  }, [isGenerating, messages.length, taskSteps.length, timelineEvents, tokenUsage.total_tokens]);

  return (
    <div className="flex h-full min-h-0 flex-col bg-white">
      <div className="shrink-0 border-b border-[#e5e7eb] bg-white px-5 py-5 md:px-8">
        <section className="min-w-0 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="truncate text-[24px] leading-tight font-semibold tracking-normal text-[#0d0d0d]">
              {taskTitle}
            </h1>
            <StatusChip status={taskStatus} />
          </div>
          <p className="max-w-3xl text-sm leading-6 text-[#6b7280]">
            {hasMessages
              ? "Codex keeps the task, files, activity, and approvals connected while it works."
              : "Ask Codex to refactor, debug, write, or inspect anything inside your workspace."}
          </p>
        </section>
      </div>

      <div
        ref={scrollContainerRef}
        className="min-h-0 flex-1 overflow-y-auto bg-white px-4 py-5 md:px-5"
      >
        <div className="mx-auto max-w-5xl space-y-5">
          {taskSteps.length > 0 && (
            <section className="rounded-lg border border-[#e5e7eb] bg-[#f7f8fa]">
              <div className="flex items-center justify-between border-b border-[#e5e7eb] px-3 py-2">
                <div className="text-sm font-semibold text-[#0d0d0d]">Current plan</div>
                {taskProgress && (
                  <div className="font-[family-name:var(--font-mono)] text-xs text-[#6b7280]">
                    {taskProgress.completed}/{taskProgress.total}
                  </div>
                )}
              </div>
              <div className="divide-y divide-[#e5e7eb]">
                {taskSteps.map((step) => {
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
              Context usage is around {contextPercent}%. Consider starting a new task soon.
            </div>
          )}

          {!hasMessages && (
            <div className="grid gap-2 sm:grid-cols-3">
              {["Refactor this app", "Analyze my files", "Draft a document"].map((suggestion) => (
                <button
                  key={suggestion}
                  type="button"
                  onClick={() => onQuickReply(suggestion)}
                  className="rounded-lg border border-[#e5e7eb] bg-[#f7f8fa] px-3 py-2 text-left text-sm font-medium text-[#0d0d0d] hover:border-[#c8d0dc] hover:bg-white"
                >
                  {suggestion}
                </button>
              ))}
            </div>
          )}

          <TaskTimeline
            messages={messages}
            events={timelineEvents}
            isGenerating={isGenerating}
            onQuickReply={onQuickReply}
            onPermissionResolve={onPermissionResolve}
          />
        </div>

        {tokenUsage.total_tokens > 0 && (
          <div className="mx-auto mt-4 max-w-5xl font-[family-name:var(--font-mono)] text-xs text-[#6b7280]">
            tokens in {tokenUsage.prompt_tokens.toLocaleString()} / out{" "}
            {tokenUsage.completion_tokens.toLocaleString()}
          </div>
        )}
      </div>

      <TaskComposer
        value={input}
        onChange={onInputChange}
        onSend={onSend}
        onStop={onStop}
        isGenerating={isGenerating}
        hasSession={hasMessages || Boolean(task)}
        focusToken={focusToken}
      />
    </div>
  );
}
