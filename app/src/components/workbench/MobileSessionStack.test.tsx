import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import MobileSessionStack, {
  MOBILE_SESSION_STACK_INTERACTIVE_SELECTOR,
  resolveMobileSessionDrawerRelease,
  shouldCancelMobileSessionDrawer,
  shouldClaimMobileSessionDrawer,
  shouldReleaseMobileSessionDrawerScrollGuard,
  shouldGuardMobileSessionDrawerScroll,
} from "./MobileSessionStack";
import {
  mobileStackCommitTransition,
  mobilePageSwitchTransition,
  mobileStackPushTransition,
  mobileStackReturnTransition,
  mobileSwipeBackConfig,
} from "./motionPrimitives";

const mobileSessionStackSource = readFileSync(
  new URL("./MobileSessionStack.tsx", import.meta.url),
  "utf8"
);

function noop() {}

function renderStack(mode: "list" | "chat" = "chat") {
  return renderToStaticMarkup(
    <MobileSessionStack
      mode={mode}
      list={<div>Session list</div>}
      chat={<div>Chat sheet</div>}
      onOpenList={noop}
    />
  );
}

function testClaimRequiresHorizontalIntentAcrossChatSurface() {
  assert.equal(
    shouldClaimMobileSessionDrawer({
      deltaX: 10,
      deltaY: 0,
      viewportWidth: 390,
    }),
    false
  );
  assert.equal(
    shouldClaimMobileSessionDrawer({
      deltaX: 24,
      deltaY: 0,
      viewportWidth: 390,
    }),
    false
  );
  assert.equal(
    shouldClaimMobileSessionDrawer({
      deltaX: 28,
      deltaY: 0,
      viewportWidth: 390,
    }),
    true
  );
  assert.equal(
    shouldClaimMobileSessionDrawer({
      deltaX: 24,
      deltaY: 24,
      viewportWidth: 390,
    }),
    false
  );
  assert.equal(
    shouldClaimMobileSessionDrawer({
      deltaX: 16,
      deltaY: 30,
      viewportWidth: 390,
    }),
    false
  );
  assert.equal(
    shouldClaimMobileSessionDrawer({
      deltaX: 40,
      deltaY: 0,
      viewportWidth: 1280,
    }),
    false
  );
}

function testLeftEdgeSwipeClaimsWithShorterIntent() {
  assert.equal(
    shouldClaimMobileSessionDrawer({
      startX: 4,
      deltaX: 4,
      deltaY: 0,
      viewportWidth: 390,
    }),
    true
  );
  assert.equal(
    shouldClaimMobileSessionDrawer({
      startX: 70,
      deltaX: 6,
      deltaY: 12,
      viewportWidth: 390,
    }),
    true
  );
  assert.equal(
    shouldClaimMobileSessionDrawer({
      startX: 74,
      deltaX: 6,
      deltaY: 0,
      viewportWidth: 390,
    }),
    false
  );
  assert.equal(
    shouldClaimMobileSessionDrawer({
      startX: 4,
      deltaX: 6,
      deltaY: 16,
      viewportWidth: 390,
    }),
    true
  );
}

function testVerticalIntentCancelsDrawerGesture() {
  assert.equal(
    shouldCancelMobileSessionDrawer({
      deltaX: 8,
      deltaY: 22,
      viewportWidth: 390,
    }),
    true
  );
  assert.equal(
    shouldCancelMobileSessionDrawer({
      deltaX: 14,
      deltaY: 20,
      viewportWidth: 390,
    }),
    true
  );
  assert.equal(
    shouldCancelMobileSessionDrawer({
      deltaX: 30,
      deltaY: 20,
      viewportWidth: 390,
    }),
    false
  );
  assert.equal(
    shouldCancelMobileSessionDrawer({
      startX: 4,
      deltaX: 18,
      deltaY: 22,
      viewportWidth: 390,
    }),
    false
  );
  assert.equal(
    shouldCancelMobileSessionDrawer({
      startX: 4,
      deltaX: 10,
      deltaY: 32,
      viewportWidth: 390,
    }),
    true
  );
  assert.match(mobileSessionStackSource, /shouldCancelMobileSessionDrawer/);
  assert.match(mobileSessionStackSource, /dragStateRef\.current = null/);
}

