"use client";

import React from "react";
import { Loader2, Plus, Settings, Trash2 } from "lucide-react";
import RippleIcon from "@/components/icons/RippleIcon";
import type { WorkbenchTaskSummary } from "@/types";
import { mainNavItems, type WorkspaceView } from "@/lib/workspaceViews";
import StatusChip from "./StatusChip";

interface WorkspaceNavProps {
  tasks: WorkbenchTaskSummary[];
  selectedTaskId: string | null;
  activeView: WorkspaceView;
  isLoading: boolean;
  isGenerating: boolean;
  userId: string;
  onNewTask: () => void;
  onSelectView: (view: WorkspaceView) => void;
  onSelectTask: (id: string) => void;
  onDeleteTask: (id: string, event: React.MouseEvent) => void;
  onOpenSettings: () => void;
}

export default function WorkspaceNav({
  tasks,
  selectedTaskId,
  activeView,
  isLoading,
  isGenerating,
  userId,
  onNewTask,
  onSelectView,
  onSelectTask,
  onDeleteTask,
  onOpenSettings,
}: WorkspaceNavProps) {
  return (
    <div className="flex h-full min-h-0 flex-col text-[#0d0d0d]">
      <div className="border-b border-[#e5e7eb] px-4 pt-4 pb-4">
        <div className="mb-5 flex h-8 items-center gap-3">
          <RippleIcon size={30} className="h-[30px] w-[30px] shrink-0 rounded-lg" />
          <div className="min-w-0 flex-1">
            <div className="truncate text-[17px] leading-none font-semibold">Ripple</div>
          </div>
          <button
            type="button"
            onClick={onOpenSettings}
            aria-label={`Settings for ${userId}`}
            title="Settings"
            className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-transparent text-[#6b7280] hover:border-[#e5e7eb] hover:bg-white hover:text-[#0d0d0d]"
          >
            <Settings size={15} />
          </button>
        </div>

        <button
          type="button"
          onClick={onNewTask}
          disabled={isGenerating}
          className="flex h-9 w-full items-center justify-between gap-2 rounded-lg bg-[#2463eb] px-3 text-sm font-semibold text-white shadow-[0_8px_24px_rgba(36,99,235,0.18)] hover:bg-[#1d56d8] disabled:cursor-not-allowed disabled:bg-[#e5e7eb] disabled:text-[#8b8f94] disabled:shadow-none"
        >
          <span className="inline-flex items-center gap-2">
            <Plus size={15} />
            New Task
          </span>
          <span className="hidden rounded bg-white/15 px-1.5 py-0.5 font-[family-name:var(--font-mono)] text-[11px] font-semibold sm:inline">
            ⌘K
          </span>
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-4">
        <nav className="space-y-1">
          {mainNavItems.map((item) => {
            const Icon = item.icon;
            const selected = item.id === activeView;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => onSelectView(item.id)}
                className={`flex h-9 w-full items-center gap-3 rounded-lg px-3 text-left text-sm font-medium transition-colors ${
                  selected
                    ? "bg-[#eef4ff] text-[#0b57d0]"
                    : "text-[#374151] hover:bg-white hover:text-[#0d0d0d]"
                }`}
              >
                <Icon size={16} className={selected ? "text-[#2463eb]" : "text-[#6b7280]"} />
                {item.label}
              </button>
            );
          })}
          <button
            type="button"
            onClick={onOpenSettings}
            className="flex h-9 w-full items-center gap-3 rounded-lg px-3 text-left text-sm font-medium text-[#374151] transition-colors hover:bg-white hover:text-[#0d0d0d]"
          >
            <Settings size={16} className="text-[#6b7280]" />
            Settings
          </button>
        </nav>

        <div className="mt-10">
          <div className="mb-2 flex items-center justify-between px-2">
            <span className="text-[11px] font-medium tracking-wide text-[#6b7280] uppercase">
              Tasks
            </span>
            {isLoading ? (
              <Loader2 size={13} className="animate-spin text-[#6b7280]" />
            ) : (
              <Plus size={13} className="text-[#6b7280]" />
            )}
          </div>

          {tasks.length === 0 && !isLoading ? (
            <div className="rounded-lg border border-dashed border-[#e5e7eb] bg-white px-3 py-5 text-center text-sm text-[#6b7280]">
              No tasks yet
            </div>
          ) : (
            <div className="space-y-1">
              {tasks.slice(0, 8).map((task) => {
                const selected = task.id === selectedTaskId;
                return (
                  <div
                    key={task.id}
                    className={`group flex items-center gap-2 rounded-lg px-2.5 py-1.5 transition-colors ${
                      selected
                        ? "bg-[#eef4ff] text-[#0b57d0]"
                        : "text-[#374151] hover:bg-white hover:text-[#0d0d0d]"
                    }`}
                  >
                    <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-current opacity-70" />
                    <button
                      type="button"
                      onClick={() => onSelectTask(task.id)}
                      className="min-w-0 flex-1 truncate py-0.5 text-left text-sm font-medium"
                    >
                      {task.title}
                    </button>
                    <span className="shrink-0 opacity-0 transition-opacity group-hover:opacity-100">
                      <StatusChip status={task.status} compact />
                    </span>
                    <button
                      type="button"
                      onClick={(event) => onDeleteTask(task.id, event)}
                      className="hidden h-6 w-6 shrink-0 items-center justify-center rounded border border-transparent text-[#8b8f94] group-hover:flex hover:border-[#e5e7eb] hover:bg-white hover:text-[#cf222e]"
                      title="Delete task"
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                );
              })}
            </div>
          )}
          {tasks.length > 8 && (
            <button
              type="button"
              className="mt-3 px-2 text-xs font-medium text-[#6b7280] hover:text-[#0d0d0d]"
            >
              View all tasks
            </button>
          )}
        </div>
      </div>

      <div className="border-t border-[#e5e7eb] px-4 py-3">
        <button
          type="button"
          onClick={onOpenSettings}
          className="flex w-full items-center gap-3 rounded-lg px-1 py-1.5 text-left hover:bg-white"
        >
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[#2463eb] text-xs font-semibold text-white">
            {userId.slice(0, 2).toUpperCase()}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium text-[#0d0d0d]">{userId}</span>
            <span className="block truncate text-xs text-[#6b7280]">workspace user</span>
          </span>
        </button>
      </div>
    </div>
  );
}
