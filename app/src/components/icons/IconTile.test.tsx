import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { ActionIcon, IconTile } from "./IconTile";

function testIconTileRendersToneSizeAndMarker() {
  const html = renderToStaticMarkup(
    <IconTile tone="success" size="lg">
      <span>✓</span>
    </IconTile>
  );

  assert.match(html, /data-ripple-icon-tile="true"/);
  assert.match(html, /data-tone="success"/);
  assert.match(html, /h-10/);
  assert.match(html, /w-10/);
  assert.match(html, /bg-\[#E4F8EE\]/);
  assert.match(html, /text-\[#16845B\]/);
}

function testActionIconUsesConsistentStrokeDefaults() {
  const html = renderToStaticMarkup(
    <ActionIcon label="Search">
      <span>⌕</span>
    </ActionIcon>
  );

  assert.match(html, /data-ripple-action-icon="true"/);
  assert.match(html, /aria-label="Search"/);
  assert.match(html, /h-8/);
  assert.match(html, /w-8/);
  assert.match(html, /text-\[#2B2F36\]/);
}

testIconTileRendersToneSizeAndMarker();
testActionIconUsesConsistentStrokeDefaults();

console.log("icon tile tests passed");
