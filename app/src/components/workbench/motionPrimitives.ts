import type { Transition, Variants } from "framer-motion";

export const IOS_MOTION_EASE: [number, number, number, number] = [0.2, 0.8, 0.2, 1];
export const SWIPE_ACTION_THRESHOLD_PX = 48;
export const SWIPE_ACTION_WIDTH_PX = 64;
export const SWIPE_COMMIT_WIDTH_PX = 86;

export const pressableTap = { scale: 0.97 };

export const reducedMotionTransition: Transition = { duration: 0 };

export const mobileStackPushTransition: Transition = {
  duration: 0.18,
  ease: IOS_MOTION_EASE,
};

export const menuTransition: Transition = {
  duration: 0.12,
  ease: IOS_MOTION_EASE,
};

export const mobileStackReturnTransition: Transition = {
  duration: 0.16,
  ease: IOS_MOTION_EASE,
};

export const mobileStackCommitTransition: Transition = {
  duration: 0.16,
  ease: IOS_MOTION_EASE,
};

export const mobilePageSwitchTransition: Transition = {
  duration: 0.16,
  ease: IOS_MOTION_EASE,
};

export const mobilePageTransition: Transition = mobilePageSwitchTransition;

export const sheetTransition: Transition = mobileStackReturnTransition;

export const listItemTransition: Transition = {
  duration: 0.08,
  ease: IOS_MOTION_EASE,
};

export const swipeSnapTransition: Transition = {
  duration: 0.14,
  ease: IOS_MOTION_EASE,
};

export const mobileSwipeBackConfig = {
  desktopMinWidth: 1024,
  edgeStartWidthPx: 72,
  edgeScrollGuardDistancePx: 4,
  edgeScrollGuardRatio: 0.35,
  edgeClaimDistancePx: 4,
  edgeClaimRatio: 0.35,
  edgeCancelDistancePx: 28,
  edgeCancelRatio: 1.8,
  scrollGuardDistancePx: 20,
  scrollGuardRatio: 1.35,
  claimDistancePx: 28,
  claimRatio: 1.35,
  cancelDistancePx: 18,
  cancelRatio: 1.15,
  commitMaxPx: 72,
  commitViewportRatio: 0.18,
  fastCommitVelocityPx: 260,
  fastCommitDistancePx: 24,
} as const;

export interface MobileSwipeBackIntentInput {
  startX?: number;
  deltaX: number;
  deltaY: number;
  viewportWidth: number;
}

export interface MobileSwipeBackReleaseInput {
  x: number;
  velocityX: number;
  viewportWidth: number;
}

export interface MobileSwipeBackReleaseResolution {
  shouldCommit: boolean;
  commitDistance: number;
}

function isMobileSwipeBackEdgeStart(startX: number | undefined): boolean {
  return typeof startX === "number" && startX <= mobileSwipeBackConfig.edgeStartWidthPx;
}

export function shouldGuardMobileSwipeBackScroll({
  startX,
  deltaX,
  deltaY,
  viewportWidth,
}: MobileSwipeBackIntentInput): boolean {
  if (viewportWidth >= mobileSwipeBackConfig.desktopMinWidth) return false;
  const isEdgeStart = isMobileSwipeBackEdgeStart(startX);
  const guardDistance = isEdgeStart
    ? mobileSwipeBackConfig.edgeScrollGuardDistancePx
    : mobileSwipeBackConfig.scrollGuardDistancePx;
  const guardRatio = isEdgeStart
    ? mobileSwipeBackConfig.edgeScrollGuardRatio
    : mobileSwipeBackConfig.scrollGuardRatio;
  if (deltaX < guardDistance) return false;
  return deltaX > Math.abs(deltaY) * guardRatio;
}

export function shouldClaimMobileSwipeBack({
  startX,
  deltaX,
  deltaY,
  viewportWidth,
}: MobileSwipeBackIntentInput): boolean {
  if (viewportWidth >= mobileSwipeBackConfig.desktopMinWidth) return false;
  const isEdgeStart = isMobileSwipeBackEdgeStart(startX);
  const claimDistance = isEdgeStart
    ? mobileSwipeBackConfig.edgeClaimDistancePx
    : mobileSwipeBackConfig.claimDistancePx;
  const claimRatio = isEdgeStart
    ? mobileSwipeBackConfig.edgeClaimRatio
    : mobileSwipeBackConfig.claimRatio;
  if (deltaX < claimDistance) return false;
  return deltaX > Math.abs(deltaY) * claimRatio;
}

export function shouldCancelMobileSwipeBack({
  startX,
  deltaX,
  deltaY,
  viewportWidth,
}: MobileSwipeBackIntentInput): boolean {
  if (viewportWidth >= mobileSwipeBackConfig.desktopMinWidth) return true;
  const isEdgeStart = isMobileSwipeBackEdgeStart(startX);
  const cancelDistance = isEdgeStart
    ? mobileSwipeBackConfig.edgeCancelDistancePx
    : mobileSwipeBackConfig.cancelDistancePx;
  const cancelRatio = isEdgeStart
    ? mobileSwipeBackConfig.edgeCancelRatio
    : mobileSwipeBackConfig.cancelRatio;
  const absoluteDeltaY = Math.abs(deltaY);
  if (absoluteDeltaY < cancelDistance) return false;
  return absoluteDeltaY > Math.abs(deltaX) * cancelRatio;
}

export function shouldReleaseMobileSwipeBackScrollGuard(
  input: MobileSwipeBackIntentInput
): boolean {
  return shouldCancelMobileSwipeBack(input);
}

export function resolveMobileSwipeBackRelease({
  x,
  velocityX,
  viewportWidth,
}: MobileSwipeBackReleaseInput): MobileSwipeBackReleaseResolution {
  const commitDistance = Math.min(
    mobileSwipeBackConfig.commitMaxPx,
    viewportWidth * mobileSwipeBackConfig.commitViewportRatio
  );
  const shouldCommit =
    x >= commitDistance ||
    (velocityX >= mobileSwipeBackConfig.fastCommitVelocityPx &&
      x >= mobileSwipeBackConfig.fastCommitDistancePx);

  return { shouldCommit, commitDistance };
}

export const mobilePageVariants: Variants = {
  enter: (direction: number = 0) => ({
    x: direction > 0 ? 16 : direction < 0 ? -16 : 0,
  }),
  center: {
    x: 0,
  },
  exit: (direction: number = 0) => ({
    x: direction > 0 ? -12 : direction < 0 ? 12 : 0,
  }),
};

export const reducedMobilePageVariants: Variants = {
  enter: { x: 0 },
  center: { x: 0 },
  exit: { x: 0 },
};

export const searchExpandVariants: Variants = {
  collapsed: {
    height: 0,
    opacity: 0,
  },
  expanded: {
    height: "auto",
    opacity: 1,
  },
};

export const menuVariants: Variants = {
  hidden: {
    opacity: 0,
    scale: 0.96,
  },
  visible: {
    opacity: 1,
    scale: 1,
  },
};

export const sheetBackdropVariants: Variants = {
  hidden: { opacity: 0 },
  visible: { opacity: 1 },
};

export const sheetPanelVariants: Variants = {
  hidden: { opacity: 0, x: 24 },
  visible: { opacity: 1, x: 0 },
};

export const listItemVariants: Variants = {
  hidden: { opacity: 1, y: 0 },
  visible: () => ({
    opacity: 1,
    y: 0,
  }),
};
