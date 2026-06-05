import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import MobileSessionStack, {
  MOBILE_SESSION_STACK_INTERACTIVE_SELECTOR,
  resolveMobileSessionDrawerRelease,
  shouldCancelMobileSessionDrawer,
  shouldClaimMobileSessionDrawer,
  shouldGuardMobileSessionDrawerScroll,
} from "./MobileSessionStack";

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
      deltaX: 16,
      deltaY: 0,
      viewportWidth: 390,
    }),
    true
  );
  assert.equal(
    shouldClaimMobileSessionDrawer({
      deltaX: 20,
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
      deltaX: 30,
      deltaY: 20,
      viewportWidth: 390,
    }),
    false
  );
  assert.match(mobileSessionStackSource, /shouldCancelMobileSessionDrawer/);
  assert.match(mobileSessionStackSource, /dragStateRef\.current = null/);
}

function testHorizontalIntentGuardsScrollBeforeDrawerClaim() {
  assert.equal(
    shouldGuardMobileSessionDrawerScroll({
      deltaX: 8,
      deltaY: 3,
      viewportWidth: 390,
    }),
    true
  );
  assert.equal(
    shouldGuardMobileSessionDrawerScroll({
      deltaX: 5,
      deltaY: 0,
      viewportWidth: 390,
    }),
    false
  );
  assert.equal(
    shouldGuardMobileSessionDrawerScroll({
      deltaX: 8,
      deltaY: 12,
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
    mobileSessionStackSource.match(/const handlePointerDown[\s\S]*?\},\s*\[mode[\s\S]*?\]\s*\);/)?.[0] ||
    "";

  assert.match(mobileSessionStackSource, /activeSheetAnimationRef/);
  assert.match(pointerDownBlock, /stopSheetAnimation\(\)/);
}

function testReleaseCommitAndCancelThresholds() {
  assert.equal(
    resolveMobileSessionDrawerRelease({
      x: 149,
      velocityX: 0,
      viewportWidth: 390,
    }).shouldOpenList,
    true
  );
  assert.equal(
    resolveMobileSessionDrawerRelease({
      x: 72,
      velocityX: 650,
      viewportWidth: 390,
    }).shouldOpenList,
    true
  );
  assert.equal(
    resolveMobileSessionDrawerRelease({
      x: 71,
      velocityX: 900,
      viewportWidth: 390,
    }).shouldOpenList,
    false
  );
  assert.equal(
    resolveMobileSessionDrawerRelease({
      x: 120,
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

testClaimRequiresHorizontalIntentAcrossChatSurface();
testVerticalIntentCancelsDrawerGesture();
testHorizontalIntentGuardsScrollBeforeDrawerClaim();
testDrawerDragLocksTimelineScrollTop();
testTouchScrollGuardLocksTimelineBeforeDrawerClaim();
testNewSwipeStopsInFlightSheetAnimation();
testReleaseCommitAndCancelThresholds();
testInteractiveTargetsAreExcludedFromSwipeStart();
testStackLayersListBehindChatSheet();
testListModeDoesNotRenderForegroundChatSheet();
testPointerMoveOnlyDragsWithoutOpeningList();

console.log("mobile session stack tests passed");
