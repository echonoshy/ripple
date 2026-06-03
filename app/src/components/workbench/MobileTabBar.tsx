"use client";

import React from "react";
import { motion, useReducedMotion } from "framer-motion";
import { IconTile } from "@/components/icons/IconTile";
import { type MessageKey, useI18n } from "@/i18n";
import { mobileNavItems, type WorkspaceView } from "@/lib/workspaceViews";
import { mobilePageTransition, pressableTap, reducedMotionTransition } from "./motionPrimitives";
import {
  COMPACT_IOS_PAGE_BACKGROUND,
  LUCIDE_NAV_STROKE_WIDTH,
  MOBILE_TAB_BAR_MASK_HEIGHT_CLASS,
  TYPOGRAPHY_MICRO_MEDIUM_CLASS,
} from "./stylePrimitives";

interface MobileTabBarProps {
  activeView: WorkspaceView;
  onSelectView: (view: WorkspaceView) => void;
}

const mobileNavLabelKeys: Record<WorkspaceView, MessageKey> = {
  sessions: "nav.sessions",
  files: "nav.files",
  skills: "nav.skills",
  connectors: "nav.connectors",
  automations: "nav.automations",
  home: "nav.settings",
};

export default function MobileTabBar({ activeView, onSelectView }: MobileTabBarProps) {
  const { t } = useI18n();
  const reduceMotion = useReducedMotion();
  const transition = reduceMotion ? reducedMotionTransition : mobilePageTransition;

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-0 z-30 lg:hidden">
      <div
        data-ripple-mobile-tabbar-mask="true"
        aria-hidden="true"
        className={`absolute inset-x-0 bottom-0 ${MOBILE_TAB_BAR_MASK_HEIGHT_CLASS} ${COMPACT_IOS_PAGE_BACKGROUND}`}
      />
      <nav
        data-ripple-mobile-tabbar-nav="true"
        className="pointer-events-auto relative mx-3 mb-[max(env(safe-area-inset-bottom),10px)] rounded-[28px] border border-white/78 bg-white/74 px-2 py-1 shadow-[0_18px_44px_rgba(60,60,67,0.20)] backdrop-blur-2xl"
      >
        <div
          className="mx-auto grid h-[58px] max-w-md"
          style={{ gridTemplateColumns: `repeat(${mobileNavItems.length}, minmax(0, 1fr))` }}
        >
          {mobileNavItems.map((item) => {
            const Icon = item.icon;
            const selected = item.id === activeView;
            const label = t(mobileNavLabelKeys[item.id]);
            return (
              <motion.button
                key={item.id}
                type="button"
                aria-label={t("nav.open", { label })}
                onClick={() => onSelectView(item.id)}
                whileTap={reduceMotion ? undefined : pressableTap}
                transition={transition}
                className={`group flex min-w-0 flex-col items-center justify-center gap-0.5 ${TYPOGRAPHY_MICRO_MEDIUM_CLASS} transition-colors ${
                  selected ? "text-[#007aff]" : "text-[#3c3c43]"
                }`}
              >
                <motion.span
                  animate={{ scale: selected && !reduceMotion ? 1.06 : 1 }}
                  transition={transition}
                  className="inline-flex"
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
                </motion.span>
                <span className="max-w-full truncate">{label}</span>
              </motion.button>
            );
          })}
        </div>
      </nav>
    </div>
  );
}
