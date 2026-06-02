"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { animate, motion, useMotionValue, useReducedMotion, type PanInfo } from "framer-motion";
import {
  SWIPE_ACTION_THRESHOLD_PX,
  SWIPE_ACTION_WIDTH_PX,
  SWIPE_COMMIT_WIDTH_PX,
  reducedMotionTransition,
  swipeSnapTransition,
} from "./motionPrimitives";

type SwipeActionTone = "neutral" | "accent" | "danger";
type SwipeSide = "leading" | "trailing";

interface SwipeEndInput {
  openedSide: SwipeSide | null;
  currentX: number;
  offsetX: number;
  leadingWidth: number;
  trailingWidth: number;
  hasLeadingActions: boolean;
  hasTrailingActions: boolean;
  hasRightCommit: boolean;
  threshold?: number;
}

interface SwipeEndResolution {
  side: SwipeSide | null;
  target: number;
  shouldCommitRight: boolean;
}

interface SwipeDragConstraintsInput {
  visibleSide: SwipeSide | null;
  leadingWidth: number;
  trailingWidth: number;
  hasLeadingActions: boolean;
  hasTrailingActions: boolean;
  hasRightCommit: boolean;
}

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
  leadingActions?: SwipeAction[];
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

export function resolveSwipeActionRowEnd({
  openedSide,
  currentX,
  offsetX,
  leadingWidth,
  trailingWidth,
  hasLeadingActions,
  hasTrailingActions,
  hasRightCommit,
  threshold = SWIPE_ACTION_THRESHOLD_PX,
}: SwipeEndInput): SwipeEndResolution {
  const swipeDistance = Math.abs(offsetX) > Math.abs(currentX) ? offsetX : currentX;

  if (openedSide === "trailing" && offsetX >= threshold) {
    return { side: null, target: 0, shouldCommitRight: false };
  }

  if (openedSide === "leading" && offsetX <= -threshold) {
    return { side: null, target: 0, shouldCommitRight: false };
  }

  if (swipeDistance <= -threshold && hasTrailingActions) {
    return { side: "trailing", target: -trailingWidth, shouldCommitRight: false };
  }

  if (swipeDistance >= threshold && hasLeadingActions) {
    return { side: "leading", target: leadingWidth, shouldCommitRight: false };
  }

  if (swipeDistance >= threshold && hasRightCommit) {
    return { side: null, target: 0, shouldCommitRight: true };
  }

  return { side: null, target: 0, shouldCommitRight: false };
}

export function getSwipeActionRowDragConstraints({
  visibleSide,
  leadingWidth,
  trailingWidth,
  hasLeadingActions,
  hasTrailingActions,
  hasRightCommit,
}: SwipeDragConstraintsInput) {
  if (visibleSide === "trailing") {
    return {
      left: hasTrailingActions ? -trailingWidth : 0,
      right: 0,
    };
  }

  if (visibleSide === "leading") {
    return {
      left: 0,
      right: hasLeadingActions ? leadingWidth : hasRightCommit ? SWIPE_COMMIT_WIDTH_PX : 0,
    };
  }

  return {
    left: hasTrailingActions ? -trailingWidth : 0,
    right: hasLeadingActions ? leadingWidth : hasRightCommit ? SWIPE_COMMIT_WIDTH_PX : 0,
  };
}

