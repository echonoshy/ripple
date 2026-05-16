"use client";

import React from "react";
import { Loader2, Plus, Settings, Trash2, UserRound } from "lucide-react";
import type { WorkbenchTaskSummary } from "@/types";
import StatusChip from "./StatusChip";

function formatSessionTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startOfDate = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const dayDiff = Math.round(
    (startOfToday.getTime() - startOfDate.getTime()) / (24 * 60 * 60 * 1000)
  );
  const time = date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (dayDiff === 0) return time;
  if (dayDiff === 1) return `昨天 ${time}`;
  return `${date.toLocaleDateString([], { month: "2-digit", day: "2-digit" })} ${time}`;
}

interface WorkspaceNavProps {
  tasks: WorkbenchTaskSummary[];
  selectedTaskId: string | null;
  isLoading: boolean;
  isGenerating: boolean;
  userId: string;
  onNewTask: () => void;
  onSelectTask: (id: string) => void;
  onDeleteTask: (id: string, event: React.MouseEvent) => void;
  onOpenSettings: () => void;
}

export default function WorkspaceNav({
  tasks,
  selectedTaskId,
  isLoading,
  isGenerating,
  userId,
  onNewTask,
  onSelectTask,
  onDeleteTask,
  onOpenSettings,
}: WorkspaceNavProps) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="border-b border-[#d0d7de] p-3">
        <button
          type="button"
          onClick={onOpenSettings}
          className="mb-3 flex w-full items-center gap-3 rounded-md border border-[#d0d7de] bg-white p-2.5 text-left text-sm hover:bg-[#f6f8fa]"
        >
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-[#d0d7de] bg-[#f6f8fa] text-[#57606a]">
            <UserRound size={15} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-xs text-[#6e7781]">Current user</span>
            <span className="block truncate font-[family-name:var(--font-mono)] font-semibold text-[#24292f]">
              {userId}
            </span>
          </span>
          <Settings size={14} className="text-[#6e7781]" />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        <button
          type="button"
          onClick={onNewTask}
          disabled={isGenerating}
          className="mb-4 flex h-9 w-full items-center justify-center gap-2 rounded-md border border-[#0969da] bg-[#0969da] px-3 text-sm font-semibold text-white hover:bg-[#075dbd] disabled:cursor-not-allowed disabled:border-[#d0d7de] disabled:bg-[#f6f8fa] disabled:text-[#8c959f]"
        >
          <Plus size={15} />
          New task
        </button>

        <div>
          <div className="mb-2 flex items-center justify-between px-2">
            <span className="text-xs font-semibold tracking-wide text-[#6e7781] uppercase">
              Recent chats
            </span>
            {isLoading && <Loader2 size={13} className="animate-spin text-[#6e7781]" />}
          </div>

          {tasks.length === 0 && !isLoading ? (
            <div className="rounded-md border border-dashed border-[#d0d7de] bg-white px-3 py-5 text-center text-sm text-[#6e7781]">
              No sessions yet
            </div>
          ) : (
            <div className="space-y-2">
              {tasks.map((task) => {
                const selected = task.id === selectedTaskId;
                return (
                  <div
                    key={task.id}
                    className={`group rounded-md border bg-white transition-colors ${
                      selected
                        ? "border-[#0969da]"
                        : "border-[#d0d7de] hover:border-[#afb8c1] hover:bg-[#f6f8fa]"
                    }`}
                  >
                    <div className="flex items-start justify-between gap-2 px-3 pt-3">
                      <button
                        type="button"
                        onClick={() => onSelectTask(task.id)}
                        className="min-w-0 flex-1 truncate text-left text-sm font-semibold text-[#24292f]"
                      >
                        {task.title}
                      </button>
                      <button
                        type="button"
                        onClick={(event) => onDeleteTask(task.id, event)}
                        className="hidden h-6 w-6 shrink-0 items-center justify-center rounded border border-transparent text-[#8c959f] group-hover:flex hover:border-[#d0d7de] hover:bg-white hover:text-[#cf222e]"
                        title="Delete task"
                      >
                        <Trash2 size={13} />
                      </button>
                    </div>
                    <button
                      type="button"
                      onClick={() => onSelectTask(task.id)}
                      className="block w-full px-3 pt-2 pb-3 text-left"
                    >
                      <div className="mb-2 flex flex-wrap gap-1.5">
                        <StatusChip status={task.status} />
                        {task.pendingApprovalCount > 0 && (
                          <StatusChip
                            tone="yellow"
                            label={`${task.pendingApprovalCount} approval`}
                          />
                        )}
                      </div>
                      <div className="truncate font-[family-name:var(--font-mono)] text-xs text-[#6e7781]">
                        {task.messageCount} msgs · {formatSessionTime(task.lastActivityAt)}
                      </div>
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
