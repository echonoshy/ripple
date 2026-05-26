"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import { X, ChevronLeft, ChevronRight } from "lucide-react";
import RippleIcon from "@/components/icons/RippleIcon";

const NAV_WIDTH_STORAGE_KEY = "ripple.workbench.navWidth";
const DEFAULT_NAV_WIDTH = 300;
const MIN_NAV_WIDTH = 220;
const MAX_NAV_WIDTH = 420;

const INSPECTOR_WIDTH_STORAGE_KEY = "ripple.workbench.inspectorWidth";
const DEFAULT_INSPECTOR_WIDTH = 460;
const PREVIOUS_DEFAULT_INSPECTOR_WIDTH = 380;
const MIN_INSPECTOR_WIDTH = 300;

function clampNavWidth(value: number): number {
  return Math.min(MAX_NAV_WIDTH, Math.max(MIN_NAV_WIDTH, Math.round(value)));
}

function clampInspectorWidth(value: number): number {
  return Math.max(MIN_INSPECTOR_WIDTH, Math.round(value));
}

function initialNavWidth(): number {
  if (typeof window === "undefined") return DEFAULT_NAV_WIDTH;
  const rawValue = window.localStorage.getItem(NAV_WIDTH_STORAGE_KEY);
  if (rawValue === null) return DEFAULT_NAV_WIDTH;
  const stored = Number(rawValue);
  return Number.isFinite(stored) ? clampNavWidth(stored) : DEFAULT_NAV_WIDTH;
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
  nav: React.ReactNode;
  content: React.ReactNode;
  inspector: React.ReactNode;
  mobileNav?: React.ReactNode;
  isNavOpen: boolean;
  onCloseNav: () => void;
  isNavCollapsed?: boolean;
  onExpandNav?: () => void;
  isInspectorCollapsed?: boolean;
  onExpandInspector?: () => void;
}

