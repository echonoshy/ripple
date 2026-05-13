import assert from "node:assert/strict";
import test from "node:test";

import { parseInline, parseMarkdown } from "./parseMarkdown";

test("parses common markdown blocks", () => {
  const blocks = parseMarkdown(
    [
      "## Summary",
      "",
      "A short **answer**.",
      "",
      "- [x] Done",
      "- Pending",
      "",
      "> Keep this in mind",
      "",
      "```ts",
      "const value = 1;",
      "```",
    ].join("\n"),
  );

  assert.deepEqual(blocks, [
    { type: "heading", level: 2, text: "Summary" },
    { type: "paragraph", text: "A short **answer**." },
    {
      type: "list",
      ordered: false,
      items: [
        { checked: true, text: "Done" },
        { text: "Pending" },
      ],
    },
    { type: "quote", text: "Keep this in mind" },
    { type: "code", language: "ts", code: "const value = 1;" },
  ]);
});

test("parses markdown tables", () => {
  assert.deepEqual(
    parseMarkdown(["| Name | Status |", "| --- | --- |", "| API | Ready |", "| App | WIP |"].join("\n")),
    [
      {
        type: "table",
        headerRow: true,
        rows: [
          ["Name", "Status"],
          ["API", "Ready"],
          ["App", "WIP"],
        ],
      },
    ],
  );
});

test("parses inline markdown tokens", () => {
  assert.deepEqual(parseInline("Use `code`, **bold**, *italic*, and [docs](https://example.com)."), [
    { type: "text", text: "Use " },
    { type: "code", text: "code" },
    { type: "text", text: ", " },
    { type: "bold", text: "bold" },
    { type: "text", text: ", " },
    { type: "italic", text: "italic" },
    { type: "text", text: ", and " },
    { type: "link", text: "docs", href: "https://example.com" },
    { type: "text", text: "." },
  ]);
});

test("autolinks bare urls without swallowing sentence punctuation", () => {
  assert.deepEqual(parseInline("Open https://example.com/path?q=1, then www.example.org."), [
    { type: "text", text: "Open " },
    { type: "link", text: "https://example.com/path?q=1", href: "https://example.com/path?q=1" },
    { type: "text", text: ", then " },
    { type: "link", text: "www.example.org", href: "www.example.org" },
    { type: "text", text: "." },
  ]);
});

test("parses markdown links with balanced parentheses in the url", () => {
  assert.deepEqual(parseInline("See [docs](https://example.com/path_(draft))."), [
    { type: "text", text: "See " },
    { type: "link", text: "docs", href: "https://example.com/path_(draft)" },
    { type: "text", text: "." },
  ]);
});
