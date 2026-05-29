export const VIEWPORT_MENU_MARGIN_PX = 8;
export const VIEWPORT_MENU_GAP_PX = 4;
export const MOBILE_MENU_BOTTOM_INSET_PX = 88;

export interface ViewportMenuAnchorRect {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

interface ViewportMenuPositionInput {
  anchorRect: ViewportMenuAnchorRect;
  menuWidth: number;
  menuHeight: number;
  viewportWidth: number;
  viewportHeight: number;
  bottomInset?: number;
  margin?: number;
  gap?: number;
  align?: "left" | "right";
}

interface ViewportMenuPosition {
  top: number;
  left: number;
  placement: "top" | "bottom";
}

function clamp(value: number, min: number, max: number): number {
  const usableMax = Math.max(min, max);
  return Math.min(usableMax, Math.max(min, value));
}

export function getResponsiveMenuBottomInsetPx(): number {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return 0;
  return window.matchMedia("(max-width: 1023px)").matches ? MOBILE_MENU_BOTTOM_INSET_PX : 0;
}

export function getViewportMenuPosition({
  anchorRect,
  menuWidth,
  menuHeight,
  viewportWidth,
  viewportHeight,
  bottomInset = 0,
  margin = VIEWPORT_MENU_MARGIN_PX,
  gap = VIEWPORT_MENU_GAP_PX,
  align = "right",
}: ViewportMenuPositionInput): ViewportMenuPosition {
  const preferredLeft = align === "left" ? anchorRect.left : anchorRect.right - menuWidth;
  const maxLeft = viewportWidth - menuWidth - margin;
  const left = clamp(preferredLeft, margin, maxLeft);

  const bottomLimit = viewportHeight - bottomInset - margin;
  const topBelow = anchorRect.bottom + gap;
  const belowFits = topBelow + menuHeight <= bottomLimit;

  if (belowFits) {
    return {
      top: topBelow,
      left,
      placement: "bottom",
    };
  }

  const topAbove = anchorRect.top - menuHeight - gap;
  const maxTop = bottomLimit - menuHeight;
  return {
    top: clamp(topAbove, margin, maxTop),
    left,
    placement: "top",
  };
}

export function getMeasuredViewportMenuPosition({
  estimatedMenuHeight,
  measuredMenuHeight,
  ...input
}: Omit<ViewportMenuPositionInput, "menuHeight"> & {
  estimatedMenuHeight: number;
  measuredMenuHeight?: number | null;
}): ViewportMenuPosition {
  return getViewportMenuPosition({
    ...input,
    menuHeight: measuredMenuHeight && measuredMenuHeight > 0 ? measuredMenuHeight : estimatedMenuHeight,
  });
}
