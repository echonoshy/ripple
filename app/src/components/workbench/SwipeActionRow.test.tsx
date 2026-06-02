import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import SwipeActionRow, {
  getSwipeActionRowDragConstraints,
  resolveSwipeActionRowEnd,
} from "./SwipeActionRow";

function testSwipeActionsAreHiddenUntilInteraction() {
  const html = renderToStaticMarkup(
    <SwipeActionRow
      leadingActions={[
        {
          key: "rename",
          label: "Rename",
          icon: <span aria-hidden="true">R</span>,
          tone: "neutral",
          onClick: () => {},
        },
        {
          key: "delete",
          label: "Delete",
          icon: <span aria-hidden="true">D</span>,
          tone: "danger",
          onClick: () => {},
        },
      ]}
      trailingActions={[
        {
          key: "pin",
          label: "Pin",
          icon: <span aria-hidden="true">P</span>,
          tone: "accent",
          onClick: () => {},
        },
      ]}
    >
      <div>Quiet row</div>
    </SwipeActionRow>
  );

  assert.match(html, /data-ripple-swipe-row="true"/);
  assert.match(html, /data-ripple-swipe-actions="leading"[^>]*opacity-0/);
  assert.match(html, /data-ripple-swipe-actions="trailing"[^>]*opacity-0/);
  assert.match(html, /aria-label="Rename"/);
  assert.match(html, /aria-label="Delete"/);
  assert.match(html, /aria-label="Pin"/);
  assert.match(html, /class="relative w-full/);
}

function testDisabledSwipeRowsDoNotRenderActionRails() {
  const html = renderToStaticMarkup(
    <SwipeActionRow
      disabled
      leadingActions={[
        {
          key: "rename",
          label: "Rename",
          icon: <span aria-hidden="true">R</span>,
          tone: "neutral",
          onClick: () => {},
        },
      ]}
      trailingActions={[
        {
          key: "delete",
          label: "Delete",
          icon: <span aria-hidden="true">D</span>,
          tone: "danger",
          onClick: () => {},
        },
      ]}
    >
      <div>Disabled row</div>
    </SwipeActionRow>
  );

  assert.match(html, /aria-disabled="true"/);
  assert.doesNotMatch(html, /data-ripple-swipe-actions/);
  assert.doesNotMatch(html, /aria-label="Rename"/);
  assert.doesNotMatch(html, /aria-label="Delete"/);
}

function testOpenRowsCloseBeforeOpeningOppositeSide() {
  const rightSwipeFromTrailing = resolveSwipeActionRowEnd({
    openedSide: "trailing",
    currentX: 64,
    offsetX: 192,
    leadingWidth: 64,
    trailingWidth: 128,
    hasLeadingActions: true,
    hasTrailingActions: true,
    hasRightCommit: false,
  });
  const leftSwipeFromLeading = resolveSwipeActionRowEnd({
    openedSide: "leading",
    currentX: -64,
    offsetX: -192,
    leadingWidth: 64,
    trailingWidth: 128,
    hasLeadingActions: true,
    hasTrailingActions: true,
    hasRightCommit: false,
  });

  assert.deepEqual(rightSwipeFromTrailing, {
    side: null,
    target: 0,
    shouldCommitRight: false,
  });
  assert.deepEqual(leftSwipeFromLeading, {
    side: null,
    target: 0,
    shouldCommitRight: false,
  });
}

function testOpenRowsClampOppositeDragAtNeutralPosition() {
  assert.deepEqual(
    getSwipeActionRowDragConstraints({
      visibleSide: "trailing",
      leadingWidth: 64,
      trailingWidth: 128,
      hasLeadingActions: true,
      hasTrailingActions: true,
      hasRightCommit: false,
    }),
    { left: -128, right: 0 }
  );
  assert.deepEqual(
    getSwipeActionRowDragConstraints({
      visibleSide: "leading",
      leadingWidth: 64,
      trailingWidth: 128,
      hasLeadingActions: true,
      hasTrailingActions: true,
      hasRightCommit: false,
    }),
    { left: 0, right: 64 }
  );
}

testSwipeActionsAreHiddenUntilInteraction();
testDisabledSwipeRowsDoNotRenderActionRails();
testOpenRowsCloseBeforeOpeningOppositeSide();
testOpenRowsClampOppositeDragAtNeutralPosition();

console.log("swipe action row tests passed");
