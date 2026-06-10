"use client";

import React from "react";
import { ChevronLeft } from "lucide-react";
import {
  LUCIDE_NAV_STROKE_WIDTH,
  MOBILE_PAGE_TOP_SAFE_AREA_CLASS,
  TYPOGRAPHY_META_CLASS,
  TYPOGRAPHY_PAGE_TITLE_CLASS,
  WORKBENCH_MOBILE_GHOST_ICON_BUTTON_CLASS,
  WORKBENCH_MOBILE_ICON_BUTTON_CLASS,
} from "./stylePrimitives";

type MobilePageHeaderBackButtonVariant = "framed" | "ghost";

interface MobilePageHeaderProps {
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  backLabel?: string;
  onBack?: () => void;
  actions?: React.ReactNode;
  className?: string;
  titleClassName?: string;
  backButtonVariant?: MobilePageHeaderBackButtonVariant;
}

export default function MobilePageHeader({
  title,
  subtitle,
  backLabel,
  onBack,
  actions,
  className = "",
  titleClassName,
  backButtonVariant = "framed",
}: MobilePageHeaderProps) {
  const titleTypographyClass = titleClassName || TYPOGRAPHY_PAGE_TITLE_CLASS;
  const backButtonClass =
    backButtonVariant === "ghost"
      ? WORKBENCH_MOBILE_GHOST_ICON_BUTTON_CLASS
      : WORKBENCH_MOBILE_ICON_BUTTON_CLASS;

  return (
    <header
      data-ripple-mobile-page-header="true"
      className={`shrink-0 border-b border-[#DEE0E3] bg-white px-3 ${MOBILE_PAGE_TOP_SAFE_AREA_CLASS} pb-2 shadow-[0_1px_2px_rgba(31,35,41,0.04)] lg:hidden ${className}`}
    >
      <div className="grid min-h-11 grid-cols-[44px_minmax(0,1fr)_auto] items-center gap-2">
        {onBack ? (
          <button
            type="button"
            onClick={onBack}
            aria-label={backLabel}
            title={backLabel}
            className={backButtonClass}
          >
            <ChevronLeft size={20} strokeWidth={LUCIDE_NAV_STROKE_WIDTH} />
          </button>
        ) : (
          <span aria-hidden="true" />
        )}
        <div className="min-w-0 text-center">
          <div
            data-ripple-mobile-page-header-title="true"
            className={`truncate text-[#1F2329] ${titleTypographyClass}`}
          >
            {title}
          </div>
          {subtitle ? (
            <div className={`mt-0.5 truncate text-[#646A73] ${TYPOGRAPHY_META_CLASS}`}>
              {subtitle}
            </div>
          ) : null}
        </div>
        <div className="flex min-w-0 shrink-0 items-center justify-end gap-1.5">
          {actions ?? <span aria-hidden="true" className="block h-11 w-11" />}
        </div>
      </div>
    </header>
  );
}
