"use client";

import React, { useMemo } from "react";
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
  sessionId: string | null;
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
  onNewTask: () => void;
  onQuickReply: (option: string) => void;
  onPermissionResolve: (action: "allow" | "always" | "deny") => void;
}

function latestUserMessage(messages: Message[]): string {
  return [...messages].reverse().find((message) => message.role === "user")?.content || "";
}

export default function TaskPage({
  task,
  sessionId,
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
  onNewTask,
  onQuickReply,
  onPermissionResolve,
}: TaskPageProps) {
  const latestRequest = useMemo(() => latestUserMessage(messages), [messages]);
  const contextPercent = lastContextTokens
    ? Math.min(Math.round((lastContextTokens / 200_000) * 100), 100)
    : 0;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="shrink-0 border-b border-[#d0d7de] bg-white px-4 py-3">
        <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
          <div className="min-w-0">
            <h1 className="truncate text-lg font-semibold text-[#24292f]">
              {task?.title || "Chat with Codex"}
            </h1>
            <div className="mt-1 truncate font-[family-name:var(--font-mono)] text-[11px] text-[#6e7781]">
              {sessionId ? `session ${sessionId}` : "no active session"}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {task ? <StatusChip status={task.status} /> : <StatusChip tone="gray" label="Ready" />}
            {task?.pendingApprovalCount ? (
              <StatusChip tone="yellow" label={`${task.pendingApprovalCount} approval`} />
            ) : null}
            <button
              type="button"
              onClick={onNewTask}
              disabled={isGenerating}
              className="inline-flex h-8 items-center rounded-md border border-[#d0d7de] bg-white px-3 text-sm font-medium text-[#24292f] hover:bg-[#f6f8fa] disabled:cursor-not-allowed disabled:text-[#8c959f]"
            >
              New task
            </button>
          </div>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto bg-white px-4 py-4">
        <div className="mx-auto max-w-5xl space-y-4">
          {latestRequest && (
            <div className="rounded-md border border-[#d0d7de] bg-[#f6f8fa] px-3 py-2 text-xs text-[#57606a]">
              Latest request: <span className="text-[#24292f]">{latestRequest}</span>
            </div>
          )}

          {taskSteps.length > 0 && (
            <section className="rounded-md border border-[#d0d7de] bg-[#f6f8fa]">
              <div className="flex items-center justify-between border-b border-[#d8dee4] px-3 py-2">
                <div className="text-sm font-semibold text-[#24292f]">Current plan</div>
                {taskProgress && (
                  <div className="font-[family-name:var(--font-mono)] text-xs text-[#6e7781]">
                    {taskProgress.completed}/{taskProgress.total}
                  </div>
                )}
              </div>
              <div className="divide-y divide-[#d8dee4]">
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
                              ? "animate-spin text-[#0969da]"
                              : "text-[#8c959f]"
                        }`}
                      />
                      <span className="text-[#24292f]">{step.subject}</span>
                    </div>
                  );
                })}
              </div>
            </section>
          )}

          {contextPercent > 75 && (
            <div className="flex items-start gap-2 rounded-md border border-[#bf8700]/35 bg-[#fff8c5] p-3 text-sm text-[#7d4e00]">
              <AlertTriangle size={16} className="mt-0.5 shrink-0" />
              Context usage is around {contextPercent}%. Consider starting a new task soon.
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
          <div className="mx-auto mt-4 max-w-5xl font-[family-name:var(--font-mono)] text-xs text-[#6e7781]">
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
        hasSession={Boolean(sessionId)}
        focusToken={focusToken}
      />
    </div>
  );
}
