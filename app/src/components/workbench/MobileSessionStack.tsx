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

interface DragState {
  pointerId: number;
  startX: number;
  startY: number;
  viewportWidth: number;
  claimed: boolean;
  lastX: number;
  lastTime: number;
  velocityX: number;
  scrollElement: HTMLElement | null;
  startScrollTop: number;
}

interface ScrollLockState {
  scrollElement: HTMLElement;
  startScrollTop: number;
  previousOverflowY: string;
  previousOverscrollBehaviorY: string;
}

interface TouchGuardState {
  startX: number;
  startY: number;
  viewportWidth: number;
  isGuarding: boolean;
  scrollElement: HTMLElement | null;
  startScrollTop: number;
}

export const MOBILE_SESSION_STACK_INTERACTIVE_SELECTOR =
  "a, button, input, textarea, select, summary, [contenteditable='true'], [role='button'], [data-ripple-ignore-chat-swipe]";

function nowMs(): number {
  return typeof performance === "undefined" ? Date.now() : performance.now();
}

function viewportWidth(): number {
  return typeof window === "undefined" ? 0 : window.innerWidth;
}

function mobileSessionTimelineScrollElement(root: Element): HTMLElement | null {
  return root.querySelector<HTMLElement>('[data-ripple-session-scroll="timeline"]');
}

function ensureMobileSessionScrollLock(
  currentLock: ScrollLockState | null,
  scrollElement: HTMLElement | null,
  startScrollTop: number
): ScrollLockState | null {
  if (currentLock) return currentLock;
  if (!scrollElement) return null;
  const lock = {
    scrollElement,
    startScrollTop,
    previousOverflowY: scrollElement.style.overflowY,
    previousOverscrollBehaviorY: scrollElement.style.overscrollBehaviorY,
  };
  scrollElement.scrollTop = startScrollTop;
  scrollElement.style.overflowY = "hidden";
  scrollElement.style.overscrollBehaviorY = "contain";
  return lock;
}

function releaseMobileSessionScrollLock(lock: ScrollLockState | null): void {
  if (!lock) return;
  const { scrollElement, startScrollTop, previousOverflowY, previousOverscrollBehaviorY } = lock;
  scrollElement.style.overflowY = previousOverflowY;
  scrollElement.style.overscrollBehaviorY = previousOverscrollBehaviorY;
  scrollElement.scrollTop = startScrollTop;
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
  if (typeof Element === "undefined" || !(target instanceof Element)) return false;
  return Boolean(target.closest(MOBILE_SESSION_STACK_INTERACTIVE_SELECTOR));
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
  const dragStateRef = useRef<DragState | null>(null);
  const touchGuardStateRef = useRef<TouchGuardState | null>(null);
  const scrollLockRef = useRef<ScrollLockState | null>(null);
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
    releaseMobileSessionScrollLock(scrollLockRef.current);
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
      const currentViewportWidth = viewportWidth();
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
      const currentViewportWidth = viewportWidth();
      if (currentViewportWidth >= mobileSwipeBackConfig.desktopMinWidth) return;
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
        lastTime: nowMs(),
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
        setIsDragging(true);
        scrollLockRef.current = ensureMobileSessionScrollLock(
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
      const currentTime = nowMs();
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
      const currentViewportWidth = viewportWidth();
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
        scrollLockRef.current = ensureMobileSessionScrollLock(
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
          className="absolute inset-0 z-10 h-full min-h-0 touch-pan-y bg-[#F5F6F7] shadow-[-18px_0_44px_rgba(31,35,41,0.18)] will-change-transform"
          style={{ x: sheetX }}
          transition={reduceMotion ? reducedMotionTransition : mobileStackReturnTransition}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={cancelDrag}
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
