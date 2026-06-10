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
  listItemVariants,
  mobileStackCommitTransition,
  mobilePageSwitchTransition,
  mobilePageVariants,
  mobileStackPushTransition,
  mobileStackReturnTransition,
  mobileSwipeBackConfig,
  searchExpandVariants,
  swipeSnapTransition,
} from "./motionPrimitives";

const mobileSessionStackSource = readFileSync(
  new URL("./MobileSessionStack.tsx", import.meta.url),
  "utf8"
);
const motionPrimitivesSource = readFileSync(
  new URL("./motionPrimitives.ts", import.meta.url),
  "utf8"
);

function noop() {}

function renderStack(mode: "list" | "chat" = "chat") {
  return renderToStaticMarkup(
    <MobileSessionStack
      mode={mode}
      list={<div>Session list</div>}
      chat={<div>Chat sheet</div>}
      listNav={<div>Session nav underlay</div>}
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

function testOnlyExplicitOptOutTargetsAreExcludedFromSwipeStart() {
  assert.doesNotMatch(MOBILE_SESSION_STACK_INTERACTIVE_SELECTOR, /\bbutton\b/);
  assert.doesNotMatch(MOBILE_SESSION_STACK_INTERACTIVE_SELECTOR, /\btextarea\b/);
  assert.doesNotMatch(MOBILE_SESSION_STACK_INTERACTIVE_SELECTOR, /\[role='button'\]/);
  assert.match(MOBILE_SESSION_STACK_INTERACTIVE_SELECTOR, /data-ripple-ignore-chat-swipe/);
  assert.match(mobileSessionStackSource, /closest\(MOBILE_SESSION_STACK_INTERACTIVE_SELECTOR\)/);
}

function testSwipeBackPointerHandlersRunBeforeClickableChildren() {
  assert.match(mobileSessionStackSource, /suppressNextClickRef/);
  assert.match(mobileSessionStackSource, /onPointerDownCapture=\{handlePointerDown\}/);
  assert.match(mobileSessionStackSource, /onPointerMoveCapture=\{handlePointerMove\}/);
  assert.match(mobileSessionStackSource, /onPointerUpCapture=\{handlePointerUp\}/);
  assert.match(mobileSessionStackSource, /onClickCapture=\{handleClickCapture\}/);
  assert.doesNotMatch(mobileSessionStackSource, /onPointerDown=\{handlePointerDown\}/);
}

function testStackLayersListBehindChatSheet() {
  const html = renderStack("chat");

  assert.match(html, /data-ripple-mobile-session-stack="true"/);
  assert.match(html, /data-ripple-mobile-session-list-layer="true"/);
  assert.match(html, /data-ripple-mobile-session-list-nav-underlay="true"/);
  assert.match(html, /data-ripple-mobile-session-chat-sheet="true"/);
  assert.match(html, />Session list</);
  assert.match(html, />Session nav underlay</);
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
  assert.match(mobileSessionStackSource, /onPointerUpCapture=\{handlePointerUp\}/);
}

function testCommittedSwipeDoesNotResetSheetBeforeListUnmountsChat() {
  const pointerUpBlock =
    mobileSessionStackSource.match(
      /const handlePointerUp[\s\S]*?\},\s*\[animateSheetTo[\s\S]*?\]\s*\);/
    )?.[0] || "";

  assert.match(pointerUpBlock, /mobileStackCommitTransition/);
  assert.doesNotMatch(pointerUpBlock, /sheetX\.set\(0\);\s*onOpenList\(\);/);
}

