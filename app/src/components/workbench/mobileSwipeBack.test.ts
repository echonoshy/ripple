import assert from "node:assert/strict";

import {
  ensureMobileSwipeBackScrollLock,
  releaseMobileSwipeBackScrollLock,
} from "./mobileSwipeBack";

function fakeScrollElement(
  scrollTop: number,
  overflowY = "auto",
  overscrollBehaviorY = "auto"
): HTMLElement {
  return {
    scrollTop,
    style: {
      overflowY,
      overscrollBehaviorY,
    },
  } as HTMLElement;
}

function testScrollLockFreezesAndRestoresScrollableElement() {
  const scrollElement = fakeScrollElement(48);

  const lock = ensureMobileSwipeBackScrollLock(null, scrollElement, 16);

  assert.ok(lock);
  assert.equal(scrollElement.scrollTop, 16);
  assert.equal(scrollElement.style.overflowY, "hidden");
  assert.equal(scrollElement.style.overscrollBehaviorY, "contain");

  releaseMobileSwipeBackScrollLock(lock);

  assert.equal(scrollElement.scrollTop, 16);
  assert.equal(scrollElement.style.overflowY, "auto");
  assert.equal(scrollElement.style.overscrollBehaviorY, "auto");
}

function testScrollLockReusesExistingLockAndIgnoresMissingScrollElement() {
  const firstElement = fakeScrollElement(32);
  const secondElement = fakeScrollElement(96);
  const lock = ensureMobileSwipeBackScrollLock(null, firstElement, 12);

  assert.equal(ensureMobileSwipeBackScrollLock(lock, secondElement, 64), lock);
  assert.equal(secondElement.scrollTop, 96);
  assert.equal(ensureMobileSwipeBackScrollLock(null, null, 0), null);

  releaseMobileSwipeBackScrollLock(lock);
}

testScrollLockFreezesAndRestoresScrollableElement();
testScrollLockReusesExistingLockAndIgnoresMissingScrollElement();

console.log("mobile swipe back tests passed");
