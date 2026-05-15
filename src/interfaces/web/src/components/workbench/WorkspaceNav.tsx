"use client";

import React from "react";
import {
  Files,
  Loader2,
  MessageSquareText,
  Plus,
  Search,
  Settings,
  Trash2,
  UserRound,
} from "lucide-react";
import type { WorkbenchTaskSummary } from "@/types";
import StatusChip from "./StatusChip";

export type WorkbenchView = "chat" | "files";

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
  activeView: WorkbenchView;
  onViewChange: (view: WorkbenchView) => void;
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
  activeView,
  onViewChange,
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

        <button className="flex w-full items-center gap-2 rounded-md border border-[#d0d7de] bg-white px-3 py-2 text-left text-sm text-[#57606a]">
          <Search size={15} />
          Search tasks, files, skills
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

        <div className="mb-5">
          <div className="mb-2 px-2 text-xs font-semibold tracking-wide text-[#6e7781] uppercase">
            Views
          </div>
          <div className="space-y-1">
            <button
              type="button"
              onClick={() => onViewChange("chat")}
              className={`flex w-full items-center justify-between rounded-md px-2 py-2 text-sm ${
                activeView === "chat"
                  ? "bg-[#eaeef2] font-semibold text-[#24292f]"
                  : "text-[#57606a] hover:bg-[#eaeef2]"
              }`}
            >
              <span className="flex items-center gap-2">
                <MessageSquareText size={15} />
                Chat
              </span>
              <span className="text-xs text-[#57606a]">{tasks.length}</span>
            </button>
            <button
              type="button"
              onClick={() => onViewChange("files")}
              className={`flex w-full items-center justify-between rounded-md px-2 py-2 text-sm ${
                activeView === "files"
                  ? "bg-[#eaeef2] font-semibold text-[#24292f]"
                  : "text-[#57606a] hover:bg-[#eaeef2]"
              }`}
            >
              <span className="flex items-center gap-2">
                <Files size={15} />
                Files
              </span>
              <span className="text-xs text-[#57606a]">workspace</span>
            </button>
          </div>
        </div>

        <div>
          <div className="mb-2 flex items-center justify-between px-2">
            <span className="text-xs font-semibold tracking-wide text-[#6e7781] uppercase">
              Recent tasks
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
                  <button
                    key={task.id}
                    type="button"
                    onClick={() => onSelectTask(task.id)}
                    className={`group w-full rounded-md border p-3 text-left transition-colors ${
                      selected
                        ? "border-[#0969da] bg-white"
                        : "border-[#d0d7de] bg-white hover:bg-[#f6f8fa]"
                    }`}
                  >
                    <div className="mb-2 flex items-start justify-between gap-2">
                      <span className="min-w-0 flex-1 truncate text-sm font-semibold text-[#24292f]">
                        {task.title}
                      </span>
                      <button
                        type="button"
                        onClick={(event) => onDeleteTask(task.id, event)}
                        className="hidden h-6 w-6 shrink-0 items-center justify-center rounded border border-transparent text-[#8c959f] group-hover:flex hover:border-[#d0d7de] hover:bg-white hover:text-[#cf222e]"
                        title="Delete task"
                      >
                        <Trash2 size={13} />
                      </button>
                    </div>
                    <div className="mb-2 flex flex-wrap gap-1.5">
                      <StatusChip status={task.status} />
                      {task.pendingApprovalCount > 0 && (
                        <StatusChip tone="yellow" label={`${task.pendingApprovalCount} approval`} />
                      )}
                    </div>
                    <div className="truncate font-[family-name:var(--font-mono)] text-xs text-[#6e7781]">
                      {task.messageCount} msgs · {formatSessionTime(task.lastActivityAt)}
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