function testHorizontalIntentGuardsScrollBeforeDrawerClaim() {
  assert.equal(
    shouldGuardMobileSessionDrawerScroll({
      deltaX: 6,
      deltaY: 5,
      viewportWidth: 390,
    }),
    false
  );
  assert.equal(
    shouldGuardMobileSessionDrawerScroll({
      startX: 4,
      deltaX: 4,
      deltaY: 5,
      viewportWidth: 390,
    }),
    true
  );
  assert.equal(
    shouldGuardMobileSessionDrawerScroll({
      startX: 4,
      deltaX: 6,
      deltaY: 16,
      viewportWidth: 390,
    }),
    true
  );
  assert.equal(
    shouldGuardMobileSessionDrawerScroll({
      deltaX: 16,
      deltaY: 0,
      viewportWidth: 390,
    }),
    false
  );
  assert.equal(
    shouldGuardMobileSessionDrawerScroll({
      deltaX: 20,
      deltaY: 0,
      viewportWidth: 390,
    }),
    true
  );
  assert.equal(
    shouldGuardMobileSessionDrawerScroll({
      deltaX: 24,
      deltaY: 24,
      viewportWidth: 390,
    }),
    false
  );
  assert.equal(
    shouldGuardMobileSessionDrawerScroll({
      deltaX: 20,
      deltaY: 0,
      viewportWidth: 1280,
    }),
    false
  );
  assert.match(mobileSessionStackSource, /onTouchMoveCapture=\{handleTouchMoveCapture\}/);
  assert.match(mobileSessionStackSource, /event\.preventDefault\(\)/);
}

function testGuardedScrollCanReleaseBackToVerticalIntent() {
  assert.equal(
    shouldReleaseMobileSessionDrawerScrollGuard({
      deltaX: 8,
      deltaY: 26,
      viewportWidth: 390,
    }),
    true
  );
  assert.equal(
    shouldReleaseMobileSessionDrawerScrollGuard({
      startX: 4,
      deltaX: 8,
      deltaY: 24,
      viewportWidth: 390,
    }),
    false
  );
  assert.equal(
    shouldReleaseMobileSessionDrawerScrollGuard({
      startX: 4,
      deltaX: 10,
      deltaY: 32,
      viewportWidth: 390,
    }),
    true
  );
  assert.match(mobileSessionStackSource, /shouldReleaseMobileSessionDrawerScrollGuard/);
  assert.match(mobileSessionStackSource, /releaseScrollLock\(\)/);
}

function testDrawerDragLocksTimelineScrollTop() {
  assert.match(mobileSessionStackSource, /data-ripple-session-scroll="timeline"/);
  assert.match(mobileSessionStackSource, /startScrollTop/);
  assert.match(mobileSessionStackSource, /style\.overflowY = "hidden"/);
  assert.match(mobileSessionStackSource, /releaseMobileSessionScrollLock/);
  assert.doesNotMatch(
    mobileSessionStackSource,
    /scrollElement\.scrollTop = dragState\.startScrollTop/
  );
}

function testTouchScrollGuardLocksTimelineBeforeDrawerClaim() {
  assert.match(mobileSessionStackSource, /ensureMobileSessionScrollLock/);
  assert.doesNotMatch(
    mobileSessionStackSource,
    /scrollElement\.scrollTop = guardState\.startScrollTop/
  );
}

function testNewSwipeStopsInFlightSheetAnimation() {
  const pointerDownBlock =
    mobileSessionStackSource.match(
      /const handlePointerDown[\s\S]*?\},\s*\[mode[\s\S]*?\]\s*\);/
    )?.[0] || "";

  assert.match(mobileSessionStackSource, /activeSheetAnimationRef/);
  assert.match(pointerDownBlock, /stopSheetAnimation\(\)/);
}

function testReleaseCommitAndCancelThresholds() {
  assert.equal(
    resolveMobileSessionDrawerRelease({
      x: 72,
      velocityX: 0,
      viewportWidth: 390,
    }).shouldOpenList,
    true
  );
  assert.equal(
    resolveMobileSessionDrawerRelease({
      x: 24,
      velocityX: 260,
      viewportWidth: 390,
    }).shouldOpenList,
    true
  );
  assert.equal(
    resolveMobileSessionDrawerRelease({
      x: 23,
      velocityX: 900,
      viewportWidth: 390,
    }).shouldOpenList,
    false
  );
  assert.equal(
    resolveMobileSessionDrawerRelease({
      x: 71,
      velocityX: 0,
      viewportWidth: 430,
    }).shouldOpenList,
    false
  );
}

function testInteractiveTargetsAreExcludedFromSwipeStart() {
  assert.match(MOBILE_SESSION_STACK_INTERACTIVE_SELECTOR, /button/);
  assert.match(MOBILE_SESSION_STACK_INTERACTIVE_SELECTOR, /textarea/);
  assert.match(MOBILE_SESSION_STACK_INTERACTIVE_SELECTOR, /data-ripple-ignore-chat-swipe/);
  assert.match(mobileSessionStackSource, /closest\(MOBILE_SESSION_STACK_INTERACTIVE_SELECTOR\)/);
}

