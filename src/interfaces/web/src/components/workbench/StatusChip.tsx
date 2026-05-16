import React from "react";
import type { WorkbenchTaskStatus } from "@/types";

type StatusTone = "blue" | "green" | "yellow" | "red" | "gray";

const STATUS_LABELS: Record<WorkbenchTaskStatus, string> = {
  queued: "Queued",
  running: "Running",
  waiting_for_user: "Needs input",
  waiting_for_approval: "Approval",
  review: "Review",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
  idle: "Idle",
};

const STATUS_TONES: Record<WorkbenchTaskStatus, StatusTone> = {
  queued: "gray",
  running: "green",
  waiting_for_user: "yellow",
  waiting_for_approval: "yellow",
  review: "blue",
  completed: "green",
  failed: "red",
  cancelled: "gray",
  idle: "gray",
};

const TONE_CLASSES: Record<StatusTone, string> = {
  blue: "border-[#2463eb]/20 bg-[#eef4ff] text-[#2463eb]",
  green: "border-[#cfeedd] bg-[#e8f6ed] text-[#166534]",
  yellow: "border-[#bf8700]/30 bg-[#fff8c5] text-[#7d4e00]",
  red: "border-[#cf222e]/25 bg-[#ffebe9] text-[#cf222e]",
  gray: "border-[#d0d7de] bg-[#f6f8fa] text-[#57606a]",
};

export function statusLabel(status: WorkbenchTaskStatus): string {
  return STATUS_LABELS[status];
}

export function statusTone(status: WorkbenchTaskStatus): StatusTone {
  return STATUS_TONES[status];
}

export default function StatusChip({
  status,
  label,
  tone,
  compact = false,
}: {
  status?: WorkbenchTaskStatus;
  label?: string;
  tone?: StatusTone;
  compact?: boolean;
}) {
  const resolvedTone = tone || (status ? statusTone(status) : "gray");
  const resolvedLabel = label || (status ? statusLabel(status) : "Ready");

  return (
    <span
      className={`inline-flex items-center rounded-md border font-medium ${compact ? "px-1.5 py-0.5 text-[11px]" : "px-2 py-0.5 text-xs"} ${TONE_CLASSES[resolvedTone]}`}
    >
      {resolvedLabel}
    </span>
  );
}
