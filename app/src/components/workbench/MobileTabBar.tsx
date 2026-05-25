"use client";

import React from "react";
import { mainNavItems, type WorkspaceView } from "@/lib/workspaceViews";

interface MobileTabBarProps {
  activeView: WorkspaceView;
  onSelectView: (view: WorkspaceView) => void;
}

const mobileNavLabels: Record<WorkspaceView, string> = {
  sessions: "Session",
  files: "Files",
  connectors: "Connector",
  automations: "Scheduler",
  home: "Settings",
};

export default function MobileTabBar({ activeView, onSelectView }: MobileTabBarProps) {
  return (
    <nav className="fixed right-0 bottom-0 left-0 z-30 min-h-[calc(64px+env(safe-area-inset-bottom))] border-t border-[#dfe6f4] bg-[linear-gradient(180deg,rgba(255,255,255,0.84)_0%,rgba(248,251,255,0.98)_100%)] px-2 pt-1 pb-[max(env(safe-area-inset-bottom),10px)] shadow-[0_-14px_34px_rgba(44,63,123,0.10)] backdrop-blur-2xl lg:hidden">
      <div className="mx-auto grid h-[60px] max-w-md grid-cols-5">
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
                selected ? "text-[#2457e6]" : "text-[#3f4655]"
              }`}
            >
              <span
                className={`flex h-7 w-7 items-center justify-center rounded-full transition-all ${
                  selected
                    ? "bg-[linear-gradient(135deg,#2f6bff_0%,#7b5cff_100%)] text-white shadow-[0_8px_18px_rgba(64,92,255,0.28)]"
                    : "text-[#1f2937] group-active:bg-[#eef3ff]"
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
