"use client";

import React from "react";
import { AlertTriangle, Loader2 } from "lucide-react";
import {
  TYPOGRAPHY_BODY_CLASS,
  TYPOGRAPHY_BODY_MEDIUM_CLASS,
  TYPOGRAPHY_META_MEDIUM_CLASS,
} from "@/components/workbench/stylePrimitives";

export interface WorkspaceConfirmation {
  title: string;
  message: string;
  confirmLabel: string;
  cancelLabel: string;
  tone?: "danger" | "accent";
  loading?: boolean;
}

interface WorkspaceConfirmDialogProps {
  confirmation: WorkspaceConfirmation | null;
  onResolve: (confirmed: boolean) => void;
}

export default function WorkspaceConfirmDialog({
  confirmation,
  onResolve,
}: WorkspaceConfirmDialogProps) {
  if (!confirmation) return null;

  const danger = confirmation.tone === "danger";
  return (
    <div
      data-ripple-files-confirm-dialog
      className="fixed inset-0 z-50 flex items-end bg-[#1F2329]/22 p-2 pb-[max(env(safe-area-inset-bottom),8px)] backdrop-blur-[1px] lg:items-center lg:justify-center"
      role="presentation"
      onClick={() => onResolve(false)}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={confirmation.title}
        className="w-full max-w-md rounded-2xl border border-[#DEE0E3] bg-white/96 text-[#1F2329] shadow-[0_18px_48px_rgba(31,35,41,0.18)] backdrop-blur-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-start gap-3 border-b border-[#EFF0F1] px-4 py-3">
          <span
            className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-xl ${
              danger ? "bg-[#FFF1F0] text-[#B42318]" : "bg-[#F0F5FF] text-[#1456F0]"
            }`}
          >
            <AlertTriangle size={16} />
          </span>
          <div className="min-w-0 flex-1">
            <div className={TYPOGRAPHY_BODY_MEDIUM_CLASS}>{confirmation.title}</div>
            <div className={`mt-1 text-[#646A73] ${TYPOGRAPHY_BODY_CLASS}`}>
              {confirmation.message}
            </div>
          </div>
        </div>
        <div className="flex flex-col-reverse gap-2 p-3 sm:flex-row sm:justify-end">
          <button
            type="button"
            onClick={() => onResolve(false)}
            disabled={confirmation.loading}
            className={`h-10 rounded-xl border border-[#DEE0E3] bg-white px-4 text-[#2B2F36] hover:bg-[#F8F9FA] disabled:cursor-not-allowed disabled:opacity-50 ${TYPOGRAPHY_META_MEDIUM_CLASS}`}
          >
            {confirmation.cancelLabel}
          </button>
          <button
            type="button"
            onClick={() => onResolve(true)}
            disabled={confirmation.loading}
            className={`inline-flex h-10 items-center justify-center gap-2 rounded-xl px-4 text-white disabled:cursor-not-allowed disabled:opacity-60 ${TYPOGRAPHY_META_MEDIUM_CLASS} ${
              danger ? "bg-[#B42318] hover:bg-[#9F1F16]" : "bg-[#1456F0] hover:bg-[#0F4BD8]"
            }`}
          >
            {confirmation.loading ? <Loader2 size={14} className="animate-spin" /> : null}
            {confirmation.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