function testCommittedSwipeUsesCrispEdgeInsteadOfShadow() {
  const pointerUpBlock =
    mobileSessionStackSource.match(
      /const handlePointerUp[\s\S]*?\},\s*\[animateSheetTo[\s\S]*?\]\s*\);/
    )?.[0] || "";
  const chatSheetBlock =
    mobileSessionStackSource.match(
      /<motion\.div[\s\S]*?data-ripple-mobile-session-chat-sheet="true"[\s\S]*?>/
    )?.[0] || "";

  assert.doesNotMatch(motionPrimitivesSource, /exitShadowBleedPx/);
  assert.doesNotMatch(motionPrimitivesSource, /resolveMobileStackExitTarget/);
  assert.doesNotMatch(chatSheetBlock, /shadow-\[-18px_0_44px_rgba\(31,35,41,0\.18\)\]/);
  assert.match(chatSheetBlock, /border-l/);
  assert.match(chatSheetBlock, /isDragging \? "border-\[#D0D3D6\]" : "border-transparent"/);
  assert.match(pointerUpBlock, /animateSheetTo\(dragState\.viewportWidth, onOpenList/);
}

function testMobileMotionUsesRestrainedSharedTiming() {
  assert.equal(mobileStackPushTransition.duration, 0.18);
  assert.equal(mobilePageSwitchTransition.duration, 0.16);
  assert.equal(mobileStackCommitTransition.duration, 0.16);
  assert.equal(mobileStackReturnTransition.duration, 0.16);
  assert.equal(swipeSnapTransition.duration, 0.14);
  assert.equal(mobileSwipeBackConfig.desktopMinWidth, 1024);
  assert.equal(mobileSwipeBackConfig.edgeStartWidthPx, 72);
  assert.equal(mobileSwipeBackConfig.commitMaxPx, 72);
  assert.equal(mobileSwipeBackConfig.commitViewportRatio, 0.18);
}

function variantState(
  variant: unknown,
  custom?: number
): Record<string, unknown> {
  return typeof variant === "function"
    ? (variant as (custom?: number) => Record<string, unknown>)(custom)
    : (variant as Record<string, unknown>);
}

function testMobilePageVariantsAvoidFadeAndVerticalDrift() {
  assert.deepEqual(variantState(mobilePageVariants.enter, 1), { x: 16 });
  assert.deepEqual(variantState(mobilePageVariants.enter, -1), { x: -16 });
  assert.deepEqual(variantState(mobilePageVariants.enter, 0), { x: 0 });
  assert.deepEqual(variantState(mobilePageVariants.center), { x: 0 });
  assert.deepEqual(variantState(mobilePageVariants.exit, 1), { x: -12 });
  assert.deepEqual(variantState(mobilePageVariants.exit, -1), { x: 12 });
  assert.deepEqual(variantState(mobilePageVariants.exit, 0), { x: 0 });
}

function testMobileListItemsDoNotStaggerOrFade() {
  assert.deepEqual(variantState(listItemVariants.hidden), { opacity: 1, y: 0 });
  assert.deepEqual(variantState(listItemVariants.visible, 6), { opacity: 1, y: 0 });
  assert.doesNotMatch(motionPrimitivesSource, /delay: Math/);
}

function testSearchExpandAnimationAvoidsMarginLayoutJank() {
  assert.deepEqual(variantState(searchExpandVariants.collapsed), { height: 0, opacity: 0 });
  assert.deepEqual(variantState(searchExpandVariants.expanded), { height: "auto", opacity: 1 });
  assert.doesNotMatch(motionPrimitivesSource, /searchExpandVariants[\s\S]*marginTop/);
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
testOnlyExplicitOptOutTargetsAreExcludedFromSwipeStart();
testSwipeBackPointerHandlersRunBeforeClickableChildren();
testStackLayersListBehindChatSheet();
testListModeDoesNotRenderForegroundChatSheet();
testPointerMoveOnlyDragsWithoutOpeningList();
testCommittedSwipeDoesNotResetSheetBeforeListUnmountsChat();
testCommittedSwipeUsesCrispEdgeInsteadOfShadow();
testMobileMotionUsesRestrainedSharedTiming();
testMobilePageVariantsAvoidFadeAndVerticalDrift();
testMobileListItemsDoNotStaggerOrFade();
testSearchExpandAnimationAvoidsMarginLayoutJank();
testChatSheetAnimatesInFromRightWhenOpeningSession();
testSessionSwipeBackUsesSharedMotionPrimitive();
testChatSheetUsesCompositedSwipeAnimation();

console.log("mobile session stack tests passed");
