import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

function testSiteContactIconsUseSoftTileStyle() {
  const html = readFileSync(new URL("../../../../sites/index.html", import.meta.url), "utf8");
  const css = readFileSync(new URL("../../../../sites/styles.css", import.meta.url), "utf8");
  const contactSection = html.match(/<section id="contact"[\s\S]*?<\/section>/)?.[0] ?? "";

  assert.match(contactSection, /data-ripple-icon-tile="true"/);
  assert.doesNotMatch(contactSection, /fill="currentColor"/);
  assert.match(contactSection, /stroke="currentColor"/);
  assert.match(css, /\.btn-icon\[data-ripple-icon-tile="true"\]/);
  assert.match(css, /border:\s*1px solid/);
  assert.match(css, /border-radius:\s*12px/);
}

testSiteContactIconsUseSoftTileStyle();

console.log("site icon style tests passed");
