"use client";

import React from "react";
import { IconTile } from "@/components/icons/IconTile";
import { type MessageKey, useI18n } from "@/i18n";
import { mobileNavItems, type WorkspaceView } from "@/lib/workspaceViews";
import { LUCIDE_NAV_STROKE_WIDTH } from "./stylePrimitives";

interface MobileTabBarProps {
  activeView: WorkspaceView;
  onSelectView: (view: WorkspaceView) => void;
}

const mobileNavLabelKeys: Record<WorkspaceView, MessageKey> = {
  sessions: "nav.sessions",
  files: "nav.files",
  connectors: "nav.connectors",
  automations: "nav.automations",
  home: "nav.settings",
};

export default function MobileTabBar({ activeView, onSelectView }: MobileTabBarProps) {
  const { t } = useI18n();

  return (
    <nav className="fixed right-3 bottom-[max(env(safe-area-inset-bottom),10px)] left-3 z-30 rounded-[28px] border border-white/78 bg-white/74 px-2 py-1 shadow-[0_18px_44px_rgba(60,60,67,0.20)] backdrop-blur-2xl lg:hidden">
      <div
        className="mx-auto grid h-[58px] max-w-md"
        style={{ gridTemplateColumns: `repeat(${mobileNavItems.length}, minmax(0, 1fr))` }}
      >
        {mobileNavItems.map((item) => {
          const Icon = item.icon;
          const selected = item.id === activeView;
          const label = t(mobileNavLabelKeys[item.id]);
          return (
            <button
              key={item.id}
              type="button"
              aria-label={t("nav.open", { label })}
              onClick={() => onSelectView(item.id)}
              className={`group flex min-w-0 flex-col items-center justify-center gap-0.5 text-[9px] leading-none font-semibold transition-colors ${
                selected ? "text-[#007aff]" : "text-[#3c3c43]"
              }`}
            >
              <IconTile
                tone={selected ? "accent" : "neutral"}
                size="sm"
                className={
                  selected
                    ? "shadow-[0_6px_16px_rgba(0,122,255,0.12)]"
                    : "group-active:border-[#cfe4ff] group-active:bg-[#eaf4ff]"
                }
              >
                <Icon size={15} strokeWidth={LUCIDE_NAV_STROKE_WIDTH} />
              </IconTile>
              <span className="max-w-full truncate">{label}</span>
            </button>
          );
        })}
      </div>
    </nav>
  );
}
