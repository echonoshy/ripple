import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import SettingsPage from "./SettingsPage";

function noop() {}

function renderSettingsPage() {
  return renderToStaticMarkup(
    <SettingsPage
      userId="default"
      apiKey="rip_1234567890"
      authMode="user"
      models={[
        { id: "codex-medium", owned_by: "ripple" },
        { id: "codex-high", owned_by: "ripple" },
      ]}
      defaultModel="codex-medium"
      selectedModel="codex-medium"
      onApiKeyChange={noop}
      onSelectDefaultModel={noop}
    />
  );
}

function renderServiceSettingsPage() {
  return renderToStaticMarkup(
    <SettingsPage
      userId="lake"
      apiKey="rip_1234567890"
      authMode="service"
      models={[{ id: "codex-medium", owned_by: "ripple" }]}
      defaultModel="codex-medium"
      selectedModel="codex-medium"
      onApiKeyChange={noop}
      onSelectDefaultModel={noop}
    />
  );
}

function renderSettingsPageWithDifferentCurrentAndDefaultModel() {
  return renderToStaticMarkup(
    <SettingsPage
      userId="default"
      apiKey="rip_1234567890"
      authMode="user"
      models={[
        { id: "codex-medium", owned_by: "ripple" },
        { id: "codex-high", owned_by: "ripple" },
      ]}
      defaultModel="codex-high"
      selectedModel="codex-medium"
      onApiKeyChange={noop}
      onSelectDefaultModel={noop}
    />
  );
}

function testSettingsPageHasExpectedUserSections() {
  const html = renderSettingsPage();

  assert.match(html, />Ripple/);
  assert.match(html, />Settings/);
  assert.match(html, />Account/);
  assert.doesNotMatch(html, />Connected Accounts/);
  assert.match(html, />Usage &amp; Limits/);
  assert.match(html, />Defaults/);
  assert.match(html, />About &amp; Diagnostics/);
  assert.match(html, />Default model/);
  assert.match(html, />Log out/);
  assert.match(html, />Change password/);
  assert.match(html, /aria-label="Display name"/);
  assert.match(html, />Edit/);
  assert.doesNotMatch(html, />Invite account/);
  assert.match(html, />DE</);
  assert.match(html, />Avatar/);
  assert.doesNotMatch(html, />Upload avatar/);
  assert.doesNotMatch(html, />Remove avatar/);
  assert.doesNotMatch(html, />Default avatars/);
  assert.doesNotMatch(html, /Switch workspace/);
}

function testSettingsPageShowsDeveloperModeForServiceAccess() {
  const html = renderServiceSettingsPage();

  assert.match(html, />Developer mode/);
  assert.match(html, />API key access/);
  assert.match(html, />Log out/);
  assert.doesNotMatch(html, />Change access/);
  assert.match(html, />LA</);
  assert.match(html, />Avatar/);
  assert.doesNotMatch(html, />Upload avatar/);
  assert.doesNotMatch(html, />Remove avatar/);
  assert.doesNotMatch(html, />Default avatars/);
  assert.doesNotMatch(html, />Change password/);
}

function testSettingsPageCanEditDisplayName() {
  const source = readFileSync(new URL("./SettingsPage.tsx", import.meta.url), "utf8");

  assert.match(source, /updateUserProfile/);
  assert.match(source, /displayNameInput/);
  assert.match(source, /handleDisplayNameSubmit/);
  assert.match(source, /dispatchUserProfileChanged/);
  assert.match(source, /aria-label="Display name"/);
  assert.match(source, /Save name/);
}

