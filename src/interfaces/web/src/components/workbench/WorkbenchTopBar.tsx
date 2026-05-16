"use client";

import React from "react";
import { Check, ChevronDown, Copy, Cpu, Menu, Settings } from "lucide-react";
import RippleIcon from "@/components/icons/RippleIcon";
import type { UsageInfo, WorkbenchTaskStatus } from "@/types";
import StatusChip from "./StatusChip";

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toLocaleString();
}

interface WorkbenchTopBarProps {
  taskTitle: string;
  userId: string;
  selectedModel: string;
  models: { id: string; owned_by: string }[];
  isModelDropdownOpen: boolean;
  onToggleModelDropdown: () => void;
  onSelectModel: (model: string) => void;
  status: WorkbenchTaskStatus;
  tokenUsage: UsageInfo;
  isContextWarning: boolean;
  sessionId: string | null;
  sessionIdCopied: boolean;
  pendingApprovalCount: number;
  onCopySessionId: () => void;
  onOpenSettings: () => void;
  onOpenNav: () => void;
}

export default function WorkbenchTopBar({
  taskTitle,
  selectedModel,
  models,
  isModelDropdownOpen,
  onToggleModelDropdown,
  onSelectModel,
  status,
  tokenUsage,
  isContextWarning,
  sessionId,
  sessionIdCopied,
  pendingApprovalCount,
  onCopySessionId,
  onOpenSettings,
  onOpenNav,
}: WorkbenchTopBarProps) {
  return (
    <header className="flex h-[58px] shrink-0 items-center justify-between border-b border-[#dde2ea] bg-white px-4 text-[#171a1f] md:px-6">
      <div className="flex min-w-0 items-center gap-3">
        <button
          type="button"
          aria-label="Open navigation"
          title="Open navigation"
          onClick={onOpenNav}
          className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-[#dde2ea] bg-white text-[#68707d] hover:bg-[#f7f8fa] hover:text-[#171a1f] lg:hidden"
        >
          <Menu size={16} />
        </button>
        <RippleIcon size={28} className="h-7 w-7 shrink-0 rounded-md lg:hidden" />
        <div className="min-w-0">
          <div className="truncate text-[15px] font-semibold">{taskTitle || "New Codex task"}</div>
          <div className="truncate text-xs text-[#68707d]">Codex is working in your files</div>
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-2">
        {pendingApprovalCount > 0 && (
          <StatusChip tone="yellow" label={`${pendingApprovalCount} approval`} />
        )}

        <div className="relative">
          <button
            type="button"
            onClick={onToggleModelDropdown}
            className="hidden h-8 items-center gap-1.5 rounded-md border border-[#dde2ea] bg-white px-2 text-xs font-medium text-[#171a1f] hover:bg-[#f7f8fa] sm:inline-flex"
          >
            <Cpu size={14} className="text-[#68707d]" />
            <span className="font-[family-name:var(--font-mono)]">{selectedModel}</span>
            <ChevronDown
              size={12}
              className={`text-[#68707d] transition-transform ${isModelDropdownOpen ? "rotate-180" : ""}`}
            />
          </button>
          {isModelDropdownOpen && (
            <div className="absolute top-full right-0 z-30 mt-2 w-48 overflow-hidden rounded-md border border-[#dde2ea] bg-white shadow-lg">
              <div className="p-1">
                {models.map((model) => (
                  <button
                    key={model.id}
                    type="button"
                    onClick={() => onSelectModel(model.id)}
                    className={`flex w-full items-center rounded px-3 py-2 text-left font-[family-name:var(--font-mono)] text-xs hover:bg-[#f7f8fa] ${
                      selectedModel === model.id ? "bg-[#e7eeff] text-[#174ea6]" : "text-[#171a1f]"
                    }`}
                  >
                    {model.id}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        {tokenUsage.total_tokens > 0 && (
          <div
            className={`hidden h-8 items-center gap-1.5 rounded-md border px-2 font-[family-name:var(--font-mono)] text-xs md:flex ${
              isContextWarning
                ? "border-[#bf8700]/35 bg-[#fff8c5] text-[#7d4e00]"
                : "border-[#dde2ea] bg-white text-[#68707d]"
            }`}
          >
            <span>in {formatTokens(tokenUsage.prompt_tokens)}</span>
            <span className="text-[#8b8f94]">/</span>
            <span>out {formatTokens(tokenUsage.completion_tokens)}</span>
          </div>
        )}

        {sessionId && (
          <button
            type="button"
            onClick={onCopySessionId}
            title={sessionIdCopied ? "Copied" : `Copy session ID: ${sessionId}`}
            className="hidden h-8 items-center gap-1.5 rounded-md border border-[#dde2ea] bg-white px-2 font-[family-name:var(--font-mono)] text-xs text-[#68707d] hover:bg-[#f7f8fa] hover:text-[#171a1f] xl:inline-flex"
          >
            <span className="max-w-[120px] truncate">{sessionId}</span>
            {sessionIdCopied ? <Check size={12} /> : <Copy size={12} />}
          </button>
        )}

        <StatusChip status={status} />

        <button
          type="button"
          aria-label="Settings"
          title="Settings"
          onClick={onOpenSettings}
          className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-[#dde2ea] bg-white text-[#68707d] hover:bg-[#f7f8fa] hover:text-[#171a1f]"
        >
          <Settings size={15} />
        </button>
      </div>
    </header>
  );
}
