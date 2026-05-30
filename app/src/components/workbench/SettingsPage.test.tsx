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
  assert.match(html, />Sign out/);
  assert.match(html, />Change password/);
  assert.match(html, />Invite account/);
  assert.match(html, />DE</);
  assert.match(html, />Upload avatar/);
  assert.doesNotMatch(html, />Default avatars/);
  assert.doesNotMatch(html, /Switch workspace/);
}

function testSettingsPageShowsDeveloperModeForServiceAccess() {
  const html = renderServiceSettingsPage();

  assert.match(html, />Developer mode/);
  assert.match(html, />API key access/);
  assert.match(html, />Change access/);
  assert.match(html, />LA</);
  assert.match(html, />Upload avatar/);
  assert.doesNotMatch(html, />Default avatars/);
  assert.doesNotMatch(html, />Change password/);
}

function testSettingsPageSupportsLocalAvatarUpload() {
  const source = readFileSync(new URL("./SettingsPage.tsx", import.meta.url), "utf8");

  assert.match(source, /deriveAvatarInitials/);
  assert.match(source, /avatarFileInputRef/);
  assert.match(source, /accept="image\/\*"/);
  assert.match(source, /uploadUserAvatar/);
  assert.match(source, /deleteUserAvatar/);
  assert.match(source, /fetchUserAvatarImage/);
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
  assert.match(html, />Input and output are shown separately for each window/);
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

  assert.match(source, /pb-\[calc\(68px\+env\(safe-area-inset-bottom\)\)\]/);
  assert.match(source, /className="mx-auto max-w-5xl space-y-2"/);
  assert.match(source, /RippleIcon\s*\n\s*size=\{24\}/);
  assert.match(source, /className="flex h-8 items-center gap-1\.5 border-b/);
  assert.match(source, /inline-flex h-7 items-center gap-1\.5 rounded-full/);
  assert.match(source, /className="grid gap-2 p-2\.5 md:grid-cols-2"/);
}

testSettingsPageHasExpectedUserSections();
testSettingsPageShowsDeveloperModeForServiceAccess();
testSettingsPageSupportsLocalAvatarUpload();
testSettingsPageDoesNotDuplicatePrimaryWorkspaceTabs();
testSettingsPageHidesDiagnosticsByDefault();
testSettingsPageReservesMobileTopSafeArea();
testSettingsPageUsesInlineModelMenuAndTokenBreakdown();
testSettingsPageDoesNotFetchConnectorData();
testSettingsPageUsesSoftTilesForEntitySections();
testDefaultModelControlUsesDefaultModelNotCurrentSessionModel();
testSettingsPageUsesCompactMobileDensity();

console.log("settings page tests passed");
