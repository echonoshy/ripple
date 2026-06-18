export interface MobileSwipeBackDragState {
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

export interface MobileSwipeBackTouchGuardState {
  startX: number;
  startY: number;
  viewportWidth: number;
  isGuarding: boolean;
  scrollElement: HTMLElement | null;
  startScrollTop: number;
}

export interface MobileSwipeBackScrollLockState {
  scrollElement: HTMLElement;
  startScrollTop: number;
  previousOverflowY: string;
  previousOverscrollBehaviorY: string;
}

export function currentMobileSwipeBackTimeMs(): number {
  return typeof performance === "undefined" ? Date.now() : performance.now();
}

export function mobileSwipeBackViewportWidth(): number {
  return typeof window === "undefined" ? 0 : window.innerWidth;
}

export function isInteractiveMobileSwipeBackTarget(
  target: EventTarget | null,
  selector: string
): boolean {
  if (typeof Element === "undefined" || !(target instanceof Element)) return false;
  return Boolean(target.closest(selector));
}

export function ensureMobileSwipeBackScrollLock(
  currentLock: MobileSwipeBackScrollLockState | null,
  scrollElement: HTMLElement | null,
  startScrollTop: number
): MobileSwipeBackScrollLockState | null {
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

export function releaseMobileSwipeBackScrollLock(
  lock: MobileSwipeBackScrollLockState | null
): void {
  if (!lock) return;
  const { scrollElement, startScrollTop, previousOverflowY, previousOverscrollBehaviorY } = lock;
  scrollElement.style.overflowY = previousOverflowY;
  scrollElement.style.overscrollBehaviorY = previousOverscrollBehaviorY;
  scrollElement.scrollTop = startScrollTop;
}
