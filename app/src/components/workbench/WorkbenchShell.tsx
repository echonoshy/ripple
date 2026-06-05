"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import { ChevronLeft } from "lucide-react";
import { useI18n } from "@/i18n";
import { COMPACT_IOS_PAGE_BACKGROUND } from "./stylePrimitives";

const INSPECTOR_WIDTH_STORAGE_KEY = "ripple.workbench.inspectorWidth";
const DEFAULT_INSPECTOR_WIDTH = 460;
const PREVIOUS_DEFAULT_INSPECTOR_WIDTH = 380;
const MIN_INSPECTOR_WIDTH = 300;

function clampInspectorWidth(value: number): number {
  return Math.max(MIN_INSPECTOR_WIDTH, Math.round(value));
}

function initialInspectorWidth(): number {
  if (typeof window === "undefined") return DEFAULT_INSPECTOR_WIDTH;
  const rawValue = window.localStorage.getItem(INSPECTOR_WIDTH_STORAGE_KEY);
  if (rawValue === null) return DEFAULT_INSPECTOR_WIDTH;
  const stored = Number(rawValue);
  if (!Number.isFinite(stored)) return DEFAULT_INSPECTOR_WIDTH;
  const width = clampInspectorWidth(stored);
  return width === PREVIOUS_DEFAULT_INSPECTOR_WIDTH ? DEFAULT_INSPECTOR_WIDTH : width;
}

interface WorkbenchShellProps {
  topBar: React.ReactNode;
  content: React.ReactNode;
  inspector: React.ReactNode;
  mobileNav?: React.ReactNode;
  isInspectorCollapsed?: boolean;
  onExpandInspector?: () => void;
}

export default function WorkbenchShell({
  topBar,
  content,
  inspector,
  mobileNav = null,
  isInspectorCollapsed = false,
  onExpandInspector,
}: WorkbenchShellProps) {
  const { t } = useI18n();
  const [inspectorWidth, setInspectorWidth] = useState(initialInspectorWidth);
  const inspectorWidthRef = useRef(inspectorWidth);

  useEffect(() => {
    inspectorWidthRef.current = inspectorWidth;
    window.localStorage.setItem(INSPECTOR_WIDTH_STORAGE_KEY, String(inspectorWidth));
  }, [inspectorWidth]);

  const updateInspectorWidth = useCallback((value: number) => {
    setInspectorWidth(clampInspectorWidth(value));
  }, []);

  const handleInspectorResizeStart = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      const startX = event.clientX;
      const startWidth = inspectorWidthRef.current;

      const handlePointerMove = (moveEvent: PointerEvent) => {
        updateInspectorWidth(startWidth - (moveEvent.clientX - startX));
      };
      const handlePointerUp = () => {
        window.removeEventListener("pointermove", handlePointerMove);
        window.removeEventListener("pointerup", handlePointerUp);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
      };

      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
      window.addEventListener("pointermove", handlePointerMove);
      window.addEventListener("pointerup", handlePointerUp);
    },
    [updateInspectorWidth]
  );

  const handleInspectorResizeKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        updateInspectorWidth(inspectorWidthRef.current + (event.shiftKey ? 40 : 16));
      }
      if (event.key === "ArrowRight") {
        event.preventDefault();
        updateInspectorWidth(inspectorWidthRef.current - (event.shiftKey ? 40 : 16));
      }
    },
    [updateInspectorWidth]
  );

  return (
    <div
      className={`h-dvh min-h-dvh w-screen overflow-hidden ${COMPACT_IOS_PAGE_BACKGROUND} text-[#1F2329]`}
    >
      <div className="hidden lg:flex" data-ripple-shell-top-bar="true">
        {topBar}
      </div>
      <div className="flex h-full min-h-0 lg:h-[calc(100%-52px)]">
        <main className="relative flex min-w-0 flex-1 flex-col bg-transparent">
          {inspector && isInspectorCollapsed && (
            <button
              type="button"
              data-ripple-panel-edge-handle="workspace-panel"
              onClick={onExpandInspector}
              aria-label={t("common.expandWorkspacePanel")}
              title={t("common.expandWorkspacePanel")}
              className="absolute top-1/2 right-0 z-30 hidden h-14 w-7 -translate-y-1/2 items-center justify-center rounded-l-2xl border border-r-0 border-[#BACEFD] bg-white/82 text-[#1456F0] shadow-[0_8px_18px_rgba(31,35,41,0.10)] backdrop-blur-xl transition-colors hover:border-[#8FB1FF] hover:bg-[#F0F5FF] focus-visible:ring-2 focus-visible:ring-[#BACEFD] focus-visible:outline-none active:scale-95 xl:inline-flex"
            >
              <ChevronLeft size={16} />
            </button>
          )}
          <div className="min-h-0 flex-1">{content}</div>
        </main>
        {inspector && !isInspectorCollapsed && (
          <div className="relative hidden shrink-0 xl:block" style={{ width: inspectorWidth }}>
            <div
              role="separator"
              aria-label={t("common.resizeWorkspacePanel")}
              aria-orientation="vertical"
              aria-valuemin={MIN_INSPECTOR_WIDTH}
              aria-valuenow={inspectorWidth}
              tabIndex={0}
              onPointerDown={handleInspectorResizeStart}
              onKeyDown={handleInspectorResizeKeyDown}
              className="group absolute top-0 bottom-0 left-0 z-20 flex w-2 -translate-x-1/2 cursor-col-resize items-center justify-center bg-transparent transition-colors outline-none hover:bg-[#F0F5FF] focus:bg-[#F0F5FF]"
            >
              <span className="h-12 w-0.5 rounded-full bg-[#1456F0] opacity-0 transition-opacity group-hover:opacity-100 group-focus:opacity-100" />
            </div>
            {inspector}
          </div>
        )}
      </div>
      {mobileNav}
    </div>
  );
}
