"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import { animate, motion, useMotionValue, useReducedMotion } from "framer-motion";
import { mobilePageTransition, reducedMotionTransition, swipeSnapTransition } from "./motionPrimitives";

type MobileSessionStackMode = "list" | "chat";

interface MobileSessionStackProps {
  mode: MobileSessionStackMode;
  list: React.ReactNode;
  chat: React.ReactNode;
  onOpenList: () => void;
}

interface DrawerIntentInput {
  deltaX: number;
  deltaY: number;
  viewportWidth: number;
}

interface DrawerReleaseInput {
  x: number;
  velocityX: number;
  viewportWidth: number;
}

interface DrawerReleaseResolution {
  shouldOpenList: boolean;
  commitDistance: number;
}

interface DragState {
  pointerId: number;
  startX: number;
  startY: number;
  viewportWidth: number;
  claimed: boolean;
  lastX: number;
  lastTime: number;
  velocityX: number;
}

const MOBILE_SESSION_STACK_DESKTOP_MIN_WIDTH_PX = 1024;
const MOBILE_SESSION_STACK_CLAIM_DISTANCE_PX = 16;
const MOBILE_SESSION_STACK_CLAIM_RATIO = 1.15;
const MOBILE_SESSION_STACK_COMMIT_MAX_PX = 160;
const MOBILE_SESSION_STACK_COMMIT_VIEWPORT_RATIO = 0.38;
const MOBILE_SESSION_STACK_FAST_COMMIT_VELOCITY_PX = 650;
const MOBILE_SESSION_STACK_FAST_COMMIT_DISTANCE_PX = 72;

export const MOBILE_SESSION_STACK_INTERACTIVE_SELECTOR =
  "a, button, input, textarea, select, summary, [contenteditable='true'], [role='button'], [data-ripple-ignore-chat-swipe]";

function nowMs(): number {
  return typeof performance === "undefined" ? Date.now() : performance.now();
}

function viewportWidth(): number {
  return typeof window === "undefined" ? 0 : window.innerWidth;
}

export function shouldClaimMobileSessionDrawer({
  deltaX,
  deltaY,
  viewportWidth,
}: DrawerIntentInput): boolean {
  if (viewportWidth >= MOBILE_SESSION_STACK_DESKTOP_MIN_WIDTH_PX) return false;
  if (deltaX < MOBILE_SESSION_STACK_CLAIM_DISTANCE_PX) return false;
  return deltaX > Math.abs(deltaY) * MOBILE_SESSION_STACK_CLAIM_RATIO;
}

export function shouldCancelMobileSessionDrawer({
  deltaX,
  deltaY,
  viewportWidth,
}: DrawerIntentInput): boolean {
  if (viewportWidth >= MOBILE_SESSION_STACK_DESKTOP_MIN_WIDTH_PX) return true;
  const absoluteDeltaY = Math.abs(deltaY);
  if (absoluteDeltaY < MOBILE_SESSION_STACK_CLAIM_DISTANCE_PX) return false;
  return absoluteDeltaY > Math.abs(deltaX) * MOBILE_SESSION_STACK_CLAIM_RATIO;
}

export function resolveMobileSessionDrawerRelease({
  x,
  velocityX,
  viewportWidth,
}: DrawerReleaseInput): DrawerReleaseResolution {
  const commitDistance = Math.min(
    MOBILE_SESSION_STACK_COMMIT_MAX_PX,
    viewportWidth * MOBILE_SESSION_STACK_COMMIT_VIEWPORT_RATIO
  );
  const shouldOpenList =
    x >= commitDistance ||
    (velocityX >= MOBILE_SESSION_STACK_FAST_COMMIT_VELOCITY_PX &&
      x >= MOBILE_SESSION_STACK_FAST_COMMIT_DISTANCE_PX);

  return { shouldOpenList, commitDistance };
}

export function isInteractiveMobileSessionStackTarget(target: EventTarget | null): boolean {
  if (typeof Element === "undefined" || !(target instanceof Element)) return false;
  return Boolean(target.closest(MOBILE_SESSION_STACK_INTERACTIVE_SELECTOR));
}