function testSettingsPageSupportsLocalAvatarUpload() {
  const source = readFileSync(new URL("./SettingsPage.tsx", import.meta.url), "utf8");

  assert.match(source, /deriveAvatarInitials/);
  assert.match(source, /avatarFileInputRef/);
  assert.match(source, /accept="image\/\*"/);
  assert.match(source, /uploadUserAvatar/);
  assert.match(source, /deleteUserAvatar/);
  assert.match(source, /fetchUserAvatarImage/);
  assert.match(source, /isAvatarMenuOpen/);
  assert.match(source, /aria-label="Avatar actions"/);
  assert.match(source, /avatarMenuPortal/);
  assert.match(source, /avatarMenuPosition/);
  assert.match(source, /createPortal\(\s*<>[\s\S]*role="menu"[\s\S]*document\.body/);
  assert.match(source, /position: "fixed"/);
  assert.match(source, /Remove avatar/);
  assert.doesNotMatch(source, /FileReader/);
  assert.doesNotMatch(source, /readAsDataURL/);
  assert.doesNotMatch(source, /getClientStorage/);
  assert.doesNotMatch(source, /localStorage/);
  assert.doesNotMatch(source, /DEFAULT_AVATARS/);
  assert.doesNotMatch(source, /handleAvatarSelect/);
}

function testSettingsPageDoesNotDuplicatePrimaryWorkspaceTabs() {
  const html = renderSettingsPage();

  assert.doesNotMatch(html, />Files</);
  assert.doesNotMatch(html, />Automations</);
  assert.doesNotMatch(html, />Sessions</);
  assert.doesNotMatch(html, />Tasks</);
}

function testSettingsPageHidesDiagnosticsByDefault() {
  const html = renderSettingsPage();

  assert.doesNotMatch(html, />API endpoint</);
  assert.doesNotMatch(html, /http:\/\/140\.143\.229\.103:8810\/v1/);
  assert.doesNotMatch(html, />User ID</);
  assert.doesNotMatch(html, />Sandbox Status</);
}

function testSettingsPageReservesMobileTopSafeArea() {
  const html = renderSettingsPage();

  assert.match(html, /pt-\[max\(env\(safe-area-inset-top\),12px\)\]/);
}

function testSettingsPageUsesInlineModelMenuAndTokenBreakdown() {
  const source = readFileSync(new URL("./SettingsPage.tsx", import.meta.url), "utf8");
  const html = renderSettingsPage();

  assert.doesNotMatch(source, /<select/);
  assert.match(source, /isModelMenuOpen/);
  assert.match(source, /createPortal/);
  assert.match(source, /getMeasuredViewportMenuPosition/);
  assert.match(source, /getResponsiveMenuBottomInsetPx/);
  assert.match(source, /position: "fixed"/);
  assert.match(source, /className="fixed inset-0 z-40 bg-transparent"/);
  assert.doesNotMatch(source, /absolute top-full/);
  assert.match(source, /total_input_tokens/);
  assert.match(source, /total_output_tokens/);
  assert.match(source, /daily_input_tokens/);
  assert.match(source, /daily_output_tokens/);
  assert.match(source, /weekly_input_tokens/);
  assert.match(source, /weekly_output_tokens/);
  assert.doesNotMatch(source, /label="Connectors"/);
  assert.match(html, />24h input/);
  assert.match(html, />24h output/);
  assert.match(html, />7d input/);
  assert.match(html, />7d output/);
  assert.match(html, />Total input/);
  assert.match(html, />Total output/);
  assert.doesNotMatch(html, />24h total/);
  assert.doesNotMatch(html, />7d total/);
  assert.doesNotMatch(html, />Input and output are shown separately for each window/);
  assert.doesNotMatch(source, /Input and output are shown separately for each window/);
  assert.match(source, /data-ripple-settings-token-grid/);
  assert.match(source, /data-ripple-settings-token-grid[\s\S]*grid-cols-3/);
  assert.match(
    source,
    /label: "24h input"[\s\S]*label: "7d input"[\s\S]*label: "Total input"[\s\S]*label: "24h output"[\s\S]*label: "7d output"[\s\S]*label: "Total output"/
  );
}

function testSettingsPageCombinesRunCountersInOneRow() {
  const source = readFileSync(new URL("./SettingsPage.tsx", import.meta.url), "utf8");
  const html = renderSettingsPage();

  assert.match(source, /function RunActivityMetrics/);
  assert.match(source, /data-ripple-settings-run-metrics/);
  assert.match(source, /md:col-span-2/);
  assert.doesNotMatch(source, /<Metric label="Runs today"/);
  assert.doesNotMatch(source, /<Metric label="Active runs"/);
  assert.match(html, /data-ripple-settings-run-metrics/);
  assert.match(html, />Runs today/);
  assert.match(html, />Running now/);
  assert.doesNotMatch(html, />Active runs/);
}

function testSettingsPageDoesNotFetchConnectorData() {
  const source = readFileSync(new URL("./SettingsPage.tsx", import.meta.url), "utf8");

  assert.doesNotMatch(source, /fetchConnectors/);
  assert.doesNotMatch(source, /fetchConnectorStatuses/);
  assert.doesNotMatch(source, /connectorReadinessSummary/);
  assert.doesNotMatch(source, /onSelectView/);
}

function testSettingsPageUsesSoftTilesForEntitySections() {
  const html = renderSettingsPage();
  const source = readFileSync(new URL("./SettingsPage.tsx", import.meta.url), "utf8");

  assert.match(source, /IconTile/);
  assert.match(html, /data-ripple-icon-tile="true"/);
  assert.match(html, /data-tone="accent"/);
  assert.match(html, /data-tone="neutral"/);
}

function testDefaultModelControlUsesDefaultModelNotCurrentSessionModel() {
  const html = renderSettingsPageWithDifferentCurrentAndDefaultModel();
  const button = html.match(/<button[^>]*aria-label="Default model"[\s\S]*?<\/button>/)?.[0] || "";

  assert.match(button, />Pro</);
  assert.doesNotMatch(button, />Plus</);
}

function testSettingsPageUsesCompactMobileDensity() {
  const source = readFileSync(new URL("./SettingsPage.tsx", import.meta.url), "utf8");

  assert.match(source, /COMPACT_IOS_PAGE_BACKGROUND/);
  assert.match(source, /pb-\[calc\(88px\+env\(safe-area-inset-bottom\)\)\]/);
  assert.doesNotMatch(source, /20,184,166/);
  assert.match(source, /className="mx-auto max-w-5xl space-y-2"/);
  assert.match(source, /RippleIcon\s*\n\s*size=\{24\}/);
  assert.match(source, /className="flex h-8 items-center gap-1\.5 border-b/);
  assert.match(source, /data-ripple-settings-account-actions/);
  assert.match(source, /data-ripple-settings-account-actions[\s\S]*grid[\s\S]*grid-cols-2/);
  assert.match(source, /data-ripple-settings-account-actions[\s\S]*sm:flex[\s\S]*sm:flex-wrap/);
  assert.match(source, /const settingsAccountActionButtonClass =[\s\S]*w-full min-w-0/);
  assert.match(
    source,
    /const settingsAccountActionButtonClass =[\s\S]*text-\[10px\] sm:text-\[11px\]/
  );
  assert.match(source, /className="grid gap-2 p-2\.5 md:grid-cols-2"/);
  assert.match(source, /data-ripple-settings-token-grid/);
  assert.match(source, /data-ripple-settings-token-grid[\s\S]*grid-cols-3/);
  assert.match(source, /const baseClassName = compact[\s\S]*\? "px-1\.5 py-1"/);
  assert.match(source, /compact[\s\S]*\? "text-\[10px\] font-medium/);
  assert.match(source, /compact[\s\S]*\? "mt-0\.5 text-\[13px\] font-semibold/);
  assert.match(source, /className="border-t border-\[#e8edf7\] p-2"/);
  assert.match(source, /mb-1 flex items-center gap-1\.5 text-\[11px\]/);
  assert.doesNotMatch(source, /Used for new prompts and scheduled runs/);
}

testSettingsPageHasExpectedUserSections();
testSettingsPageShowsDeveloperModeForServiceAccess();
testSettingsPageCanEditDisplayName();
testSettingsPageSupportsLocalAvatarUpload();
testSettingsPageDoesNotDuplicatePrimaryWorkspaceTabs();
testSettingsPageHidesDiagnosticsByDefault();
testSettingsPageReservesMobileTopSafeArea();
testSettingsPageUsesInlineModelMenuAndTokenBreakdown();
testSettingsPageCombinesRunCountersInOneRow();
testSettingsPageDoesNotFetchConnectorData();
testSettingsPageUsesSoftTilesForEntitySections();
testDefaultModelControlUsesDefaultModelNotCurrentSessionModel();
testSettingsPageUsesCompactMobileDensity();

console.log("settings page tests passed");
