import type { Transition, Variants } from "framer-motion";

export const IOS_MOTION_EASE: [number, number, number, number] = [0.2, 0.8, 0.2, 1];
export const SWIPE_ACTION_THRESHOLD_PX = 48;
export const SWIPE_ACTION_WIDTH_PX = 64;
export const SWIPE_COMMIT_WIDTH_PX = 86;

export const pressableTap = { scale: 0.97 };

export const reducedMotionTransition: Transition = { duration: 0 };

export const mobileStackPushTransition: Transition = {
  duration: 0.3,
  ease: IOS_MOTION_EASE,
};

export const menuTransition: Transition = {
  duration: 0.12,
  ease: IOS_MOTION_EASE,
};

export const mobileStackReturnTransition: Transition = {
  duration: 0.22,
  ease: IOS_MOTION_EASE,
};

export const mobilePageSwitchTransition: Transition = {
  duration: 0.3,
  ease: IOS_MOTION_EASE,
};

export const mobilePageTransition: Transition = mobilePageSwitchTransition;

export const sheetTransition: Transition = mobileStackReturnTransition;

export const listItemTransition: Transition = {
  duration: 0.16,
  ease: IOS_MOTION_EASE,
};

export const swipeSnapTransition: Transition = {
  duration: 0.22,
  ease: IOS_MOTION_EASE,
};

export const mobileSwipeBackConfig = {
  desktopMinWidth: 1024,
  edgeStartWidthPx: 32,
  edgeScrollGuardDistancePx: 4,
  edgeScrollGuardRatio: 0.55,
  edgeClaimDistancePx: 4,
  edgeClaimRatio: 0.55,
  scrollGuardDistancePx: 8,
  scrollGuardRatio: 0.95,
  claimDistancePx: 10,
  claimRatio: 0.85,
  cancelDistancePx: 22,
  cancelRatio: 1.45,
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
  deltaX,
  deltaY,
  viewportWidth,
}: MobileSwipeBackIntentInput): boolean {
  if (viewportWidth >= mobileSwipeBackConfig.desktopMinWidth) return true;
  const absoluteDeltaY = Math.abs(deltaY);
  if (absoluteDeltaY < mobileSwipeBackConfig.cancelDistancePx) return false;
  return absoluteDeltaY > Math.abs(deltaX) * mobileSwipeBackConfig.cancelRatio;
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
    opacity: 0,
    x: direction > 0 ? 28 : direction < 0 ? -22 : 0,
    y: direction === 0 ? 8 : 0,
  }),
  center: {
    opacity: 1,
    x: 0,
    y: 0,
  },
  exit: (direction: number = 0) => ({
    opacity: 0,
    x: direction > 0 ? -18 : direction < 0 ? 26 : 0,
    y: direction === 0 ? -4 : 0,
  }),
};

export const reducedMobilePageVariants: Variants = {
  enter: { opacity: 0 },
  center: { opacity: 1 },
  exit: { opacity: 0 },
};

export const searchExpandVariants: Variants = {
  collapsed: {
    height: 0,
    opacity: 0,
    marginTop: 0,
  },
  expanded: {
    height: "auto",
    opacity: 1,
    marginTop: 8,
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
  hidden: { opacity: 0, y: 4 },
  visible: (index: number = 0) => ({
    opacity: 1,
    y: 0,
    transition: {
      ...listItemTransition,
      delay: Math.min(index, 7) * 0.018,
    },
  }),
};
