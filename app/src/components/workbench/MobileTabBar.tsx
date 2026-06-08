"use client";

import React from "react";
import { motion, useReducedMotion } from "framer-motion";
import { IconTile } from "@/components/icons/IconTile";
import { type MessageKey, useI18n } from "@/i18n";
import { mobileNavItems, type WorkspaceView } from "@/lib/workspaceViews";
import {
  mobilePageSwitchTransition,
  pressableTap,
  reducedMotionTransition,
} from "./motionPrimitives";
import {
  LUCIDE_NAV_STROKE_WIDTH,
  MOBILE_TAB_BAR_MASK_HEIGHT_CLASS,
  TYPOGRAPHY_MICRO_MEDIUM_CLASS,
  WORKBENCH_PAGE_BACKGROUND_CLASS,
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
  const transition = reduceMotion ? reducedMotionTransition : mobilePageSwitchTransition;

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-0 z-30 lg:hidden">
      <div
        data-ripple-mobile-tabbar-mask="true"
        aria-hidden="true"
        className={`absolute inset-x-0 bottom-0 ${MOBILE_TAB_BAR_MASK_HEIGHT_CLASS} ${WORKBENCH_PAGE_BACKGROUND_CLASS}`}
      />
      <nav
        data-ripple-mobile-tabbar-nav="true"
        className="pointer-events-auto relative mx-3 mb-[max(env(safe-area-inset-bottom),10px)] rounded-2xl border border-[#DEE0E3] bg-white px-2 py-1 shadow-[0_8px_24px_rgba(31,35,41,0.10)]"
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
                  selected ? "text-[#1456F0]" : "text-[#2B2F36]"
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
                        ? "shadow-[0_6px_16px_rgba(20,86,240,0.12)]"
                        : "group-active:border-[#BACEFD] group-active:bg-[#F0F5FF]"
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
