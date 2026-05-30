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
      selectedModel="codex-medium"
      onApiKeyChange={noop}
      onSelectModel={noop}
      onSelectView={noop}
    />
  );
}

function testSettingsPageHasExpectedUserSections() {
  const html = renderSettingsPage();

  assert.match(html, />Ripple/);
  assert.match(html, />Settings/);
  assert.match(html, />Account/);
  assert.match(html, />Connected Accounts/);
  assert.match(html, />Usage &amp; Limits/);
  assert.match(html, />Defaults/);
  assert.match(html, />About &amp; Diagnostics/);
  assert.match(html, />Default model/);
  assert.match(html, />Sign out/);
  assert.match(html, />Change password/);
  assert.doesNotMatch(html, /Switch workspace/);
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

  assert.match(html, /pt-\[max\(env\(safe-area-inset-top\),16px\)\]/);
}

function testSettingsPageUsesInlineModelMenuAndTokenBreakdown() {
  const source = readFileSync(new URL("./SettingsPage.tsx", import.meta.url), "utf8");

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
  assert.doesNotMatch(source, /label="Connectors"/);
}

testSettingsPageHasExpectedUserSections();
testSettingsPageDoesNotDuplicatePrimaryWorkspaceTabs();
testSettingsPageHidesDiagnosticsByDefault();
testSettingsPageReservesMobileTopSafeArea();
testSettingsPageUsesInlineModelMenuAndTokenBreakdown();

console.log("settings page tests passed");
