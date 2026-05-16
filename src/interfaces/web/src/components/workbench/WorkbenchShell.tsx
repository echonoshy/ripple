"use client";

import React from "react";
import { X } from "lucide-react";
import RippleIcon from "@/components/icons/RippleIcon";

interface WorkbenchShellProps {
  topBar: React.ReactNode;
  nav: React.ReactNode;
  content: React.ReactNode;
  inspector: React.ReactNode;
  mobileNav?: React.ReactNode;
  isNavOpen: boolean;
  onCloseNav: () => void;
}

export default function WorkbenchShell({
  topBar,
  nav,
  content,
  inspector,
  mobileNav,
  isNavOpen,
  onCloseNav,
}: WorkbenchShellProps) {
  return (
    <div className="h-screen w-screen overflow-hidden bg-white text-[#0d0d0d]">
      <div className="flex h-full min-h-0">
        <div className="hidden w-[240px] shrink-0 border-r border-[#e5e7eb] bg-[#fbfbfc] lg:block">
          {nav}
        </div>

        {isNavOpen && (
          <div className="fixed inset-0 z-40 lg:hidden">
            <button
              type="button"
              aria-label="Close navigation"
              className="absolute inset-0 bg-[#171a1f]/28"
              onClick={onCloseNav}
            />
            <div className="absolute top-0 bottom-0 left-0 w-[min(86vw,320px)] border-r border-[#e5e7eb] bg-[#fbfbfc] shadow-xl">
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

        <main className="flex min-w-0 flex-1 flex-col bg-white">
          {topBar}
          <div className="min-h-0 flex-1">{content}</div>
        </main>
        {inspector && <div className="hidden w-[300px] shrink-0 xl:block">{inspector}</div>}
      </div>
      {mobileNav}
    </div>
  );
}
