"use client";

import React from "react";
import { Settings } from "lucide-react";
import { mainNavItems, type WorkspaceView } from "@/lib/workspaceViews";

interface MobileTabBarProps {
  activeView: WorkspaceView;
  onSelectView: (view: WorkspaceView) => void;
  onOpenSettings: () => void;
}

const mobileNavLabels: Record<WorkspaceView, string> = {
  home: "Home",
  sessions: "Sessions",
  automations: "Auto",
  files: "Files",
  connectors: "Apps",
};

export default function MobileTabBar({
  activeView,
  onSelectView,
  onOpenSettings,
}: MobileTabBarProps) {
  return (
    <nav className="fixed right-0 bottom-0 left-0 z-30 min-h-[calc(64px+env(safe-area-inset-bottom))] border-t border-[#e5e7eb] bg-white/96 px-3 pt-1 pb-[max(env(safe-area-inset-bottom),12px)] shadow-[0_-10px_30px_rgba(23,26,31,0.06)] backdrop-blur lg:hidden">
      <div className="mx-auto grid h-16 max-w-md grid-cols-6">
        {mainNavItems.map((item) => {
          const Icon = item.icon;
          const selected = item.id === activeView;
          return (
            <button
              key={item.id}
              type="button"
              aria-label={`Open ${mobileNavLabels[item.id]}`}
              onClick={() => onSelectView(item.id)}
              className={`flex flex-col items-center justify-center gap-1 text-[11px] font-medium ${
                selected ? "text-[#2463eb]" : "text-[#374151]"
              }`}
            >
              <Icon size={18} />
              {mobileNavLabels[item.id]}
            </button>
          );
        })}
        <button
          type="button"
          aria-label="Open Settings"
          onClick={onOpenSettings}
          className="flex flex-col items-center justify-center gap-1 text-[11px] font-medium text-[#374151]"
        >
          <Settings size={18} />
          Settings
        </button>
      </div>
    </nav>
  );
}
