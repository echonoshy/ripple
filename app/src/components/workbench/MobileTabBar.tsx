"use client";

import React from "react";
import { mainNavItems, type WorkspaceView } from "@/lib/workspaceViews";

interface MobileTabBarProps {
  activeView: WorkspaceView;
  onSelectView: (view: WorkspaceView) => void;
}

const mobileNavLabels: Record<WorkspaceView, string> = {
  sessions: "Sessions",
  files: "Files",
  connectors: "Connectors",
  automations: "Automations",
  home: "Settings",
};

export default function MobileTabBar({ activeView, onSelectView }: MobileTabBarProps) {
  return (
    <nav className="fixed right-0 bottom-0 left-0 z-30 min-h-[calc(64px+env(safe-area-inset-bottom))] border-t border-[#dfe6f4] bg-white px-2 pt-1 pb-[max(env(safe-area-inset-bottom),10px)] lg:hidden">
      <div
        className="mx-auto grid h-[60px] max-w-md"
        style={{ gridTemplateColumns: `repeat(${mainNavItems.length}, minmax(0, 1fr))` }}
      >
        {mainNavItems.map((item) => {
          const Icon = item.icon;
          const selected = item.id === activeView;
          return (
            <button
              key={item.id}
              type="button"
              aria-label={`Open ${mobileNavLabels[item.id]}`}
              onClick={() => onSelectView(item.id)}
              className={`group flex min-w-0 flex-col items-center justify-center gap-0.5 text-[9px] leading-none font-semibold ${
                selected ? "text-[#2463eb]" : "text-[#3f4655]"
              }`}
            >
              <span
                className={`flex h-7 w-7 items-center justify-center rounded-full transition-all ${
                  selected
                    ? "bg-[#eef4ff] text-[#2463eb]"
                    : "text-[#1f2937] group-active:bg-[#f3f4f6]"
                }`}
              >
                <Icon size={selected ? 16 : 18} strokeWidth={selected ? 2.5 : 2.25} />
              </span>
              <span className="max-w-full truncate">{mobileNavLabels[item.id]}</span>
            </button>
          );
        })}
      </div>
    </nav>
  );
}
