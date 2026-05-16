"use client";

import React from "react";
import { Check, ChevronDown, Copy, Menu } from "lucide-react";
import RippleIcon from "@/components/icons/RippleIcon";
import type { UsageInfo } from "@/types";
import StatusChip from "./StatusChip";

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toLocaleString();
}

interface WorkbenchTopBarProps {
  taskTitle: string;
  selectedModel: string;
  models: { id: string; owned_by: string }[];
  isModelDropdownOpen: boolean;
  onToggleModelDropdown: () => void;
  onSelectModel: (model: string) => void;
  tokenUsage: UsageInfo;
  isContextWarning: boolean;
  sessionId: string | null;
  sessionIdCopied: boolean;
  pendingApprovalCount: number;
  onCopySessionId: () => void;
  onOpenNav: () => void;
}

export default function WorkbenchTopBar({
  taskTitle,
  selectedModel,
  models,
  isModelDropdownOpen,
  onToggleModelDropdown,
  onSelectModel,
  tokenUsage,
  isContextWarning,
  sessionId,
  sessionIdCopied,
  pendingApprovalCount,
  onCopySessionId,
  onOpenNav,
}: WorkbenchTopBarProps) {
  return (
    <header className="flex h-[52px] shrink-0 items-center justify-between border-b border-[#e5e7eb] bg-white px-4 text-[#0d0d0d] md:px-6">
      <div className="flex min-w-0 items-center gap-3">
        <button
          type="button"
          aria-label="Open navigation"
          title="Open navigation"
          onClick={onOpenNav}
          className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-[#e5e7eb] bg-white text-[#6b7280] hover:bg-[#f7f8fa] hover:text-[#0d0d0d] lg:hidden"
        >
          <Menu size={16} />
        </button>
        <RippleIcon size={26} className="h-[26px] w-[26px] shrink-0 rounded-md lg:hidden" />
        <div className="flex min-w-0 items-center gap-1.5">
          <div className="truncate text-[13px] font-semibold">{taskTitle || "New Codex task"}</div>
          <ChevronDown size={13} className="shrink-0 text-[#6b7280]" />
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
            className="hidden h-8 items-center gap-1.5 rounded-md border border-[#e5e7eb] bg-white px-2 text-xs font-medium text-[#0d0d0d] hover:bg-[#f7f8fa] md:inline-flex xl:hidden"
          >
            <span className="font-[family-name:var(--font-mono)]">{selectedModel}</span>
            <ChevronDown
              size={12}
              className={`text-[#6b7280] transition-transform ${isModelDropdownOpen ? "rotate-180" : ""}`}
            />
          </button>
          {isModelDropdownOpen && (
            <div className="absolute top-full right-0 z-30 mt-2 w-48 overflow-hidden rounded-lg border border-[#e5e7eb] bg-white shadow-lg">
              <div className="p-1">
                {models.map((model) => (
                  <button
                    key={model.id}
                    type="button"
                    onClick={() => onSelectModel(model.id)}
                    className={`flex w-full items-center rounded px-3 py-2 text-left font-[family-name:var(--font-mono)] text-xs hover:bg-[#f7f8fa] ${
                      selectedModel === model.id ? "bg-[#eef4ff] text-[#0b57d0]" : "text-[#0d0d0d]"
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
                : "border-[#e5e7eb] bg-white text-[#6b7280]"
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
            title={sessionIdCopied ? "Copied" : `Copy task ID: ${sessionId}`}
            className="hidden h-8 items-center gap-1.5 rounded-md border border-[#e5e7eb] bg-white px-2 font-[family-name:var(--font-mono)] text-xs text-[#6b7280] hover:bg-[#f7f8fa] hover:text-[#0d0d0d] 2xl:inline-flex"
          >
            <span className="max-w-[120px] truncate">{sessionId}</span>
            {sessionIdCopied ? <Check size={12} /> : <Copy size={12} />}
          </button>
        )}
      </div>
    </header>
  );
}
