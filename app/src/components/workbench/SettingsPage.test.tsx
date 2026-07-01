import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import SettingsPage from "./SettingsPage";
import { I18nProvider, type LocalePreference } from "@/i18n";

function noop() {}

function renderSettingsPage(locale: LocalePreference = "en-US") {
  return renderToStaticMarkup(
    <I18nProvider initialPreference={locale}>
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
        onAuthExpired={noop}
      />
    </I18nProvider>
  );
}

function renderServiceSettingsPage() {
  return renderToStaticMarkup(
    <I18nProvider initialPreference="en-US">
      <SettingsPage
        userId="lake"
        apiKey="rip_1234567890"
        authMode="service"
        models={[{ id: "codex-medium", owned_by: "ripple" }]}
        defaultModel="codex-medium"
        selectedModel="codex-medium"
        onApiKeyChange={noop}
        onSelectDefaultModel={noop}
        onAuthExpired={noop}
      />
    </I18nProvider>
  );
}

function renderSettingsPageWithDifferentCurrentAndDefaultModel() {
  return renderToStaticMarkup(
    <I18nProvider initialPreference="en-US">
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
        onAuthExpired={noop}
      />
    </I18nProvider>
  );
}

function testSettingsPageHasExpectedUserSections() {
  const html = renderSettingsPage();

  assert.match(html, />Ripple/);
  assert.match(html, />Settings/);
  assert.match(html, />Account/);
  assert.doesNotMatch(html, />Connected Accounts/);
  assert.match(html, />Usage &amp; Limits/);
  assert.match(html, />Memory/);
  assert.match(html, />Defaults/);
  assert.match(html, />Language/);
  assert.match(html, />Choose the App interface language\./);
  assert.match(html, />System/);
  assert.match(html, />Simplified Chinese/);
  assert.match(html, />English/);
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

function testSettingsPageExposesReadOnlyMemoryPanel() {
  const source = readFileSync(new URL("./SettingsPage.tsx", import.meta.url), "utf8");
  const html = renderSettingsPage();

  assert.match(source, /fetchMemoryStatus/);
  assert.match(source, /fetchMemorySummary/);
  assert.doesNotMatch(source, /updateMemorySettings/);
  assert.match(source, /resetMemory/);
  assert.match(source, /sectionKind="memory"/);
  assert.match(source, /data-ripple-settings-memory-section/);
  assert.match(source, /data-ripple-settings-memory-summary/);
  assert.match(source, /data-ripple-settings-memory-reset/);
  assert.doesNotMatch(source, /function MemorySwitch/);
  assert.doesNotMatch(source, /role="switch"/);
  assert.doesNotMatch(source, /type="checkbox"/);
  assert.match(html, />Memory/);
  assert.match(html, />Status/);
  assert.match(html, />Summary/);
  assert.match(html, />Stage outputs/);
  assert.match(html, />Memory summary/);
  assert.match(html, />Clear memory/);
  assert.doesNotMatch(html, /Codex/);
  assert.doesNotMatch(source, /readOnly[\s\S]{0,160}settings\.memory/);
  assert.doesNotMatch(source, /manualMemory/);
  assert.doesNotMatch(source, /addMemory/);
  assert.doesNotMatch(source, /editMemory/);
  assert.doesNotMatch(html, />Add memory</);
  assert.doesNotMatch(html, />Edit memory</);
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
  assert.match(source, /aria-label=\{t\("settings\.displayName"\)\}/);
  assert.match(source, /t\("settings\.saveName"\)/);
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
  assert.match(source, /aria-label=\{t\("settings\.avatarActions"\)\}/);
  assert.match(source, /avatarMenuPortal/);
  assert.match(source, /avatarMenuPosition/);
  assert.match(source, /createPortal\(\s*<>[\s\S]*role="menu"[\s\S]*document\.body/);
  assert.match(source, /position: "fixed"/);
  assert.match(source, /t\("settings\.removeAvatar"\)/);
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

function testSettingsPageUsesMobileSheetsForPickersAndTokenBreakdown() {
  const source = readFileSync(new URL("./SettingsPage.tsx", import.meta.url), "utf8");
  const html = renderSettingsPage();

  assert.doesNotMatch(source, /<select/);
  assert.match(source, /isModelMenuOpen/);
  assert.match(source, /import MobileActionSheet from "\.\/MobileActionSheet"/);
  assert.match(source, /data-ripple-settings-model-sheet/);
  assert.match(source, /data-ripple-settings-avatar-sheet/);
  assert.match(source, /data-ripple-settings-row-action/);
  assert.match(source, /createPortal/);
  assert.match(source, /hidden[\s\S]{0,80}lg:block/);
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
    /t\("settings\.dailyInput"\)[\s\S]*t\("settings\.weeklyInput"\)[\s\S]*t\("settings\.totalInput"\)[\s\S]*t\("settings\.dailyOutput"\)[\s\S]*t\("settings\.weeklyOutput"\)[\s\S]*t\("settings\.totalOutput"\)/
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

function testSettingsPageSessionCountMeterUsesNeutralIcon() {
  const source = readFileSync(new URL("./SettingsPage.tsx", import.meta.url), "utf8");

  assert.match(
    source,
    /icon=\{<Layers size=\{13\} \/>\}\s+iconTone="neutral"\s+title=\{t\("settings\.sessionCount"\)\}/
  );
}

function testSettingsPageDoesNotFetchConnectorData() {
  const source = readFileSync(new URL("./SettingsPage.tsx", import.meta.url), "utf8");

  assert.doesNotMatch(source, /fetchConnectors/);
  assert.doesNotMatch(source, /fetchConnectorStatuses/);
  assert.doesNotMatch(source, /connectorReadinessSummary/);
  assert.doesNotMatch(source, /onSelectView/);
}

function testSettingsPagePropagatesAuthExpiry() {
  const source = readFileSync(new URL("./SettingsPage.tsx", import.meta.url), "utf8");

  assert.match(source, /onAuthExpired\?:/);
  assert.match(source, /caught instanceof AuthError/);
  assert.match(source, /onAuthExpired\?\.\(t\("auth\.sessionExpired"\)\)/);
  assert.doesNotMatch(source, /fetchUserProfile\(\)\.catch\(\(\) => null\)/);
}

function testSettingsPageUsesSoftTilesForEntitySections() {
  const html = renderSettingsPage();
  const source = readFileSync(new URL("./SettingsPage.tsx", import.meta.url), "utf8");

  assert.match(source, /IconTile/);
  assert.match(html, /data-ripple-icon-tile="true"/);
  assert.match(html, /data-tone="neutral"/);
  assert.doesNotMatch(html, /data-tone="success"/);
  assert.match(source, /title=\{t\("settings\.account"\)\}\s+tone="neutral"/);
}

function testSettingsPageUsesAppStoreGroupedHierarchy() {
  const html = renderSettingsPage();
  const source = readFileSync(new URL("./SettingsPage.tsx", import.meta.url), "utf8");

  assert.match(source, /const settingsSectionClass =/);
  assert.match(source, /WORKBENCH_SECTION_CLASS/);
  assert.doesNotMatch(source, /border-\[#DEE0E3\]\/80 bg-white\/82/);
  assert.match(source, /data-ripple-settings-section=\{sectionKind\}/);
  assert.match(source, /data-ripple-settings-account-summary/);
  assert.match(source, /data-ripple-settings-defaults-list/);
  assert.match(source, /const settingsGroupedRowClass =/);
  assert.match(html, /data-ripple-settings-section="account"/);
  assert.match(html, /data-ripple-settings-section="usage"/);
  assert.match(html, /data-ripple-settings-section="memory"/);
  assert.match(html, /data-ripple-settings-section="defaults"/);
  assert.match(html, /data-ripple-settings-section="diagnostics"/);
}

function testDefaultModelControlUsesDefaultModelNotCurrentSessionModel() {
  const html = renderSettingsPageWithDifferentCurrentAndDefaultModel();
  const button = html.match(/<button[^>]*aria-label="Default model"[\s\S]*?<\/button>/)?.[0] || "";

  assert.match(button, />Pro</);
  assert.doesNotMatch(button, />Plus</);
}

function testSettingsPageUsesCompactMobileDensity() {
  const source = readFileSync(new URL("./SettingsPage.tsx", import.meta.url), "utf8");

  assert.match(source, /WORKBENCH_PAGE_BACKGROUND_CLASS/);
  assert.doesNotMatch(source, /COMPACT_IOS_PAGE_BACKGROUND/);
  assert.match(source, /MOBILE_PAGE_TOP_SAFE_AREA_CLASS/);
  assert.match(source, /MOBILE_PAGE_NAV_BOTTOM_PADDING_CLASS/);
  assert.doesNotMatch(source, /pb-\[calc\(128px\+env\(safe-area-inset-bottom\)\)\]/);
  assert.match(source, /lg:pb-5/);
  assert.doesNotMatch(source, /md:pb-4/);
  assert.doesNotMatch(source, /20,184,166/);
  assert.match(source, /className="mx-auto max-w-5xl space-y-2\.5"/);
  assert.match(source, /RippleIcon\s*\n\s*size=\{28\}/);
  assert.match(source, /flex min-h-10 items-center gap-1\.5 border-b/);
  assert.match(source, /<div className="space-y-1\.5 p-2">/);
  assert.match(source, /data-ripple-settings-account-actions/);
  assert.match(source, /data-ripple-settings-account-actions[\s\S]*grid[\s\S]*grid-cols-2/);
  assert.match(source, /data-ripple-settings-account-actions[\s\S]*sm:flex[\s\S]*sm:flex-wrap/);
  assert.match(source, /const settingsAccountActionButtonClass =[\s\S]*w-full min-w-0/);
  assert.match(source, /const settingsAccountActionButtonClass =[\s\S]*h-9 w-full/);
  assert.match(source, /const settingsAccountActionButtonClass =[\s\S]*justify-center/);
  assert.match(source, /const settingsAccountActionButtonClass =[\s\S]*gap-1\.5/);
  assert.match(source, /const settingsAccountActionButtonClass =[\s\S]*rounded-lg/);
  assert.match(source, /const settingsAccountActionButtonClass =[\s\S]*px-2/);
  assert.match(source, /const settingsAccountActionButtonClass =[\s\S]*lg:h-8/);
  assert.match(
    source,
    /const settingsAccountActionButtonClass =[\s\S]*TYPOGRAPHY_MICRO_MEDIUM_CLASS/
  );
  assert.match(source, /className="grid gap-1\.5 p-2\.5 md:grid-cols-2"/);
  assert.match(source, /data-ripple-settings-token-grid/);
  assert.match(source, /data-ripple-settings-token-grid[\s\S]*grid-cols-3/);
  assert.match(source, /const baseClassName = compact[\s\S]*\? "px-1\.5 py-1"/);
  assert.match(source, /compact[\s\S]*\? `text-\[#8F959E\] \$\{TYPOGRAPHY_META_MEDIUM_CLASS\}`/);
  assert.match(
    source,
    /compact[\s\S]*\? `mt-0\.5 text-\[#1F2329\] \$\{TYPOGRAPHY_BODY_MEDIUM_CLASS\}`/
  );
  assert.match(source, /className="border-t border-\[#EFF0F1\] p-2"/);
  assert.match(source, /mb-1 flex items-center gap-1\.5 text-\[#2B2F36\]/);
  assert.match(source, /data-ripple-settings-language-row/);
  assert.match(source, /data-ripple-settings-language-row[\s\S]*flex-col/);
  assert.match(source, /data-ripple-settings-language-row[\s\S]*sm:flex-row/);
  assert.match(source, /data-ripple-settings-language-control/);
  assert.match(source, /data-ripple-settings-language-control[\s\S]*grid w-full grid-cols-3/);
  assert.match(source, /data-ripple-settings-language-control[\s\S]*sm:w-auto/);
  assert.match(source, /h-9 min-w-0/);
  assert.match(source, /h-9 min-w-0[\s\S]*sm:min-w-\[76px\]/);
  assert.doesNotMatch(source, /Used for new prompts and scheduled runs/);
}

function testSettingsDiagnosticsExpansionScrollsAboveMobileTabBar() {
  const source = readFileSync(new URL("./SettingsPage.tsx", import.meta.url), "utf8");

  assert.match(source, /diagnosticsSectionRef/);
  assert.match(source, /diagnosticsSectionRef\.current\?\.scrollIntoView/);
  assert.match(source, /block: "end"/);
  assert.match(
    source,
    /ref=\{diagnosticsSectionRef\}[\s\S]*data-ripple-settings-diagnostics-section/
  );
  assert.match(
    source,
    /data-ripple-settings-diagnostics-section[\s\S]*scroll-mb-\[calc\(84px\+env\(safe-area-inset-bottom\)\)\]/
  );
}

function testSettingsPageUsesSolidWorkbenchSurfaces() {
  const source = readFileSync(new URL("./SettingsPage.tsx", import.meta.url), "utf8");

  assert.match(
    source,
    /WORKBENCH_(SECTION|SURFACE|PRIMARY_BUTTON|SECONDARY_BUTTON|STATUS|FIELD|MENU)/
  );
  assert.doesNotMatch(source, /bg-white\/7[02468].*backdrop-blur-xl/);
  assert.doesNotMatch(source, /shadow-\[0_18px_44px/);
  assert.doesNotMatch(source, /backdrop-blur-xl/);
}

function testSettingsPageRendersChineseChrome() {
  const html = renderSettingsPage("zh-CN");

  assert.match(html, />设置</);
  assert.match(html, />账号</);
  assert.match(html, />用量与限制</);
  assert.match(html, />记忆</);
  assert.match(html, />默认设置</);
  assert.match(html, />语言</);
  assert.match(html, />退出登录</);
}

testSettingsPageHasExpectedUserSections();
testSettingsPageExposesReadOnlyMemoryPanel();
testSettingsPageShowsDeveloperModeForServiceAccess();
testSettingsPageCanEditDisplayName();
testSettingsPageSupportsLocalAvatarUpload();
testSettingsPageDoesNotDuplicatePrimaryWorkspaceTabs();
testSettingsPageHidesDiagnosticsByDefault();
testSettingsPageReservesMobileTopSafeArea();
testSettingsPageUsesMobileSheetsForPickersAndTokenBreakdown();
testSettingsPageCombinesRunCountersInOneRow();
testSettingsPageSessionCountMeterUsesNeutralIcon();
testSettingsPageDoesNotFetchConnectorData();
testSettingsPagePropagatesAuthExpiry();
testSettingsPageUsesSoftTilesForEntitySections();
testSettingsPageUsesAppStoreGroupedHierarchy();
testDefaultModelControlUsesDefaultModelNotCurrentSessionModel();
testSettingsPageUsesCompactMobileDensity();
testSettingsDiagnosticsExpansionScrollsAboveMobileTabBar();
testSettingsPageUsesSolidWorkbenchSurfaces();
testSettingsPageRendersChineseChrome();

console.log("settings page tests passed");
