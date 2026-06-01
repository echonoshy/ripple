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
    <nav className="fixed right-0 bottom-0 left-0 z-30 min-h-[calc(64px+env(safe-area-inset-bottom))] border-t border-white/70 bg-white/72 px-2 pt-1 pb-[max(env(safe-area-inset-bottom),10px)] shadow-[0_-12px_30px_rgba(44,63,123,0.10)] backdrop-blur-2xl lg:hidden">
      <div
        className="mx-auto grid h-[60px] max-w-md"
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
                selected ? "text-[#2463eb]" : "text-[#3f4655]"
              }`}
            >
              <IconTile
                tone={selected ? "accent" : "neutral"}
                size="sm"
                className={
                  selected
                    ? "shadow-[0_6px_16px_rgba(36,99,235,0.10)]"
                    : "group-active:border-[#d7e3f8] group-active:bg-[#eef4ff]"
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
