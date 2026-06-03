import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider, type LocalePreference } from "@/i18n";
import SkillsPage from "./SkillsPage";

const noop = () => {};

function renderSkillsPage(locale: LocalePreference = "en-US") {
  return renderToStaticMarkup(
    <I18nProvider initialPreference={locale}>
      <SkillsPage userId="default" onOpenConnectors={noop} />
    </I18nProvider>
  );
}

function testSkillsPageRendersUserFacingChrome() {
  const html = renderSkillsPage();

  assert.match(html, /sm:hidden[^>]*>Skills</);
  assert.match(html, /hidden sm:inline[^>]*>Skills</);
  assert.match(html, /No skills yet/);
  assert.match(html, /aria-label="Refresh"/);
  assert.match(html, /data-ripple-skills-page="true"/);
}

testSkillsPageRendersUserFacingChrome();

function testSkillsPageUsesSkillApisAndHidesInternalRuntimeDetails() {
  const source = readFileSync(new URL("./SkillsPage.tsx", import.meta.url), "utf8");

  assert.match(source, /fetchSkills/);
  assert.match(source, /createSkill/);
  assert.match(source, /updateSkill/);
  assert.match(source, /validateSkill/);
  assert.match(source, /deleteSkill/);
  assert.match(source, /data-ripple-skill-card="true"/);
  assert.match(source, /data-ripple-skill-create-form="true"/);
  assert.doesNotMatch(source, /runtime_capability/);
  assert.doesNotMatch(source, /Runtime Capabilities/);
  assert.doesNotMatch(source, /frontmatter/i);
  assert.doesNotMatch(source, /requires\.bins/);
  assert.doesNotMatch(source, /prompt injection/i);
}

testSkillsPageUsesSkillApisAndHidesInternalRuntimeDetails();

function testSkillsPageRendersChineseChrome() {
  const html = renderSkillsPage("zh-CN");

  assert.match(html, /sm:hidden[^>]*>能力</);
  assert.match(html, />暂无能力/);
  assert.match(html, /aria-label="刷新"/);
}

testSkillsPageRendersChineseChrome();

console.log("skills page tests passed");