export default function WorkbenchShell({
  nav,
  content,
  inspector,
  mobileNav = null,
  isNavOpen,
  onCloseNav,
  isNavCollapsed = false,
  onExpandNav,
  isInspectorCollapsed = false,
  onExpandInspector,
}: WorkbenchShellProps) {
  const [navWidth, setNavWidth] = useState(initialNavWidth);
  const navWidthRef = useRef(navWidth);
  const [inspectorWidth, setInspectorWidth] = useState(initialInspectorWidth);
  const inspectorWidthRef = useRef(inspectorWidth);

  useEffect(() => {
    navWidthRef.current = navWidth;
    window.localStorage.setItem(NAV_WIDTH_STORAGE_KEY, String(navWidth));
  }, [navWidth]);

  useEffect(() => {
    inspectorWidthRef.current = inspectorWidth;
    window.localStorage.setItem(INSPECTOR_WIDTH_STORAGE_KEY, String(inspectorWidth));
  }, [inspectorWidth]);

  const updateNavWidth = useCallback((value: number) => {
    setNavWidth(clampNavWidth(value));
  }, []);

  const updateInspectorWidth = useCallback((value: number) => {
    setInspectorWidth(clampInspectorWidth(value));
  }, []);

  const handleResizeStart = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      const startX = event.clientX;
      const startWidth = navWidthRef.current;

      const handlePointerMove = (moveEvent: PointerEvent) => {
        updateNavWidth(startWidth + moveEvent.clientX - startX);
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
    [updateNavWidth]
  );

  const handleResizeKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        updateNavWidth(navWidthRef.current - (event.shiftKey ? 40 : 16));
      }
      if (event.key === "ArrowRight") {
        event.preventDefault();
        updateNavWidth(navWidthRef.current + (event.shiftKey ? 40 : 16));
      }
    },
    [updateNavWidth]
  );

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
    <div className="h-dvh h-screen min-h-dvh min-h-screen w-screen overflow-hidden bg-[radial-gradient(circle_at_5%_5%,rgba(36,99,235,0.035),transparent_40%),radial-gradient(circle_at_80%_10%,rgba(139,92,246,0.035),transparent_40%),#fbfdff] text-[#0d0d0d]">
      <div className="flex h-full min-h-0">
        {!isNavCollapsed && (
          <div
            className="relative hidden shrink-0 bg-[#fbfbfc]/75 backdrop-blur-xl lg:block"
            style={{ width: navWidth }}
          >
            <div className="pointer-events-none absolute inset-0 -z-10 bg-[radial-gradient(circle_at_15%_15%,rgba(36,99,235,0.03),transparent_50%)]" />
            <div className="h-full border-r border-[#e5e7eb]/80">{nav}</div>
            <div
              role="separator"
              aria-label="Resize navigation"
              aria-orientation="vertical"
              aria-valuemin={MIN_NAV_WIDTH}
              aria-valuemax={MAX_NAV_WIDTH}
              aria-valuenow={navWidth}
              tabIndex={0}
              onPointerDown={handleResizeStart}
              onKeyDown={handleResizeKeyDown}
              className="group absolute top-0 right-0 bottom-0 z-20 flex w-2 translate-x-1/2 cursor-col-resize items-center justify-center bg-transparent transition-colors outline-none hover:bg-[#dbe6ff] focus:bg-[#dbe6ff]"
            >
              <span className="h-12 w-0.5 rounded-full bg-[#2463eb] opacity-0 transition-opacity group-hover:opacity-100 group-focus:opacity-100" />
            </div>
          </div>
        )}

        {isNavOpen && (
          <div className="fixed inset-0 z-40 lg:hidden">
            <button
              type="button"
              aria-label="Close navigation"
              className="absolute inset-0 bg-[#171a1f]/28"
              onClick={onCloseNav}
            />
            <div className="absolute top-0 bottom-0 left-0 w-[min(86vw,320px)] border-r border-[#e5e7eb]/80 bg-[#fbfbfc]/85 shadow-xl backdrop-blur-2xl">
              <div className="pointer-events-none absolute inset-0 -z-10 bg-[radial-gradient(circle_at_15%_15%,rgba(36,99,235,0.03),transparent_50%)]" />
              <div className="flex h-12 items-center justify-between border-b border-[#e5e7eb] px-3">
                <span className="flex items-center gap-2 text-sm font-semibold">
                  <RippleIcon size={26} className="h-[26px] w-[26px] rounded-md" />
                  Ripple
                </span>
                <button
                  type="button"
                  aria-label="Close navigation"
                  title="Close navigation"
                  onClick={onCloseNav}
                  className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-[#e5e7eb] bg-white text-[#6b7280] hover:bg-[#f7f8fa] hover:text-[#0d0d0d]"
                >
                  <X size={15} />
                </button>
              </div>
              <div className="h-[calc(100%-48px)]">{nav}</div>
            </div>
          </div>
        )}

        <main className="relative flex min-w-0 flex-1 flex-col bg-white">
          {isNavCollapsed && (
            <button
              type="button"
              onClick={onExpandNav}
              aria-label="Expand sidebar"
              title="Expand sidebar"
              className="absolute top-[14px] left-4 z-30 inline-flex h-8 w-8 items-center justify-center rounded-full border border-[#e5e7eb]/80 bg-white/95 text-[#6b7280] shadow-[0_2px_8px_rgba(0,0,0,0.04)] backdrop-blur-sm transition-all duration-200 hover:scale-105 hover:border-[#dfe6f4] hover:bg-white hover:text-[#0d0d0d] active:scale-95"
            >
              <ChevronRight size={16} />
            </button>
          )}
          {inspector && isInspectorCollapsed && (
            <button
              type="button"
              onClick={onExpandInspector}
              aria-label="Expand workspace panel"
              title="Expand workspace panel"
              className="absolute top-[14px] right-4 z-30 inline-flex h-8 w-8 items-center justify-center rounded-full border border-[#e5e7eb]/80 bg-white/95 text-[#6b7280] shadow-[0_2px_8px_rgba(0,0,0,0.04)] backdrop-blur-sm transition-all duration-200 hover:scale-105 hover:border-[#dfe6f4] hover:bg-white hover:text-[#0d0d0d] active:scale-95"
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
              aria-label="Resize workspace panel"
              aria-orientation="vertical"
              aria-valuemin={MIN_INSPECTOR_WIDTH}
              aria-valuenow={inspectorWidth}
              tabIndex={0}
              onPointerDown={handleInspectorResizeStart}
              onKeyDown={handleInspectorResizeKeyDown}
              className="group absolute top-0 bottom-0 left-0 z-20 flex w-2 -translate-x-1/2 cursor-col-resize items-center justify-center bg-transparent transition-colors outline-none hover:bg-[#dbe6ff] focus:bg-[#dbe6ff]"
            >
              <span className="h-12 w-0.5 rounded-full bg-[#2463eb] opacity-0 transition-opacity group-hover:opacity-100 group-focus:opacity-100" />
            </div>
            {inspector}
          </div>
        )}
      </div>
      {mobileNav}
    </div>
  );
}
