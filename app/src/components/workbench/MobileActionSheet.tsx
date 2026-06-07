"use client";

import React from "react";
import { createPortal } from "react-dom";
import { Check, Loader2, X } from "lucide-react";
import {
  TYPOGRAPHY_BODY_MEDIUM_CLASS,
  TYPOGRAPHY_META_CLASS,
  TYPOGRAPHY_META_MEDIUM_CLASS,
} from "./stylePrimitives";

export type MobileActionSheetActionTone = "neutral" | "accent" | "danger";

export interface MobileActionSheetAction {
  key: string;
  label: string;
  icon?: React.ReactNode;
  tone?: MobileActionSheetActionTone;
  disabled?: boolean;
  loading?: boolean;
  selected?: boolean;
  onClick: (event: React.MouseEvent<HTMLButtonElement>) => void;
}

interface MobileActionSheetProps extends Omit<React.HTMLAttributes<HTMLDivElement>, "title"> {
  open: boolean;
  title: string;
  subtitle?: string;
  closeLabel?: string;
  onClose: () => void;
  actions?: MobileActionSheetAction[];
  children?: React.ReactNode;
}

function actionToneClass(tone: MobileActionSheetActionTone = "neutral"): string {
  if (tone === "danger") return "text-[#B42318] active:bg-[#FFF1F0]";
  if (tone === "accent") return "text-[#1456F0] active:bg-[#F0F5FF]";
  return "text-[#2B2F36] active:bg-[#F5F6F7]";
}

export default function MobileActionSheet({
  open,
  title,
  subtitle,
  closeLabel = "Cancel",
  onClose,
  actions = [],
  children,
  className = "",
  ...sheetProps
}: MobileActionSheetProps) {
  if (!open) return null;

  const sheet = (
    <div
      data-ripple-mobile-action-sheet="true"
      className="fixed inset-0 z-50 flex items-end bg-[#1F2329]/20 p-2 pb-[max(env(safe-area-inset-bottom),8px)] backdrop-blur-[1px] lg:hidden"
      onClick={onClose}
    >
      <div
        {...sheetProps}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={`max-h-[calc(100dvh-24px-env(safe-area-inset-top))] w-full overflow-hidden rounded-2xl border border-[#DEE0E3] bg-white/96 text-[#1F2329] shadow-[0_-16px_42px_rgba(31,35,41,0.18)] backdrop-blur-2xl ${className}`}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-start gap-3 border-b border-[#EFF0F1] px-3 py-3">
          <div className="min-w-0 flex-1">
            <div className={`truncate ${TYPOGRAPHY_BODY_MEDIUM_CLASS}`}>{title}</div>
            {subtitle ? (
              <div className={`mt-0.5 truncate text-[#646A73] ${TYPOGRAPHY_META_CLASS}`}>
                {subtitle}
              </div>
            ) : null}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-[#DEE0E3] bg-white text-[#646A73] active:bg-[#F5F6F7]"
            aria-label={closeLabel}
            title={closeLabel}
          >
            <X size={16} />
          </button>
        </div>
        <div className="max-h-[calc(100dvh-150px-env(safe-area-inset-top))] overflow-y-auto p-2">
          {actions.length > 0 ? (
            <div className="grid gap-1">
              {actions.map((action) => (
                <button
                  key={action.key}
                  type="button"
                  data-ripple-mobile-action-sheet-action={action.key}
                  disabled={action.disabled || action.loading}
                  onClick={(event) => {
                    if (action.disabled || action.loading) return;
                    action.onClick(event);
                  }}
                  className={`flex min-h-11 w-full items-center gap-3 rounded-xl px-3 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-45 ${TYPOGRAPHY_BODY_MEDIUM_CLASS} ${actionToneClass(
                    action.tone
                  )}`}
                >
                  {action.loading || action.icon ? (
                    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[#F8F9FA] text-current">
                      {action.loading ? (
                        <Loader2 size={16} className="animate-spin" />
                      ) : (
                        action.icon
                      )}
                    </span>
                  ) : null}
                  <span className="min-w-0 flex-1 truncate">{action.label}</span>
                  {action.selected ? <Check size={16} className="shrink-0" /> : null}
                </button>
              ))}
            </div>
          ) : null}
          {children ? <div className={actions.length > 0 ? "mt-2" : ""}>{children}</div> : null}
        </div>
        <div className="border-t border-[#EFF0F1] p-2">
          <button
            type="button"
            onClick={onClose}
            className={`h-11 w-full rounded-xl bg-[#F5F6F7] text-[#2B2F36] active:bg-[#EFF0F1] ${TYPOGRAPHY_META_MEDIUM_CLASS}`}
          >
            {closeLabel}
          </button>
        </div>
      </div>
    </div>
  );

  if (typeof document === "undefined") return sheet;
  return createPortal(sheet, document.body);
}