export default function SwipeActionRow({
  children,
  leadingActions = [],
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
  const openedSideBeforeDragRef = useRef<SwipeSide | null>(null);
  const [visibleSide, setVisibleSide] = useState<SwipeSide | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [dragOriginSide, setDragOriginSide] = useState<SwipeSide | null>(null);
  const leadingWidth = useMemo(
    () => Math.max(SWIPE_ACTION_WIDTH_PX, leadingActions.length * SWIPE_ACTION_WIDTH_PX),
    [leadingActions.length]
  );
  const trailingWidth = useMemo(
    () => Math.max(SWIPE_ACTION_WIDTH_PX, trailingActions.length * SWIPE_ACTION_WIDTH_PX),
    [trailingActions.length]
  );
  const hasLeadingActions = leadingActions.length > 0;
  const hasTrailingActions = trailingActions.length > 0;
  const hasRightCommit = Boolean(onSwipeRightCommit);

  const snapTo = useCallback(
    (target: number, side: "leading" | "trailing" | null) => {
      setVisibleSide(side);
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
    x.set(0);
  }, [disabled, x]);

  const handleDragEnd = (_event: MouseEvent | TouchEvent | PointerEvent, info: PanInfo) => {
    if (disabled) {
      setIsDragging(false);
      setDragOriginSide(null);
      openedSideBeforeDragRef.current = null;
      close();
      return;
    }

    const resolution = resolveSwipeActionRowEnd({
      openedSide: openedSideBeforeDragRef.current,
      currentX: x.get(),
      offsetX: info.offset.x,
      leadingWidth,
      trailingWidth,
      hasLeadingActions,
      hasTrailingActions,
      hasRightCommit,
    });

    setIsDragging(false);
    setDragOriginSide(null);
    openedSideBeforeDragRef.current = null;

    if (resolution.shouldCommitRight) {
      onSwipeRightCommit?.();
      close();
      return;
    }

    snapTo(resolution.target, resolution.side);
  };

  const handleContentClickCapture = (event: React.MouseEvent<HTMLDivElement>) => {
    if (disabled || !visibleSide) return;
    event.preventDefault();
    event.stopPropagation();
    close();
  };

  const dragConstraints = getSwipeActionRowDragConstraints({
    visibleSide,
    leadingWidth,
    trailingWidth,
    hasLeadingActions,
    hasTrailingActions,
    hasRightCommit,
  });
  const effectiveVisibleSide = disabled ? null : visibleSide;
  const getActionVisibilityClass = (side: "leading" | "trailing") =>
    effectiveVisibleSide === side ||
    (isDragging && !dragOriginSide) ||
    (isDragging && dragOriginSide === side)
      ? "opacity-100"
      : "opacity-0";
  const getActionPointerClass = (side: "leading" | "trailing") =>
    effectiveVisibleSide === side ? "pointer-events-auto" : "pointer-events-none";
  const shouldRenderLeadingActions = !disabled && hasLeadingActions;
  const shouldRenderLeadingCommit = !disabled && !hasLeadingActions && hasRightCommit;
  const shouldRenderTrailingActions = !disabled && hasTrailingActions;

  return (
    <div
      {...rootProps}
      data-ripple-swipe-row="true"
      aria-disabled={disabled || undefined}
      className={`relative w-full touch-pan-y overflow-hidden ${className}`}
    >
      {shouldRenderLeadingActions ? (
        <div
          data-ripple-swipe-actions="leading"
          className={`absolute inset-y-0 left-0 flex overflow-hidden rounded-2xl transition-opacity duration-100 ${getActionVisibilityClass(
            "leading"
          )} ${getActionPointerClass("leading")}`}
        >
          {leadingActions.map((action) => (
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
              className={`flex w-16 flex-col items-center justify-center gap-1 text-[11px] leading-none font-semibold ${actionToneClass(
                action.tone
              )}`}
            >
              {action.icon}
              <span className="max-w-[56px] truncate">{action.label}</span>
            </button>
          ))}
        </div>
      ) : null}

      {shouldRenderLeadingCommit ? (
        <div
          data-ripple-swipe-actions="leading"
          aria-hidden="true"
          className={`absolute inset-y-0 left-0 flex w-[86px] items-center justify-center gap-1.5 rounded-2xl text-[11px] font-semibold transition-opacity duration-100 ${getActionVisibilityClass(
            "leading"
          )} ${getActionPointerClass("leading")} ${actionToneClass(rightCommitTone)}`}
        >
          {rightCommitIcon}
          {rightCommitLabel ? (
            <span className="max-w-[54px] truncate">{rightCommitLabel}</span>
          ) : null}
        </div>
      ) : null}

      {shouldRenderTrailingActions ? (
        <div
          data-ripple-swipe-actions="trailing"
          className={`absolute inset-y-0 right-0 flex overflow-hidden rounded-2xl transition-opacity duration-100 ${getActionVisibilityClass(
            "trailing"
          )} ${getActionPointerClass("trailing")}`}
        >
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
              className={`flex w-16 flex-col items-center justify-center gap-1 text-[11px] leading-none font-semibold ${actionToneClass(
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
        onDragStart={() => {
          openedSideBeforeDragRef.current = visibleSide;
          setDragOriginSide(visibleSide);
          setIsDragging(true);
        }}
        onDragEnd={handleDragEnd}
        style={{ x }}
        transition={reduceMotion ? reducedMotionTransition : swipeSnapTransition}
        className={`relative w-full ${contentClassName}`}
        onClickCapture={handleContentClickCapture}
      >
        {children}
      </motion.div>
    </div>
  );
}
