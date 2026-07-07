import assert from "node:assert/strict";

import {
  BROWSER_CONTEXT_VISIBLE_TEXT_LIMIT,
  buildBrowserContext,
  normalizeBrowserUrlInput,
} from "./browserContext";

function testNormalizeBrowserUrlInputAddsHttps() {
  assert.equal(normalizeBrowserUrlInput("example.com/news"), "https://example.com/news");
  assert.equal(normalizeBrowserUrlInput("https://example.com/news"), "https://example.com/news");
  assert.equal(normalizeBrowserUrlInput("http://example.com/news"), "http://example.com/news");
}

function testBuildBrowserContextIncludesBoundedPageText() {
  const context = buildBrowserContext({
    address: "https://example.com/article",
    page: {
      url: "https://example.com/article",
      title: "Example article",
      text: "important ".repeat(4000),
      truncated: false,
      captured_at: "2026-07-07T00:00:00Z",
    },
  });

  assert.equal(context.schema_version, "ripple.browser_context.v1");
  assert.equal(context.active, true);
  assert.equal(context.page?.url, "https://example.com/article");
  assert.equal(context.page?.title, "Example article");
  assert.equal(context.page?.text_truncated, true);
  assert.ok(String(context.page?.visible_text || "").length <= BROWSER_CONTEXT_VISIBLE_TEXT_LIMIT);
}

function testBuildBrowserContextFallsBackToAddressOnly() {
  const context = buildBrowserContext({
    address: "https://example.com/search?q=gpt",
    page: null,
  });

  assert.equal(context.active, true);
  assert.equal(context.page?.url, "https://example.com/search?q=gpt");
  assert.equal(context.page?.visible_text, "");
}

testNormalizeBrowserUrlInputAddsHttps();
testBuildBrowserContextIncludesBoundedPageText();
testBuildBrowserContextFallsBackToAddressOnly();

console.log("browser context tests passed");
