import assert from "node:assert/strict";

import { TERMINAL_OUTPUT_PREVIEW_LIMIT, formatTerminalOutputPreview } from "./terminalOutput";

function testPreviewLimitIs4000Chars() {
  assert.equal(TERMINAL_OUTPUT_PREVIEW_LIMIT, 4_000);
}

function testKeepsShortOutputUnchanged() {
  const output = "short result";
  const preview = formatTerminalOutputPreview(output);

  assert.equal(preview.text, output);
  assert.equal(preview.isTruncated, false);
  assert.equal(preview.hiddenChars, 0);
}

function testTruncatesOutputOverPreviewLimit() {
  const output = "x".repeat(TERMINAL_OUTPUT_PREVIEW_LIMIT + 12);
  const preview = formatTerminalOutputPreview(output);

  assert.equal(preview.text.length, TERMINAL_OUTPUT_PREVIEW_LIMIT);
  assert.equal(preview.text, output.slice(0, TERMINAL_OUTPUT_PREVIEW_LIMIT));
  assert.equal(preview.isTruncated, true);
  assert.equal(preview.hiddenChars, 12);
}

testPreviewLimitIs4000Chars();
testKeepsShortOutputUnchanged();
testTruncatesOutputOverPreviewLimit();

console.log("terminalOutput tests passed");
