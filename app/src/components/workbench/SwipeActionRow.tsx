"use client";

import React, { useCallback, useEffect, useMemo, useRef } from "react";
import { animate, motion, useMotionValue, useReducedMotion, type PanInfo } from "framer-motion";
import {
  SWIPE_ACTION_THRESHOLD_PX,
  SWIPE_ACTION_WIDTH_PX,
  SWIPE_COMMIT_WIDTH_PX,
  reducedMotionTransition,
  swipeSnapTransition,
} from "./motionPrimitives";

type SwipeActionTone = "neutral" | "accent" | "danger";

export interface SwipeAction {
  key: string;
  label: string;
  icon: React.ReactNode;
  tone?: SwipeActionTone;
  onClick: (event: React.MouseEvent<HTMLButtonElement>) => void;
}

interface SwipeActionRowProps extends Omit<
  React.HTMLAttributes<HTMLDivElement>,
  "children" | "onDrag"
> {
  children: React.ReactNode;
  trailingActions?: SwipeAction[];
  onSwipeRightCommit?: () => void;
  rightCommitLabel?: string;
  rightCommitIcon?: React.ReactNode;
  rightCommitTone?: SwipeActionTone;
  disabled?: boolean;
  contentClassName?: string;
}

function actionToneClass(tone: SwipeActionTone = "neutral"): string {
  if (tone === "danger") return "bg-[#ff3b30] text-white";
  if (tone === "accent") return "bg-[#007aff] text-white";
  return "bg-white/80 text-[#3c3c43]";
}

export default function SwipeActionRow({
  children,
  trailingActions = [],
  onSwipeRightCommit,
  rightCommitLabel,
  rightCommitIcon,
  rightCommitTone = "accent",
  disabled = false,
  className = "",
  contentClassName = "",
  ...rootProps
}: SwipeActionRowProps) {
  const reduceMotion = useReducedMotion();
  const x = useMotionValue(0);
  const openSideRef = useRef<"trailing" | null>(null);
  const trailingWidth = useMemo(
    () => Math.max(SWIPE_ACTION_WIDTH_PX, trailingActions.length * SWIPE_ACTION_WIDTH_PX),
    [trailingActions.length]
  );
  const hasTrailingActions = trailingActions.length > 0;
  const hasRightCommit = Boolean(onSwipeRightCommit);

  const snapTo = useCallback(
    (target: number, side: "trailing" | null) => {
      openSideRef.current = side;
      if (reduceMotion) {
        x.set(target);
        return;
      }
      void animate(x, target, swipeSnapTransition);
    },
    [reduceMotion, x]
  );

  const close = useCallback(() => {
    snapTo(0, null);
  }, [snapTo]);

  useEffect(() => {
    if (!disabled) return;
    openSideRef.current = null;
    x.set(0);
  }, [disabled, x]);

  const handleDragEnd = (_event: MouseEvent | TouchEvent | PointerEvent, info: PanInfo) => {
    if (disabled) {
      close();
      return;
    }

    const currentX = x.get();
    const swipeDistance = Math.abs(info.offset.x) > Math.abs(currentX) ? info.offset.x : currentX;

    if (swipeDistance <= -SWIPE_ACTION_THRESHOLD_PX && hasTrailingActions) {
      snapTo(-trailingWidth, "trailing");
      return;
    }

    if (swipeDistance >= SWIPE_ACTION_THRESHOLD_PX && hasRightCommit) {
      onSwipeRightCommit?.();
      close();
      return;
    }

    close();
  };

  const handleContentClickCapture = (event: React.MouseEvent<HTMLDivElement>) => {
    if (!openSideRef.current) return;
    event.preventDefault();
    event.stopPropagation();
    close();
  };

  const dragConstraints = {
    left: hasTrailingActions ? -trailingWidth : 0,
    right: hasRightCommit ? SWIPE_COMMIT_WIDTH_PX : 0,
  };

  return (
    <div
      {...rootProps}
      data-ripple-swipe-row="true"
      aria-disabled={disabled || undefined}
      className={`relative w-full touch-pan-y overflow-hidden ${className}`}
    >
      {hasRightCommit ? (
        <div
          aria-hidden="true"
          className={`absolute inset-y-0 left-0 flex w-[86px] items-center justify-center gap-1.5 rounded-2xl text-[11px] font-semibold ${actionToneClass(
            rightCommitTone
          )}`}
        >
          {rightCommitIcon}
          <span className="max-w-[54px] truncate">{rightCommitLabel}</span>
        </div>
      ) : null}

      {hasTrailingActions ? (
        <div className="absolute inset-y-0 right-0 flex overflow-hidden rounded-2xl">
          {trailingActions.map((action) => (
            <button
              key={action.key}
              type="button"
              aria-label={action.label}
              title={action.label}
              disabled={disabled}
              onClick={(event) => {
                event.stopPropagation();
                if (disabled) return;
                action.onClick(event);
                close();
              }}
              className={`flex w-16 flex-col items-center justify-center gap-1 text-[10px] leading-none font-semibold ${actionToneClass(
                action.tone
              )}`}
            >
              {action.icon}
              <span className="max-w-[56px] truncate">{action.label}</span>
            </button>
          ))}
        </div>
      ) : null}

      <motion.div
        drag={disabled ? false : "x"}
        dragConstraints={dragConstraints}
        dragDirectionLock
        dragElastic={0.08}
        dragMomentum={false}
        onDragEnd={handleDragEnd}
        style={{ x }}
        transition={reduceMotion ? reducedMotionTransition : swipeSnapTransition}
        className={`relative ${contentClassName}`}
        onClickCapture={handleContentClickCapture}
      >
        {children}
      </motion.div>
    </div>
  );
}
