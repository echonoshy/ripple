import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { SkillDescriptionMarkdown } from "./SkillDescriptionMarkdown";

function testSkillDescriptionRendersInlineMarkdown() {
  const html = renderToStaticMarkup(
    <SkillDescriptionMarkdown content="用 gog 读 **先读 gog-shared**，再调用 `gog`。" />
  );

  assert.match(html, /line-clamp-2/);
  assert.match(html, /<strong/);
  assert.match(html, />先读 gog-shared</);
  assert.match(html, /<code/);
  assert.doesNotMatch(html, /\*\*先读 gog-shared\*\*/);
}

testSkillDescriptionRendersInlineMarkdown();

function testSkillDescriptionKeepsSummaryMarkupInline() {
  const html = renderToStaticMarkup(
    <SkillDescriptionMarkdown content={"# Hidden title\n\n- use **shared** first"} />
  );

  assert.doesNotMatch(html, /<h1/);
  assert.doesNotMatch(html, /<ul/);
  assert.doesNotMatch(html, /<li/);
  assert.match(html, /<strong/);
}

testSkillDescriptionKeepsSummaryMarkupInline();

function testSkillDescriptionCanActAsExpandableSummary() {
  const html = renderToStaticMarkup(
    <SkillDescriptionMarkdown
      content="Use **shared** before destructive operations."
      expanded={false}
      onToggle={() => {}}
    />
  );

  assert.match(html, /role="button"/);
  assert.match(html, /aria-expanded="false"/);
  assert.match(html, /cursor-pointer/);
}

testSkillDescriptionCanActAsExpandableSummary();

console.log("skill description markdown tests passed");
