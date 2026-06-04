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
      <SkillsPage userId="default" onOpenChat={noop} />
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
  assert.match(source, /updateSkill/);
  assert.match(source, /validateSkill/);
  assert.match(source, /deleteSkill/);
  assert.match(source, /onOpenChat/);
  assert.match(source, /data-ripple-skill-card="true"/);
  assert.doesNotMatch(source, /data-ripple-skill-create-form="true"/);
  assert.doesNotMatch(source, /runtime_capability/);
  assert.doesNotMatch(source, /Runtime Capabilities/);
  assert.doesNotMatch(source, /frontmatter/i);
  assert.doesNotMatch(source, /requires\.bins/);
  assert.doesNotMatch(source, /prompt injection/i);
}

testSkillsPageUsesSkillApisAndHidesInternalRuntimeDetails();

function testSkillsPageRefreshTimestampDoesNotRetriggerInitialLoad() {
  const source = readFileSync(new URL("./SkillsPage.tsx", import.meta.url), "utf8");

  assert.match(source, /lastRefreshAtRef/);
  assert.doesNotMatch(source, /const \[lastRefreshAt/);
  assert.doesNotMatch(source, /\[lastRefreshAt,\s*t\]/);
}

testSkillsPageRefreshTimestampDoesNotRetriggerInitialLoad();

function testSkillsPageCachesSnapshotsAcrossTabMounts() {
  const source = readFileSync(new URL("./SkillsPage.tsx", import.meta.url), "utf8");

  assert.match(source, /skillSnapshotCache/);
  assert.match(source, /skillSnapshotInflight/);
  assert.match(source, /cachedSkillSnapshot\(userId\)/);
  assert.match(source, /hasSkillSnapshot\(userId\)/);
  assert.match(source, /background: hasSkillSnapshot\(userId\)/);
  assert.doesNotMatch(source, /void loadSkills\(true\);/);
}

testSkillsPageCachesSnapshotsAcrossTabMounts();

function testSkillsPageGroupsBySourceAndConnector() {
  const source = readFileSync(new URL("./SkillsPage.tsx", import.meta.url), "utf8");

  assert.match(source, /buildSkillSections/);
  assert.match(source, /display_source/);
  assert.match(source, /data-ripple-skill-source-section="true"/);
  assert.match(source, /data-ripple-skill-connector-group="true"/);
  assert.match(source, /data-ripple-skill-group-connect="true"/);
  assert.match(source, /line-clamp-2/);
  assert.match(source, /group-open\/skill:hidden/);
  assert.doesNotMatch(
    source,
    /data-ripple-skill-card="true"[\s\S]*skills\.connectService[\s\S]*<\/article>/
  );
}

testSkillsPageGroupsBySourceAndConnector();

function testSkillsPageRoutesManagementThroughSessions() {
  const source = readFileSync(new URL("./SkillsPage.tsx", import.meta.url), "utf8");

  assert.match(source, /onOpenSessionAction/);
  assert.match(source, /connectorNameForGroup/);
  assert.match(source, /type: "connector\.auth\.start"/);
  assert.match(source, /source: "skills_page"/);
  assert.match(source, /autoSend: true/);
  assert.doesNotMatch(source, /startConnectorAuth/);
}

testSkillsPageRoutesManagementThroughSessions();

function testSkillsPageCreateSkillStartsFreshSession() {
  const source = readFileSync(new URL("./SkillsPage.tsx", import.meta.url), "utf8");

  assert.match(source, /newSession: true/);
  assert.match(
    source,
    /onOpenChat\?\.\(t\("skills\.createChatPrompt"\), \{ autoSend: true, newSession: true \}\)/
  );
}

testSkillsPageCreateSkillStartsFreshSession();

function testSkillsPageUsesValidationLanguageInsteadOfTestLanguage() {
  const source = readFileSync(new URL("./SkillsPage.tsx", import.meta.url), "utf8");
  const i18n = readFileSync(new URL("../../i18n/index.tsx", import.meta.url), "utf8");

  assert.match(source, /skills\.validate/);
  assert.doesNotMatch(source, /skills\.test/);
  assert.match(i18n, /validate: "检查"/);
  assert.match(i18n, /validated: "检查完成"/);
  assert.match(i18n, /validate: "Validate"/);
  assert.match(i18n, /validated: "Validation complete"/);
  assert.doesNotMatch(i18n, /test: "Test"/);
  assert.doesNotMatch(i18n, /tested: "Test completed"/);
}

testSkillsPageUsesValidationLanguageInsteadOfTestLanguage();

function testSkillsPageUsesFeishuInspiredVisualLanguage() {
  const source = readFileSync(new URL("./SkillsPage.tsx", import.meta.url), "utf8");

  assert.match(source, /#1456F0/);
  assert.match(source, /#1F2329/);
  assert.match(source, /#646A73/);
  assert.match(source, /#8F959E/);
  assert.match(source, /#DEE0E3/);
  assert.match(source, /TYPOGRAPHY_BODY_MEDIUM_CLASS/);
}

testSkillsPageUsesFeishuInspiredVisualLanguage();

function testSkillsPageRendersChineseChrome() {
  const html = renderSkillsPage("zh-CN");

  assert.match(html, /sm:hidden[^>]*>能力</);
  assert.match(html, />暂无能力/);
  assert.match(html, /aria-label="刷新"/);
}

testSkillsPageRendersChineseChrome();

console.log("skills page tests passed");
