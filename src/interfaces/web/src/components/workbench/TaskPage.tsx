"use client";

import React, { useMemo, useState } from "react";
import { AlertTriangle, CheckCircle2, FileDiff, MessageSquareText, StickyNote } from "lucide-react";
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

type TaskTab = "overview" | "timeline" | "changes" | "notes";

const tabs: { id: TaskTab; label: string; icon: React.ComponentType<{ size?: number }> }[] = [
  { id: "overview", label: "Overview", icon: MessageSquareText },
  { id: "timeline", label: "Timeline", icon: CheckCircle2 },
  { id: "changes", label: "Changes", icon: FileDiff },
  { id: "notes", label: "Notes", icon: StickyNote },
];

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
  const [activeTab, setActiveTab] = useState<TaskTab>("overview");
  const latestRequest = useMemo(() => latestUserMessage(messages), [messages]);
  const progressPercent =
    taskProgress && taskProgress.total > 0
      ? Math.round((taskProgress.completed / taskProgress.total) * 100)
      : 0;
  const contextPercent = lastContextTokens
    ? Math.min(Math.round((lastContextTokens / 200_000) * 100), 100)
    : 0;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="shrink-0 border-b border-[#d0d7de] bg-white px-4 py-4">
        <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
          <div className="min-w-0">
            <div className="mb-1 text-xs font-semibold tracking-wide text-[#6e7781] uppercase">
              Task
            </div>
            <h1 className="truncate text-xl font-semibold text-[#24292f]">
              {task?.title || "Start a Codex task"}
            </h1>
            <div className="mt-1 truncate font-[family-name:var(--font-mono)] text-xs text-[#6e7781]">
              {sessionId ? `session ${sessionId}` : "no active session"}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {task ? <StatusChip status={task.status} /> : <StatusChip tone="gray" label="Ready" />}
            {task?.pendingApprovalCount ? (
              <StatusChip tone="yellow" label={`${task.pendingApprovalCount} approval`} />
            ) : null}
            <StatusChip tone="gray" label="Sandbox workspace" />
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

      <nav className="flex shrink-0 items-center gap-1 border-b border-[#d0d7de] bg-white px-3">
        {tabs.map((tab) => {
          const Icon = tab.icon;
          const selected = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              type="button"
              onClick={() => setActiveTab(tab.id)}
              className={`inline-flex h-10 items-center gap-1.5 border-b-2 px-3 text-sm font-medium ${
                selected
                  ? "border-[#0969da] text-[#0969da]"
                  : "border-transparent text-[#57606a] hover:text-[#24292f]"
              }`}
            >
              <Icon size={15} />
              {tab.label}
            </button>
          );
        })}
      </nav>

      <div className="min-h-0 flex-1 overflow-y-auto bg-white px-4 py-4">
        {activeTab === "overview" && (
          <div className="space-y-4">
            <div className="grid gap-3 md:grid-cols-2">
              <section className="rounded-md border border-[#d0d7de] bg-[#f6f8fa] p-4">
                <div className="mb-2 text-xs font-semibold tracking-wide text-[#6e7781] uppercase">
                  Latest request
                </div>
                <p className="text-sm leading-relaxed text-[#24292f]">
                  {latestRequest || "No prompt yet. Describe the task in the composer below."}
                </p>
              </section>
              <section className="rounded-md border border-[#d0d7de] bg-[#f6f8fa] p-4">
                <div className="mb-2 text-xs font-semibold tracking-wide text-[#6e7781] uppercase">
                  Progress
                </div>
                {taskProgress ? (
                  <>
                    <div className="mb-2 flex items-center justify-between text-sm text-[#24292f]">
                      <span>{taskProgress.currentTask || "Codex task list"}</span>
                      <span className="font-[family-name:var(--font-mono)]">
                        {taskProgress.completed}/{taskProgress.total}
                      </span>
                    </div>
                    <div className="h-2 overflow-hidden rounded-full bg-[#d8dee4]">
                      <div
                        className="h-full bg-[#1a7f37]"
                        style={{ width: `${progressPercent}%` }}
                      />
                    </div>
                  </>
                ) : (
                  <p className="text-sm text-[#57606a]">
                    Codex plan updates will appear here when the server emits task progress.
                  </p>
                )}
              </section>
            </div>

            <section className="rounded-md border border-[#d0d7de] bg-white">
              <div className="border-b border-[#d0d7de] px-4 py-2 text-sm font-semibold">
                Current plan
              </div>
              {taskSteps.length > 0 ? (
                <div className="divide-y divide-[#d8dee4]">
                  {taskSteps.map((step) => (
                    <div key={step.id} className="flex items-start gap-3 px-4 py-3 text-sm">
                      <span
                        className={`mt-1 h-2 w-2 shrink-0 rounded-full ${
                          step.status === "completed"
                            ? "bg-[#1a7f37]"
                            : step.status === "in_progress"
                              ? "bg-[#0969da]"
                              : "bg-[#8c959f]"
                        }`}
                      />
                      <span className="text-[#24292f]">{step.subject}</span>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="px-4 py-6 text-sm text-[#57606a]">
                  No structured plan has been emitted for this session yet.
                </div>
              )}
            </section>

            {contextPercent > 75 && (
              <div className="flex items-start gap-2 rounded-md border border-[#bf8700]/35 bg-[#fff8c5] p-3 text-sm text-[#7d4e00]">
                <AlertTriangle size={16} className="mt-0.5 shrink-0" />
                Context usage is around {contextPercent}%. Consider starting a new task soon.
              </div>
            )}

            <TaskTimeline
              messages={messages}
              events={timelineEvents.slice(-5)}
              isGenerating={isGenerating}
              onQuickReply={onQuickReply}
              onPermissionResolve={onPermissionResolve}
            />
          </div>
        )}

        {activeTab === "timeline" && (
          <TaskTimeline
            messages={messages}
            events={timelineEvents}
            isGenerating={isGenerating}
            onQuickReply={onQuickReply}
            onPermissionResolve={onPermissionResolve}
          />
        )}

        {activeTab === "changes" && (
          <div className="rounded-md border border-dashed border-[#d0d7de] bg-[#f6f8fa] p-8 text-center text-sm text-[#6e7781]">
            Changed file and diff metadata are not exposed by the current server API yet. Use the
            Files inspector to browse the workspace after a run.
          </div>
        )}

        {activeTab === "notes" && (
          <div className="rounded-md border border-dashed border-[#d0d7de] bg-[#f6f8fa] p-8 text-center text-sm text-[#6e7781]">
            Persistent task notes can be added once task objects are server-backed. For now, use the
            composer to add context to the current session.
          </div>
        )}

        {tokenUsage.total_tokens > 0 && (
          <div className="mt-4 font-[family-name:var(--font-mono)] text-xs text-[#6e7781]">
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
