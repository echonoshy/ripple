"use client";

import React from "react";
import { X } from "lucide-react";

interface WorkbenchShellProps {
  topBar: React.ReactNode;
  nav: React.ReactNode;
  taskPage: React.ReactNode;
  inspector: React.ReactNode;
  isNavOpen: boolean;
  onCloseNav: () => void;
}

export default function WorkbenchShell({
  topBar,
  nav,
  taskPage,
  inspector,
  isNavOpen,
  onCloseNav,
}: WorkbenchShellProps) {
  return (
    <div className="h-screen w-screen overflow-hidden bg-white text-[#24292f]">
      {topBar}
      <div className="flex h-[calc(100vh-56px)] min-h-0">
        <div className="hidden w-[280px] shrink-0 border-r border-[#d0d7de] bg-[#f6f8fa] lg:block">
          {nav}
        </div>

        {isNavOpen && (
          <div className="fixed inset-0 z-40 lg:hidden">
            <button
              type="button"
              aria-label="Close navigation"
              className="absolute inset-0 bg-[#24292f]/28"
              onClick={onCloseNav}
            />
            <div className="absolute top-0 bottom-0 left-0 w-[min(86vw,320px)] border-r border-[#d0d7de] bg-[#f6f8fa] shadow-xl">
              <div className="flex h-12 items-center justify-between border-b border-[#d0d7de] px-3">
                <span className="text-sm font-semibold">Workspace</span>
                <button
                  type="button"
                  aria-label="Close navigation"
                  title="Close navigation"
                  onClick={onCloseNav}
                  className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-[#d0d7de] bg-white text-[#57606a] hover:bg-[#f6f8fa] hover:text-[#24292f]"
                >
                  <X size={15} />
                </button>
              </div>
              <div className="h-[calc(100%-48px)]">{nav}</div>
            </div>
          </div>
        )}

        <main className="min-w-0 flex-1 bg-white">{taskPage}</main>

        <aside className="hidden w-[380px] shrink-0 border-l border-[#d0d7de] bg-[#f6f8fa] xl:block">
          {inspector}
        </aside>
      </div>
    </div>
  );
}
