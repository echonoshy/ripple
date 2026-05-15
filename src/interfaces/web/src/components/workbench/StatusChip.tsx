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
  running: "blue",
  waiting_for_user: "yellow",
  waiting_for_approval: "yellow",
  review: "blue",
  completed: "green",
  failed: "red",
  cancelled: "gray",
  idle: "gray",
};

const TONE_CLASSES: Record<StatusTone, string> = {
  blue: "border-[#0969da]/25 bg-[#ddf4ff] text-[#0969da]",
  green: "border-[#1a7f37]/25 bg-[#dafbe1] text-[#1a7f37]",
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
}: {
  status?: WorkbenchTaskStatus;
  label?: string;
  tone?: StatusTone;
}) {
  const resolvedTone = tone || (status ? statusTone(status) : "gray");
  const resolvedLabel = label || (status ? statusLabel(status) : "Ready");

  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium ${TONE_CLASSES[resolvedTone]}`}
    >
      <span className="h-1.5 w-1.5 rounded-full bg-current" />
      {resolvedLabel}
    </span>
  );
}
