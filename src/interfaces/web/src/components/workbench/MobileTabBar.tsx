"use client";

import React from "react";
import { BriefcaseBusiness, FileText, Home, Settings } from "lucide-react";

interface MobileTabBarProps {
  onOpenNav: () => void;
  onOpenSettings: () => void;
}

export default function MobileTabBar({ onOpenNav, onOpenSettings }: MobileTabBarProps) {
  const items = [
    { label: "Home", icon: Home, onClick: onOpenNav },
    { label: "Tasks", icon: BriefcaseBusiness, selected: true, onClick: onOpenNav },
    { label: "Files", icon: FileText, onClick: onOpenNav },
    { label: "Settings", icon: Settings, onClick: onOpenSettings },
  ];

  return (
    <nav className="fixed right-0 bottom-0 left-0 z-30 border-t border-[#e5e7eb] bg-white/96 px-3 pb-[max(env(safe-area-inset-bottom),10px)] shadow-[0_-10px_30px_rgba(23,26,31,0.06)] backdrop-blur lg:hidden">
      <div className="mx-auto grid h-16 max-w-md grid-cols-4">
        {items.map((item) => {
          const Icon = item.icon;
          return (
            <button
              key={item.label}
              type="button"
              onClick={item.onClick}
              className={`flex flex-col items-center justify-center gap-1 text-[11px] font-medium ${
                item.selected ? "text-[#2463eb]" : "text-[#374151]"
              }`}
            >
              <Icon size={18} />
              {item.label}
            </button>
          );
        })}
      </div>
    </nav>
  );
}
