"use client";

import React from "react";
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
  const hasMessages = messages.length > 0;
  const contextPercent = lastContextTokens
    ? Math.min(Math.round((lastContextTokens / 200_000) * 100), 100)
    : 0;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto bg-white px-5 py-7 md:px-10 lg:px-[72px]">
        <div className="mx-auto max-w-4xl space-y-5">
          <section className="space-y-2">
            <h1 className="text-[26px] leading-tight font-semibold tracking-normal text-[#171a1f]">
              {hasMessages ? task?.title || "Codex task" : "What should Codex work on?"}
            </h1>
            <p className="max-w-3xl text-sm leading-6 text-[#68707d]">
              {hasMessages
                ? "Codex keeps the task, files, activity, and approvals connected while it works."
                : "Ask for changes, analysis, document work, or anything that should happen inside your workspace."}
            </p>
          </section>

          {taskSteps.length > 0 && (
            <section className="rounded-lg border border-[#dde2ea] bg-[#f7f8fa]">
              <div className="flex items-center justify-between border-b border-[#dde2ea] px-3 py-2">
                <div className="text-sm font-semibold text-[#171a1f]">Current plan</div>
                {taskProgress && (
                  <div className="font-[family-name:var(--font-mono)] text-xs text-[#68707d]">
                    {taskProgress.completed}/{taskProgress.total}
                  </div>
                )}
              </div>
              <div className="divide-y divide-[#dde2ea]">
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
                      <span className="text-[#171a1f]">{step.subject}</span>
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
                  className="rounded-lg border border-[#dde2ea] bg-[#f7f8fa] px-3 py-2 text-left text-sm font-medium text-[#171a1f] hover:border-[#c8d0dc] hover:bg-white"
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
          <div className="mx-auto mt-4 max-w-4xl font-[family-name:var(--font-mono)] text-xs text-[#68707d]">
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
