"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import { animate, motion, useMotionValue, useReducedMotion } from "framer-motion";
import {
  mobileStackCommitTransition,
  mobileStackPushTransition,
  mobileStackReturnTransition,
  mobileSwipeBackConfig,
  reducedMotionTransition,
  resolveMobileSwipeBackRelease,
  shouldCancelMobileSwipeBack,
  shouldClaimMobileSwipeBack,
  shouldGuardMobileSwipeBackScroll,
  shouldReleaseMobileSwipeBackScrollGuard,
} from "./motionPrimitives";
import {
  currentMobileSwipeBackTimeMs,
  ensureMobileSwipeBackScrollLock,
  isInteractiveMobileSwipeBackTarget,
  mobileSwipeBackViewportWidth,
  releaseMobileSwipeBackScrollLock,
  type MobileSwipeBackDragState,
  type MobileSwipeBackScrollLockState,
  type MobileSwipeBackTouchGuardState,
} from "./mobileSwipeBack";

type MobileSessionStackMode = "list" | "chat";

interface MobileSessionStackProps {
  mode: MobileSessionStackMode;
  list: React.ReactNode;
  chat: React.ReactNode;
  listNav?: React.ReactNode;
  onOpenList: () => void;
}

interface DrawerIntentInput {
  startX?: number;
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

export const MOBILE_SESSION_STACK_INTERACTIVE_SELECTOR = "[data-ripple-ignore-chat-swipe]";

function mobileSessionTimelineScrollElement(root: Element): HTMLElement | null {
  return root.querySelector<HTMLElement>('[data-ripple-session-scroll="timeline"]');
}

export function shouldClaimMobileSessionDrawer({
  startX,
  deltaX,
  deltaY,
  viewportWidth,
}: DrawerIntentInput): boolean {
  return shouldClaimMobileSwipeBack({ startX, deltaX, deltaY, viewportWidth });
}

export function shouldGuardMobileSessionDrawerScroll({
  startX,
  deltaX,
  deltaY,
  viewportWidth,
}: DrawerIntentInput): boolean {
  return shouldGuardMobileSwipeBackScroll({ startX, deltaX, deltaY, viewportWidth });
}

export function shouldCancelMobileSessionDrawer({
  startX,
  deltaX,
  deltaY,
  viewportWidth,
}: DrawerIntentInput): boolean {
  return shouldCancelMobileSwipeBack({ startX, deltaX, deltaY, viewportWidth });
}

export function shouldReleaseMobileSessionDrawerScrollGuard({
  startX,
  deltaX,
  deltaY,
  viewportWidth,
}: DrawerIntentInput): boolean {
  return shouldReleaseMobileSwipeBackScrollGuard({ startX, deltaX, deltaY, viewportWidth });
}

export function resolveMobileSessionDrawerRelease({
  x,
  velocityX,
  viewportWidth,
}: DrawerReleaseInput): DrawerReleaseResolution {
  const release = resolveMobileSwipeBackRelease({ x, velocityX, viewportWidth });

  return { shouldOpenList: release.shouldCommit, commitDistance: release.commitDistance };
}

export function isInteractiveMobileSessionStackTarget(target: EventTarget | null): boolean {
  return isInteractiveMobileSwipeBackTarget(target, MOBILE_SESSION_STACK_INTERACTIVE_SELECTOR);
}

export default function MobileSessionStack({
  mode,
  list,
  chat,
  listNav = null,
  onOpenList,
}: MobileSessionStackProps) {
  const reduceMotion = useReducedMotion();
  const sheetX = useMotionValue(0);
  const dragStateRef = useRef<MobileSwipeBackDragState | null>(null);
  const suppressNextClickRef = useRef(false);
  const touchGuardStateRef = useRef<MobileSwipeBackTouchGuardState | null>(null);
  const scrollLockRef = useRef<MobileSwipeBackScrollLockState | null>(null);
  const activeSheetAnimationRef = useRef<ReturnType<typeof animate> | null>(null);
  const previousModeRef = useRef(mode);
  const enterAnimationFrameRef = useRef<number | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const shouldRenderChat = mode === "chat";

  const cancelEnterAnimationFrame = useCallback(() => {
    if (enterAnimationFrameRef.current === null || typeof window === "undefined") return;
    window.cancelAnimationFrame(enterAnimationFrameRef.current);
    enterAnimationFrameRef.current = null;
  }, []);

  const stopSheetAnimation = useCallback(() => {
    activeSheetAnimationRef.current?.stop();
    activeSheetAnimationRef.current = null;
  }, []);

  const releaseScrollLock = useCallback(() => {
    releaseMobileSwipeBackScrollLock(scrollLockRef.current);
    scrollLockRef.current = null;
  }, []);

  const animateSheetTo = useCallback(
    (target: number, onComplete?: () => void, transition = mobileStackReturnTransition) => {
      stopSheetAnimation();
      if (reduceMotion) {
        sheetX.set(target);
        onComplete?.();
        return;
      }

      const animation = animate(sheetX, target, transition);
      activeSheetAnimationRef.current = animation;
      void animation.then(() => {
        if (activeSheetAnimationRef.current === animation) {
          activeSheetAnimationRef.current = null;
        }
        onComplete?.();
      });
    },
    [reduceMotion, sheetX, stopSheetAnimation]
  );

  useEffect(() => {
    const previousMode = previousModeRef.current;
    previousModeRef.current = mode;
    cancelEnterAnimationFrame();
    stopSheetAnimation();
    dragStateRef.current = null;
    touchGuardStateRef.current = null;
    releaseScrollLock();

    if (mode === "chat" && previousMode === "list") {
      const currentViewportWidth = mobileSwipeBackViewportWidth();
      if (currentViewportWidth <= 0 || reduceMotion) {
        sheetX.set(0);
        return;
      }

      sheetX.set(currentViewportWidth);
      enterAnimationFrameRef.current = window.requestAnimationFrame(() => {
        enterAnimationFrameRef.current = null;
        animateSheetTo(0, undefined, mobileStackPushTransition);
      });
      return;
    }

    sheetX.set(0);
  }, [
    animateSheetTo,
    cancelEnterAnimationFrame,
    mode,
    reduceMotion,
    releaseScrollLock,
    sheetX,
    stopSheetAnimation,
  ]);

  useEffect(
    () => () => {
      cancelEnterAnimationFrame();
      stopSheetAnimation();
      releaseScrollLock();
    },
    [cancelEnterAnimationFrame, releaseScrollLock, stopSheetAnimation]
  );

  const handlePointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (mode !== "chat") return;
      if (!event.isPrimary || event.pointerType !== "touch") return;
      const currentViewportWidth = mobileSwipeBackViewportWidth();
      if (currentViewportWidth >= mobileSwipeBackConfig.desktopMinWidth) return;
      suppressNextClickRef.current = false;
      if (isInteractiveMobileSessionStackTarget(event.target)) return;
      stopSheetAnimation();
      const scrollElement = mobileSessionTimelineScrollElement(event.currentTarget);

      dragStateRef.current = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        viewportWidth: currentViewportWidth,
        claimed: false,
        lastX: event.clientX,
        lastTime: currentMobileSwipeBackTimeMs(),
        velocityX: 0,
        scrollElement,
        startScrollTop: scrollElement?.scrollTop ?? 0,
      };
    },
    [mode, stopSheetAnimation]
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
          startX: dragState.startX,
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
          startX: dragState.startX,
          deltaX,
          deltaY,
          viewportWidth: dragState.viewportWidth,
        })
      ) {
        dragState.claimed = true;
        suppressNextClickRef.current = true;
        setIsDragging(true);
        scrollLockRef.current = ensureMobileSwipeBackScrollLock(
          scrollLockRef.current,
          dragState.scrollElement,
          dragState.startScrollTop
        );
        try {
          event.currentTarget.setPointerCapture(event.pointerId);
        } catch {
          // Pointer capture can fail when the platform has already ended the gesture.
        }
      }

      if (!dragState.claimed) return;

      event.preventDefault();
      const currentTime = currentMobileSwipeBackTimeMs();
      const elapsed = Math.max(1, currentTime - dragState.lastTime);
      dragState.velocityX = ((event.clientX - dragState.lastX) / elapsed) * 1000;
      dragState.lastX = event.clientX;
      dragState.lastTime = currentTime;
      sheetX.set(Math.max(0, deltaX));
    },
    [sheetX]
  );

  const handleTouchStartCapture = useCallback(
    (event: React.TouchEvent<HTMLDivElement>) => {
      if (mode !== "chat") return;
      if (event.touches.length !== 1) return;
      const currentViewportWidth = mobileSwipeBackViewportWidth();
      if (currentViewportWidth >= mobileSwipeBackConfig.desktopMinWidth) return;
      if (isInteractiveMobileSessionStackTarget(event.target)) return;
      stopSheetAnimation();
      const touch = event.touches[0];
      if (!touch) return;
      const scrollElement = mobileSessionTimelineScrollElement(event.currentTarget);

      touchGuardStateRef.current = {
        startX: touch.clientX,
        startY: touch.clientY,
        viewportWidth: currentViewportWidth,
        isGuarding: false,
        scrollElement,
        startScrollTop: scrollElement?.scrollTop ?? 0,
      };
    },
    [mode, stopSheetAnimation]
  );

  const handleTouchMoveCapture = useCallback(
    (event: React.TouchEvent<HTMLDivElement>) => {
      const guardState = touchGuardStateRef.current;
      const touch = event.touches[0];
      if (!guardState || !touch) return;

      const deltaX = touch.clientX - guardState.startX;
      const deltaY = touch.clientY - guardState.startY;

      if (
        guardState.isGuarding &&
        shouldReleaseMobileSessionDrawerScrollGuard({
          startX: guardState.startX,
          deltaX,
          deltaY,
          viewportWidth: guardState.viewportWidth,
        })
      ) {
        touchGuardStateRef.current = null;
        releaseScrollLock();
        return;
      }

      if (
        !guardState.isGuarding &&
        shouldCancelMobileSessionDrawer({
          startX: guardState.startX,
          deltaX,
          deltaY,
          viewportWidth: guardState.viewportWidth,
        })
      ) {
        touchGuardStateRef.current = null;
        return;
      }

      if (
        guardState.isGuarding ||
        shouldGuardMobileSessionDrawerScroll({
          startX: guardState.startX,
          deltaX,
          deltaY,
          viewportWidth: guardState.viewportWidth,
        })
      ) {
        guardState.isGuarding = true;
        event.preventDefault();
        scrollLockRef.current = ensureMobileSwipeBackScrollLock(
          scrollLockRef.current,
          guardState.scrollElement,
          guardState.startScrollTop
        );
      }
    },
    [releaseScrollLock]
  );

  const clearTouchGuard = useCallback(() => {
    touchGuardStateRef.current = null;
    if (!dragStateRef.current?.claimed) releaseScrollLock();
  }, [releaseScrollLock]);

  const handleClickCapture = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    if (!suppressNextClickRef.current) return;
    suppressNextClickRef.current = false;
    event.preventDefault();
    event.stopPropagation();
  }, []);

  const cancelDrag = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const dragState = dragStateRef.current;
      if (dragState && dragState.pointerId === event.pointerId) {
        dragStateRef.current = null;
        setIsDragging(false);
        releaseScrollLock();
        animateSheetTo(0);
      }
    },
    [animateSheetTo, releaseScrollLock]
  );

  const handlePointerUp = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const dragState = dragStateRef.current;
      if (!dragState || dragState.pointerId !== event.pointerId) return;

      dragStateRef.current = null;
      releaseScrollLock();
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

      animateSheetTo(dragState.viewportWidth, onOpenList, mobileStackCommitTransition);
    },
    [animateSheetTo, onOpenList, releaseScrollLock, sheetX]
  );

  return (
    <div
      data-ripple-mobile-session-stack="true"
      className="relative h-full min-h-0 overflow-hidden bg-[#F5F6F7] lg:hidden"
    >
      <div data-ripple-mobile-session-list-layer="true" className="absolute inset-0 z-0">
        {list}
      </div>
      {listNav ? (
        <div
          data-ripple-mobile-session-list-nav-underlay="true"
          className="pointer-events-none absolute inset-0 z-[5]"
        >
          {listNav}
        </div>
      ) : null}
      {shouldRenderChat ? (
        <motion.div
          data-ripple-mobile-session-chat-sheet="true"
          data-ripple-mobile-session-chat-dragging={isDragging ? "true" : "false"}
          className={`absolute inset-0 z-10 h-full min-h-0 touch-pan-y border-l bg-[#F5F6F7] ${
            isDragging ? "border-[#D0D3D6]" : "border-transparent"
          } will-change-transform`}
          style={{ x: sheetX }}
          transition={reduceMotion ? reducedMotionTransition : mobileStackReturnTransition}
          onPointerDownCapture={handlePointerDown}
          onPointerMoveCapture={handlePointerMove}
          onPointerUpCapture={handlePointerUp}
          onPointerCancelCapture={cancelDrag}
          onClickCapture={handleClickCapture}
          onTouchStartCapture={handleTouchStartCapture}
          onTouchMoveCapture={handleTouchMoveCapture}
          onTouchEndCapture={clearTouchGuard}
          onTouchCancelCapture={clearTouchGuard}
        >
          {chat}
        </motion.div>
      ) : null}
    </div>
  );
}
