import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

const indexHtml = readFileSync(new URL("../../index.html", import.meta.url), "utf8");
const globalsCss = readFileSync(new URL("../globals.css", import.meta.url), "utf8");

describe("mobile readability", () => {
  it("keeps the mobile viewport fixed to prevent iOS WebView horizontal drift", () => {
    assert.match(indexHtml, /width=device-width/);
    assert.match(indexHtml, /initial-scale=1\.0/);
    assert.match(indexHtml, /viewport-fit=cover/);
    assert.match(indexHtml, /maximum-scale=1\.0/);
    assert.match(indexHtml, /user-scalable=no/);
  });

  it("locks the app to the viewport width and vertical touch gestures", () => {
    assert.match(globalsCss, /html,\s*\nbody,\s*\n#root\s*\{/);
    assert.match(globalsCss, /overflow-x:\s*hidden/);
    assert.match(globalsCss, /touch-action:\s*pan-y/);
  });

  it("uses stable mobile font sizing instead of dynamic WebView text autosizing", () => {
    assert.match(globalsCss, /@media\s+\(max-width:\s*767px\)/);
    assert.match(globalsCss, /font-size:\s*17px/);
    assert.match(globalsCss, /text-size-adjust:\s*100%/);
    assert.doesNotMatch(globalsCss, /text-size-adjust:\s*112%/);
    assert.match(globalsCss, /\.text-\\\[9px\\\]/);
    assert.match(globalsCss, /\.text-\\\[10px\\\]/);
    assert.match(globalsCss, /\.text-\\\[11px\\\]/);
  });
});
