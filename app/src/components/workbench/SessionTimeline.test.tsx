import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

function testTimelineImagePreviewsUseWorkspaceImageCache() {
  const source = readFileSync(new URL("./SessionTimeline.tsx", import.meta.url), "utf8");

  assert.match(source, /getWorkspaceImagePreviewUrl/);
  assert.doesNotMatch(source, /URL\.createObjectURL/);
  assert.doesNotMatch(source, /URL\.revokeObjectURL/);
}

testTimelineImagePreviewsUseWorkspaceImageCache();

console.log("session timeline tests passed");
