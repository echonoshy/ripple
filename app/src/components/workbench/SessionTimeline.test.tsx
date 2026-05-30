import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

function testTimelineImagePreviewsUseWorkspaceImageCache() {
  const source = readFileSync(new URL("./SessionTimeline.tsx", import.meta.url), "utf8");

  assert.match(source, /getWorkspaceImagePreviewUrl/);
  assert.doesNotMatch(source, /URL\.createObjectURL/);
  assert.doesNotMatch(source, /URL\.revokeObjectURL/);
}

function testEmptyTimelineUsesShortReadyCopy() {
  const source = readFileSync(new URL("./SessionTimeline.tsx", import.meta.url), "utf8");

  assert.match(source, /Activity will appear here\./);
  assert.doesNotMatch(
    source,
    /Start a session and your workspace activity will appear here as a timeline\./
  );
}

testTimelineImagePreviewsUseWorkspaceImageCache();
testEmptyTimelineUsesShortReadyCopy();

console.log("session timeline tests passed");
