"use client";

import React from "react";
import { Loader2, Plus, Settings, Trash2 } from "lucide-react";
import RippleIcon from "@/components/icons/RippleIcon";
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
    <div className="flex h-full min-h-0 flex-col text-[#171a1f]">
      <div className="px-4 pt-5 pb-4">
        <div className="mb-5 flex items-center gap-3">
          <RippleIcon size={32} className="h-8 w-8 shrink-0 rounded-lg" />
          <div className="min-w-0 flex-1">
            <div className="truncate text-[17px] font-semibold">Ripple</div>
          </div>
          <button
            type="button"
            onClick={onOpenSettings}
            aria-label={`Settings for ${userId}`}
            title="Settings"
            className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-transparent text-[#68707d] hover:border-[#dde2ea] hover:bg-white hover:text-[#171a1f]"
          >
            <Settings size={15} />
          </button>
        </div>

        <button
          type="button"
          onClick={onNewTask}
          disabled={isGenerating}
          className="flex h-[42px] w-full items-center justify-center gap-2 rounded-lg bg-[#2463eb] px-3 text-sm font-semibold text-white shadow-[0_8px_24px_rgba(36,99,235,0.18)] hover:bg-[#1d56d8] disabled:cursor-not-allowed disabled:bg-[#dde2ea] disabled:text-[#8b8f94] disabled:shadow-none"
        >
          <Plus size={15} />
          New task
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
        <div>
          <div className="mb-3 flex items-center justify-between">
            <span className="text-xs font-semibold text-[#68707d]">Recent work</span>
            {isLoading && <Loader2 size={13} className="animate-spin text-[#68707d]" />}
          </div>

          {tasks.length === 0 && !isLoading ? (
            <div className="rounded-lg border border-dashed border-[#dde2ea] bg-white px-3 py-5 text-center text-sm text-[#68707d]">
              No tasks yet
            </div>
          ) : (
            <div className="space-y-2.5">
              {tasks.map((task) => {
                const selected = task.id === selectedTaskId;
                return (
                  <div
                    key={task.id}
                    className={`group rounded-lg border transition-colors ${
                      selected
                        ? "border-[#d7e3ff] bg-[#eef4ff]"
                        : "border-transparent bg-[#f7f8fa] hover:border-[#dde2ea] hover:bg-white"
                    }`}
                  >
                    <div className="flex items-start justify-between gap-2 px-3 pt-3">
                      <button
                        type="button"
                        onClick={() => onSelectTask(task.id)}
                        className="min-w-0 flex-1 truncate text-left text-sm font-medium text-[#171a1f]"
                      >
                        {task.title}
                      </button>
                      <button
                        type="button"
                        onClick={(event) => onDeleteTask(task.id, event)}
                        className="hidden h-6 w-6 shrink-0 items-center justify-center rounded border border-transparent text-[#8b8f94] group-hover:flex hover:border-[#dde2ea] hover:bg-white hover:text-[#cf222e]"
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
                        <StatusChip status={task.status} compact />
                        {task.pendingApprovalCount > 0 && (
                          <StatusChip
                            tone="yellow"
                            label={`${task.pendingApprovalCount} approval`}
                            compact
                          />
                        )}
                      </div>
                      <div className="truncate text-xs text-[#68707d]">
                        {task.messageCount} messages · {formatSessionTime(task.lastActivityAt)}
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
