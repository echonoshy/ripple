import type { Transition, Variants } from "framer-motion";

export const IOS_MOTION_EASE: [number, number, number, number] = [0.2, 0.8, 0.2, 1];
export const SWIPE_ACTION_THRESHOLD_PX = 48;
export const SWIPE_ACTION_WIDTH_PX = 64;
export const SWIPE_COMMIT_WIDTH_PX = 86;

export const pressableTap = { scale: 0.97 };

export const reducedMotionTransition: Transition = { duration: 0 };

export const mobilePageTransition: Transition = {
  duration: 0.22,
  ease: IOS_MOTION_EASE,
};

export const menuTransition: Transition = {
  duration: 0.11,
  ease: IOS_MOTION_EASE,
};

export const sheetTransition: Transition = {
  duration: 0.22,
  ease: IOS_MOTION_EASE,
};

export const listItemTransition: Transition = {
  duration: 0.16,
  ease: IOS_MOTION_EASE,
};

export const swipeSnapTransition: Transition = {
  duration: 0.18,
  ease: IOS_MOTION_EASE,
};

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
