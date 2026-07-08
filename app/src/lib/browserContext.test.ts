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

function testBuildBrowserContextIncludesStructuredPageSnapshot() {
  const context = buildBrowserContext({
    address: "https://example.com/docs",
    page: {
      url: "https://example.com/docs",
      title: "Example docs",
      text: "Install Ripple and open the browser.",
      headings: [
        { level: 1, text: "Example docs" },
        { level: 2, text: "Install" },
      ],
      links: [
        { text: "API reference", href: "https://example.com/api" },
        { text: "", href: "https://example.com/empty" },
      ],
      images: [{ alt: "Product screenshot", src: "https://example.com/screen.png" }],
      form_fields: [
        {
          label: "Search docs",
          name: "q",
          type: "search",
          placeholder: "Search",
        },
      ],
      truncated: false,
      captured_at: "2026-07-08T00:00:00Z",
    },
  });

  assert.deepEqual(context.page?.headings, [
    { level: 1, text: "Example docs" },
    { level: 2, text: "Install" },
  ]);
  assert.deepEqual(context.page?.links, [{ text: "API reference", href: "https://example.com/api" }]);
  assert.deepEqual(context.page?.images, [
    { alt: "Product screenshot", src: "https://example.com/screen.png" },
  ]);
  assert.deepEqual(context.page?.form_fields, [
    {
      label: "Search docs",
      name: "q",
      type: "search",
      placeholder: "Search",
    },
  ]);
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
testBuildBrowserContextIncludesStructuredPageSnapshot();
testBuildBrowserContextFallsBackToAddressOnly();

console.log("browser context tests passed");
