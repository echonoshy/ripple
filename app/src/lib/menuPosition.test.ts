import assert from "node:assert/strict";

import {
  getMeasuredViewportMenuPosition,
  getViewportMenuPosition,
  MOBILE_MENU_BOTTOM_INSET_PX,
  VIEWPORT_MENU_GAP_PX,
  VIEWPORT_MENU_MARGIN_PX,
} from "./menuPosition";

function testMenusOpenAboveBottomChromeWhenThereIsNoRoomBelow() {
  const position = getViewportMenuPosition({
    anchorRect: {
      top: 594,
      right: 372,
      bottom: 626,
      left: 340,
    },
    menuWidth: 220,
    menuHeight: 212,
    viewportWidth: 390,
    viewportHeight: 640,
    bottomInset: MOBILE_MENU_BOTTOM_INSET_PX,
    margin: VIEWPORT_MENU_MARGIN_PX,
  });

  assert.equal(position.placement, "top");
  assert.ok(position.top + 212 <= 640 - MOBILE_MENU_BOTTOM_INSET_PX - VIEWPORT_MENU_MARGIN_PX);
  assert.ok(position.left >= VIEWPORT_MENU_MARGIN_PX);
  assert.ok(position.left + 220 <= 390 - VIEWPORT_MENU_MARGIN_PX);
}

function testMenusStayNearTriggerWhenThereIsRoomBelow() {
  const position = getViewportMenuPosition({
    anchorRect: {
      top: 120,
      right: 372,
      bottom: 152,
      left: 340,
    },
    menuWidth: 220,
    menuHeight: 160,
    viewportWidth: 390,
    viewportHeight: 640,
    bottomInset: MOBILE_MENU_BOTTOM_INSET_PX,
    margin: VIEWPORT_MENU_MARGIN_PX,
  });

  assert.equal(position.placement, "bottom");
  assert.equal(position.top, 156);
  assert.equal(position.left, 152);
}

testMenusOpenAboveBottomChromeWhenThereIsNoRoomBelow();
testMenusStayNearTriggerWhenThereIsRoomBelow();

function testMeasuredMenuHeightKeepsFlippedMenusCloseToTrigger() {
  const anchorRect = {
    top: 520,
    right: 372,
    bottom: 552,
    left: 340,
  };

  const estimated = getMeasuredViewportMenuPosition({
    anchorRect,
    menuWidth: 220,
    estimatedMenuHeight: 244,
    measuredMenuHeight: null,
    viewportWidth: 390,
    viewportHeight: 640,
    bottomInset: MOBILE_MENU_BOTTOM_INSET_PX,
    margin: VIEWPORT_MENU_MARGIN_PX,
  });
  const measured = getMeasuredViewportMenuPosition({
    anchorRect,
    menuWidth: 220,
    estimatedMenuHeight: 244,
    measuredMenuHeight: 180,
    viewportWidth: 390,
    viewportHeight: 640,
    bottomInset: MOBILE_MENU_BOTTOM_INSET_PX,
    margin: VIEWPORT_MENU_MARGIN_PX,
  });

  assert.equal(estimated.placement, "top");
  assert.equal(measured.placement, "top");
  assert.equal(measured.top + 180 + VIEWPORT_MENU_GAP_PX, anchorRect.top);
  assert.ok(measured.top > estimated.top);
}

testMeasuredMenuHeightKeepsFlippedMenusCloseToTrigger();

console.log("menu position tests passed");