function testStackLayersListBehindChatSheet() {
  const html = renderStack("chat");

  assert.match(html, /data-ripple-mobile-session-stack="true"/);
  assert.match(html, /data-ripple-mobile-session-list-layer="true"/);
  assert.match(html, /data-ripple-mobile-session-chat-sheet="true"/);
  assert.match(html, />Session list</);
  assert.match(html, />Chat sheet</);
}

function testListModeDoesNotRenderForegroundChatSheet() {
  const html = renderStack("list");

  assert.match(html, />Session list</);
  assert.doesNotMatch(html, /data-ripple-mobile-session-chat-sheet="true"/);
  assert.doesNotMatch(html, />Chat sheet</);
}

function testPointerMoveOnlyDragsWithoutOpeningList() {
  const pointerMoveBlock =
    mobileSessionStackSource.match(/const handlePointerMove[\s\S]*?\},\s*\[sheetX\]\s*\);/)?.[0] ||
    "";

  assert.match(pointerMoveBlock, /sheetX\.set/);
  assert.doesNotMatch(pointerMoveBlock, /onOpenList/);
  assert.match(mobileSessionStackSource, /onPointerUp=\{handlePointerUp\}/);
}

function testCommittedSwipeDoesNotResetSheetBeforeListUnmountsChat() {
  const pointerUpBlock =
    mobileSessionStackSource.match(
      /const handlePointerUp[\s\S]*?\},\s*\[animateSheetTo[\s\S]*?\]\s*\);/
    )?.[0] || "";

  assert.match(pointerUpBlock, /mobileStackCommitTransition/);
  assert.doesNotMatch(pointerUpBlock, /sheetX\.set\(0\);\s*onOpenList\(\);/);
}

function testMobileMotionUsesFeishuInspiredSharedTiming() {
  assert.equal(mobileStackPushTransition.duration, 0.3);
  assert.equal(mobilePageSwitchTransition.duration, 0.3);
  assert.equal(mobileStackCommitTransition.duration, 0.18);
  assert.equal(mobileStackReturnTransition.duration, 0.22);
  assert.equal(mobileSwipeBackConfig.desktopMinWidth, 1024);
  assert.equal(mobileSwipeBackConfig.edgeStartWidthPx, 72);
  assert.equal(mobileSwipeBackConfig.commitMaxPx, 72);
  assert.equal(mobileSwipeBackConfig.commitViewportRatio, 0.18);
}

function testChatSheetAnimatesInFromRightWhenOpeningSession() {
  assert.match(mobileSessionStackSource, /previousModeRef/);
  assert.match(mobileSessionStackSource, /sheetX\.set\(currentViewportWidth\)/);
  assert.match(mobileSessionStackSource, /window\.requestAnimationFrame/);
  assert.match(mobileSessionStackSource, /mobileStackPushTransition/);
  assert.match(mobileSessionStackSource, /mobileStackReturnTransition/);
}

function testSessionSwipeBackUsesSharedMotionPrimitive() {
  assert.match(mobileSessionStackSource, /shouldClaimMobileSwipeBack/);
  assert.match(mobileSessionStackSource, /shouldGuardMobileSwipeBackScroll/);
  assert.match(mobileSessionStackSource, /shouldCancelMobileSwipeBack/);
  assert.match(mobileSessionStackSource, /resolveMobileSwipeBackRelease/);
}

function testChatSheetUsesCompositedSwipeAnimation() {
  assert.match(mobileSessionStackSource, /will-change-transform/);
}

testClaimRequiresHorizontalIntentAcrossChatSurface();
testLeftEdgeSwipeClaimsWithShorterIntent();
testVerticalIntentCancelsDrawerGesture();
testHorizontalIntentGuardsScrollBeforeDrawerClaim();
testGuardedScrollCanReleaseBackToVerticalIntent();
testDrawerDragLocksTimelineScrollTop();
testTouchScrollGuardLocksTimelineBeforeDrawerClaim();
testNewSwipeStopsInFlightSheetAnimation();
testReleaseCommitAndCancelThresholds();
testInteractiveTargetsAreExcludedFromSwipeStart();
testStackLayersListBehindChatSheet();
testListModeDoesNotRenderForegroundChatSheet();
testPointerMoveOnlyDragsWithoutOpeningList();
testCommittedSwipeDoesNotResetSheetBeforeListUnmountsChat();
testMobileMotionUsesFeishuInspiredSharedTiming();
testChatSheetAnimatesInFromRightWhenOpeningSession();
testSessionSwipeBackUsesSharedMotionPrimitive();
testChatSheetUsesCompositedSwipeAnimation();

console.log("mobile session stack tests passed");