export default function MobileSessionStack({
  mode,
  list,
  chat,
  onOpenList,
}: MobileSessionStackProps) {
  const reduceMotion = useReducedMotion();
  const sheetX = useMotionValue(0);
  const dragStateRef = useRef<DragState | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const shouldRenderChat = mode === "chat";

  const animateSheetTo = useCallback(
    (target: number, onComplete?: () => void) => {
      if (reduceMotion) {
        sheetX.set(target);
        onComplete?.();
        return;
      }

      void animate(sheetX, target, target === 0 ? swipeSnapTransition : mobilePageTransition).then(
        () => {
          onComplete?.();
        }
      );
    },
    [reduceMotion, sheetX]
  );

  useEffect(() => {
    dragStateRef.current = null;
    sheetX.set(0);
  }, [mode, sheetX]);

  const handlePointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (mode !== "chat") return;
      if (!event.isPrimary || event.pointerType !== "touch") return;
      const currentViewportWidth = viewportWidth();
      if (currentViewportWidth >= MOBILE_SESSION_STACK_DESKTOP_MIN_WIDTH_PX) return;
      if (isInteractiveMobileSessionStackTarget(event.target)) return;

      dragStateRef.current = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        viewportWidth: currentViewportWidth,
        claimed: false,
        lastX: event.clientX,
        lastTime: nowMs(),
        velocityX: 0,
      };
    },
    [mode]
  );

  const handlePointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const dragState = dragStateRef.current;
      if (!dragState || dragState.pointerId !== event.pointerId) return;

      const deltaX = event.clientX - dragState.startX;
      const deltaY = event.clientY - dragState.startY;

      if (
        !dragState.claimed &&
        shouldCancelMobileSessionDrawer({
          deltaX,
          deltaY,
          viewportWidth: dragState.viewportWidth,
        })
      ) {
        dragStateRef.current = null;
        return;
      }

      if (
        !dragState.claimed &&
        shouldClaimMobileSessionDrawer({
          deltaX,
          deltaY,
          viewportWidth: dragState.viewportWidth,
        })
      ) {
        dragState.claimed = true;
        setIsDragging(true);
        try {
          event.currentTarget.setPointerCapture(event.pointerId);
        } catch {
          // Pointer capture can fail when the platform has already ended the gesture.
        }
      }

      if (!dragState.claimed) return;

      event.preventDefault();
      const currentTime = nowMs();
      const elapsed = Math.max(1, currentTime - dragState.lastTime);
      dragState.velocityX = ((event.clientX - dragState.lastX) / elapsed) * 1000;
      dragState.lastX = event.clientX;
      dragState.lastTime = currentTime;
      sheetX.set(Math.max(0, deltaX));
    },
    [sheetX]
  );

  const cancelDrag = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const dragState = dragStateRef.current;
      if (dragState && dragState.pointerId === event.pointerId) {
        dragStateRef.current = null;
        setIsDragging(false);
        animateSheetTo(0);
      }
    },
    [animateSheetTo]
  );

  const handlePointerUp = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const dragState = dragStateRef.current;
      if (!dragState || dragState.pointerId !== event.pointerId) return;

      dragStateRef.current = null;
      try {
        event.currentTarget.releasePointerCapture(event.pointerId);
      } catch {
        // Matching setPointerCapture may not have succeeded on every platform.
      }

      if (!dragState.claimed) return;
      event.preventDefault();
      setIsDragging(false);

      const release = resolveMobileSessionDrawerRelease({
        x: sheetX.get(),
        velocityX: dragState.velocityX,
        viewportWidth: dragState.viewportWidth,
      });

      if (!release.shouldOpenList) {
        animateSheetTo(0);
        return;
      }

      animateSheetTo(dragState.viewportWidth, () => {
        sheetX.set(0);
        onOpenList();
      });
    },
    [animateSheetTo, onOpenList, sheetX]
  );

  return (
    <div
      data-ripple-mobile-session-stack="true"
      className="relative h-full min-h-0 overflow-hidden bg-[#F5F6F7] lg:hidden"
    >
      <div data-ripple-mobile-session-list-layer="true" className="absolute inset-0 z-0">
        {list}
      </div>
      {shouldRenderChat ? (
        <motion.div
          data-ripple-mobile-session-chat-sheet="true"
          data-ripple-mobile-session-chat-dragging={isDragging ? "true" : "false"}
          className="absolute inset-0 z-10 h-full min-h-0 touch-pan-y bg-[#F5F6F7] shadow-[-18px_0_44px_rgba(31,35,41,0.18)]"
          style={{ x: sheetX }}
          transition={reduceMotion ? reducedMotionTransition : swipeSnapTransition}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={cancelDrag}
        >
          {chat}
        </motion.div>
      ) : null}
    </div>
  );
}
