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
    <nav className="fixed right-0 bottom-0 left-0 z-30 min-h-[calc(64px+env(safe-area-inset-bottom))] border-t border-white/70 bg-white/72 px-2 pt-1 pb-[max(env(safe-area-inset-bottom),10px)] shadow-[0_-12px_30px_rgba(44,63,123,0.10)] backdrop-blur-2xl lg:hidden">
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
              className={`group flex min-w-0 flex-col items-center justify-center gap-0.5 text-[9px] leading-none font-semibold transition-colors ${
                selected ? "text-[#2463eb]" : "text-[#3f4655]"
              }`}
            >
              <span
                className={`flex h-7 w-7 items-center justify-center rounded-full border backdrop-blur-xl transition-all ${
                  selected
                    ? "border-[#b8cdf8]/60 bg-[#eef4ff]/80 text-[#2463eb] shadow-[0_6px_16px_rgba(36,99,235,0.10)]"
                    : "border-transparent text-[#1f2937] group-active:border-white/60 group-active:bg-white/68"
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
